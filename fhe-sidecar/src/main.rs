/*!
 * fhe-sidecar — local HTTP server exposing tfhe-rs homomorphic operations.
 *
 * On-chain ciphertext format: bincode-serialized CompactCiphertextList (1 u64 element).
 * This is small (~16 KB), matches the tfhe WASM CompactFheUint64 format, and keeps
 * the existing chunked write infrastructure working unchanged.
 *
 * FHE arithmetic (fhe-add, fhe-sub):
 *   1. Deserialize CompactCiphertextList → expand() → FheUint64 (in memory only)
 *   2. Apply ServerKey to evaluate a ± b on ciphertexts — no plaintext leaks
 *   3. Decrypt the RESULT only, re-encrypt as a new CompactCiphertextList
 *   Individual input values are never decrypted during arithmetic.
 *
 * Endpoints:
 *   GET  /health
 *   GET  /public-key          → raw bytes (bincode CompactPublicKey)
 *   GET  /ciphertext-size     → {"bytes":<n>}  (size of one CompactCiphertextList)
 *   POST /encrypt             body: {"value":"<u64>"}  → raw bytes
 *   POST /decrypt             body: raw bytes           → {"value":"<u64>"}
 *   POST /fhe-add             body: {"a":"<b64>","b":"<b64>"}  → raw bytes
 *   POST /fhe-sub             body: {"a":"<b64>","b":"<b64>"}  → raw bytes
 */

use std::cell::Cell;
use std::fs;
use std::path::Path;
use std::sync::{Arc, OnceLock};

use actix_web::{web, App, HttpResponse, HttpServer};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::Deserialize;
use tfhe::prelude::*;
use tfhe::{
    generate_keys, set_server_key, ClientKey, CompactCiphertextList, CompactPublicKey,
    ConfigBuilder, FheUint64, ServerKey,
};

const KEYS_DIR: &str = ".fhe-keys";
const CLIENT_KEY_PATH: &str = ".fhe-keys/client_key.bin";
const SERVER_KEY_PATH: &str = ".fhe-keys/server_key.bin";

// ── Global server key (set once; each blocking thread initializes its own copy) ──

static SERVER_KEY: OnceLock<ServerKey> = OnceLock::new();

thread_local! {
    static SK_INITIALIZED: Cell<bool> = const { Cell::new(false) };
}

fn ensure_server_key() {
    SK_INITIALIZED.with(|init| {
        if !init.get() {
            let sk = SERVER_KEY.get().expect("SERVER_KEY not initialized");
            set_server_key(sk.clone());
            init.set(true);
        }
    });
}

// ── Shared app state ──────────────────────────────────────────────────────────

struct FheState {
    client_key: ClientKey,
    compact_pk: CompactPublicKey,
    compact_public_key_bytes: Vec<u8>,
    sample_ciphertext_size: usize,
}

type State = Arc<FheState>;

// ── Key management ────────────────────────────────────────────────────────────

fn load_or_generate() -> (FheState, ServerKey) {
    if Path::new(CLIENT_KEY_PATH).exists() && Path::new(SERVER_KEY_PATH).exists() {
        eprintln!("[fhe-sidecar] Loading keys from {KEYS_DIR}/…");
        let ck_bytes = fs::read(CLIENT_KEY_PATH).expect("read client_key.bin");
        let sk_bytes = fs::read(SERVER_KEY_PATH).expect("read server_key.bin");
        let client_key: ClientKey = bincode::deserialize(&ck_bytes).expect("deser ClientKey");
        let server_key: ServerKey = bincode::deserialize(&sk_bytes).expect("deser ServerKey");
        eprintln!("[fhe-sidecar] Keys loaded.");
        build_state(client_key, server_key)
    } else {
        eprintln!("[fhe-sidecar] Generating new FHE keys (this may take 30–120 s)…");
        let config = ConfigBuilder::default().build();
        let (client_key, server_key) = generate_keys(config);
        fs::create_dir_all(KEYS_DIR).expect("create .fhe-keys");
        fs::write(CLIENT_KEY_PATH, bincode::serialize(&client_key).unwrap())
            .expect("write client_key.bin");
        fs::write(SERVER_KEY_PATH, bincode::serialize(&server_key).unwrap())
            .expect("write server_key.bin");
        eprintln!("[fhe-sidecar] Keys saved to {KEYS_DIR}/.");
        build_state(client_key, server_key)
    }
}

fn build_state(client_key: ClientKey, server_key: ServerKey) -> (FheState, ServerKey) {
    let compact_pk = CompactPublicKey::new(&client_key);
    let compact_public_key_bytes = bincode::serialize(&compact_pk).expect("serialize CompactPK");

    // Measure compact ciphertext size
    let sample = encrypt_compact(0u64, &compact_pk).expect("sample encrypt");
    let sample_ciphertext_size = sample.len();
    eprintln!("[fhe-sidecar] CompactCiphertextList size: {sample_ciphertext_size} bytes");

    let state = FheState {
        client_key,
        compact_pk,
        compact_public_key_bytes,
        sample_ciphertext_size,
    };
    (state, server_key)
}

// ── Compact FHE helpers ───────────────────────────────────────────────────────

/// Encrypt val as a CompactCiphertextList (1 element) → bincode bytes.
fn encrypt_compact(val: u64, compact_pk: &CompactPublicKey) -> Result<Vec<u8>, String> {
    let list = CompactCiphertextList::builder(compact_pk)
        .push(val)
        .build();
    bincode::serialize(&list).map_err(|e| e.to_string())
}

/// Deserialize a CompactCiphertextList and expand index 0 to FheUint64.
/// `ensure_server_key()` must have been called on this thread beforehand.
fn expand_ct(bytes: &[u8]) -> Result<FheUint64, String> {
    let list: CompactCiphertextList =
        bincode::deserialize(bytes).map_err(|e| format!("deser list: {e}"))?;
    let expander = list.expand().map_err(|e| format!("expand: {e}"))?;
    expander
        .get::<FheUint64>(0)
        .ok_or_else(|| "empty compact list".to_string())?
        .map_err(|e| format!("expand[0]: {e}"))
}

/// Deserialize and decrypt a CompactCiphertextList.
fn decrypt_compact(bytes: &[u8], ck: &ClientKey) -> Result<u64, String> {
    let expanded = expand_ct(bytes)?;
    Ok(expanded.decrypt(ck))
}

fn decode_b64(b64: &str) -> Result<Vec<u8>, String> {
    B64.decode(b64).map_err(|e| format!("base64: {e}"))
}

// ── HTTP handlers ─────────────────────────────────────────────────────────────

async fn health() -> HttpResponse {
    HttpResponse::Ok().json(serde_json::json!({"status": "ok"}))
}

async fn get_public_key(state: web::Data<State>) -> HttpResponse {
    HttpResponse::Ok()
        .content_type("application/octet-stream")
        .body(state.compact_public_key_bytes.clone())
}

async fn get_ciphertext_size(state: web::Data<State>) -> HttpResponse {
    HttpResponse::Ok()
        .json(serde_json::json!({"bytes": state.sample_ciphertext_size}))
}

#[derive(Deserialize)]
struct EncryptReq {
    value: String,
}

async fn encrypt_handler(state: web::Data<State>, body: web::Json<EncryptReq>) -> HttpResponse {
    let val: u64 = match body.value.parse() {
        Ok(v) => v,
        Err(e) => return HttpResponse::BadRequest().body(format!("invalid value: {e}")),
    };
    let st = Arc::clone(&state);
    let result = web::block(move || encrypt_compact(val, &st.compact_pk)).await;
    match result {
        Ok(Ok(bytes)) => HttpResponse::Ok().content_type("application/octet-stream").body(bytes),
        Ok(Err(e)) => HttpResponse::InternalServerError().body(e),
        Err(e) => HttpResponse::InternalServerError().body(e.to_string()),
    }
}

async fn decrypt_handler(state: web::Data<State>, body: web::Bytes) -> HttpResponse {
    let bytes = body.to_vec();
    let st = Arc::clone(&state);
    let result = web::block(move || {
        ensure_server_key(); // expand() may need server key for packed lists
        decrypt_compact(&bytes, &st.client_key)
    })
    .await;
    match result {
        Ok(Ok(val)) => HttpResponse::Ok()
            .json(serde_json::json!({"value": val.to_string()})),
        Ok(Err(e)) => HttpResponse::BadRequest().body(e),
        Err(e) => HttpResponse::InternalServerError().body(e.to_string()),
    }
}

#[derive(Deserialize)]
struct FheOpReq {
    a: String,
    b: String,
}

async fn fhe_add_handler(state: web::Data<State>, body: web::Json<FheOpReq>) -> HttpResponse {
    let (a_b64, b_b64) = (body.a.clone(), body.b.clone());
    let st = Arc::clone(&state);

    let result = web::block(move || -> Result<Vec<u8>, String> {
        // Initialize server key for this blocking thread (at most once per thread)
        ensure_server_key();

        let a_bytes = decode_b64(&a_b64)?;
        let b_bytes = decode_b64(&b_b64)?;

        let a = expand_ct(&a_bytes)?;
        let b = expand_ct(&b_bytes)?;

        // ── GENUINE HOMOMORPHIC ADDITION ──────────────────────────────────────
        // ServerKey evaluates the arithmetic circuit on ciphertext bits.
        // Neither a nor b is decrypted during this operation.
        let sum = a + b;
        // ─────────────────────────────────────────────────────────────────────

        // Decrypt only the result value for compact re-encryption.
        let sum_val: u64 = sum.decrypt(&st.client_key);
        encrypt_compact(sum_val, &st.compact_pk)
    })
    .await;

    match result {
        Ok(Ok(bytes)) => HttpResponse::Ok().content_type("application/octet-stream").body(bytes),
        Ok(Err(e)) => HttpResponse::BadRequest().body(e),
        Err(e) => HttpResponse::InternalServerError().body(e.to_string()),
    }
}

async fn fhe_sub_handler(state: web::Data<State>, body: web::Json<FheOpReq>) -> HttpResponse {
    let (a_b64, b_b64) = (body.a.clone(), body.b.clone());
    let st = Arc::clone(&state);

    let result = web::block(move || -> Result<Vec<u8>, String> {
        ensure_server_key();

        let a_bytes = decode_b64(&a_b64)?;
        let b_bytes = decode_b64(&b_b64)?;

        let a = expand_ct(&a_bytes)?;
        let b = expand_ct(&b_bytes)?;

        // ── GENUINE HOMOMORPHIC SUBTRACTION ──────────────────────────────────
        let diff = a - b;
        // ─────────────────────────────────────────────────────────────────────

        let diff_val: u64 = diff.decrypt(&st.client_key);
        encrypt_compact(diff_val, &st.compact_pk)
    })
    .await;

    match result {
        Ok(Ok(bytes)) => HttpResponse::Ok().content_type("application/octet-stream").body(bytes),
        Ok(Err(e)) => HttpResponse::BadRequest().body(e),
        Err(e) => HttpResponse::InternalServerError().body(e.to_string()),
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    let port: u16 = std::env::var("FHE_SIDECAR_PORT")
        .unwrap_or_else(|_| "3002".to_string())
        .parse()
        .expect("valid port");

    let (state, server_key) = load_or_generate();
    if SERVER_KEY.set(server_key).is_err() {
        panic!("SERVER_KEY already set");
    }

    let ct_size = state.sample_ciphertext_size;
    eprintln!("[fhe-sidecar] Listening on http://127.0.0.1:{port} — ciphertext {ct_size} bytes");

    let state_data = web::Data::new(Arc::new(state));

    HttpServer::new(move || {
        App::new()
            .app_data(state_data.clone())
            .app_data(web::JsonConfig::default().limit(64 * 1024 * 1024))
            .route("/health", web::get().to(health))
            .route("/public-key", web::get().to(get_public_key))
            .route("/ciphertext-size", web::get().to(get_ciphertext_size))
            .route("/encrypt", web::post().to(encrypt_handler))
            .route("/decrypt", web::post().to(decrypt_handler))
            .route("/fhe-add", web::post().to(fhe_add_handler))
            .route("/fhe-sub", web::post().to(fhe_sub_handler))
    })
    .bind(("127.0.0.1", port))?
    .run()
    .await
}
