/**
 * FHE client — thin HTTP wrapper around the fhe-sidecar Rust process.
 *
 * The sidecar owns TfheClientKey + TfheServerKey and performs all crypto:
 *   - encrypt(value)  → bincode-serialized FheUint64 (~see /ciphertext-size)
 *   - decrypt(bytes)  → bigint
 *   - fheAdd(a, b)    → GENUINE homomorphic addition via ServerKey
 *   - fheSub(a, b)    → GENUINE homomorphic subtraction via ServerKey
 *
 * For fheAdd / fheSub the individual values of a and b are never decrypted
 * during the operation — only the result is revealed for re-encryption.
 */

const SIDECAR = process.env.FHE_SIDECAR_URL ?? 'http://127.0.0.1:3002';

let _publicKeyCache: Uint8Array | null = null;

// ── Init ──────────────────────────────────────────────────────────────────────

/** Wait for the sidecar to be ready (polls /health for up to 5 minutes). */
export async function initFhe(): Promise<void> {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${SIDECAR}/health`);
      if (res.ok) {
        const { bytes } = await (await fetch(`${SIDECAR}/ciphertext-size`)).json() as { bytes: number };
        console.log(`[fhe] Sidecar ready. Ciphertext size: ${bytes} bytes`);
        return;
      }
    } catch {
      // sidecar not up yet
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('[fhe] FHE sidecar did not start within 5 minutes');
}

// ── Crypto operations ─────────────────────────────────────────────────────────

/** Encrypt a u64 value. Returns a bincode-serialized FheUint64. */
export async function encrypt(value: bigint): Promise<Uint8Array> {
  const res = await fetch(`${SIDECAR}/encrypt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: value.toString() }),
  });
  if (!res.ok) throw new Error(`[fhe] encrypt failed: ${await res.text()}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Decrypt a bincode-serialized FheUint64 ciphertext. */
export async function decrypt(bytes: Uint8Array): Promise<bigint> {
  const res = await fetch(`${SIDECAR}/decrypt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  if (!res.ok) throw new Error(`[fhe] decrypt failed: ${await res.text()}`);
  const { value } = await res.json() as { value: string };
  return BigInt(value);
}

/** Homomorphic addition: a + b (evaluated on ciphertexts — no plaintext exposed). */
export async function fheAdd(a: Uint8Array, b: Uint8Array): Promise<Uint8Array> {
  const res = await fetch(`${SIDECAR}/fhe-add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      a: Buffer.from(a).toString('base64'),
      b: Buffer.from(b).toString('base64'),
    }),
  });
  if (!res.ok) throw new Error(`[fhe] fhe-add failed: ${await res.text()}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Homomorphic subtraction: a - b (evaluated on ciphertexts — no plaintext exposed). */
export async function fheSub(a: Uint8Array, b: Uint8Array): Promise<Uint8Array> {
  const res = await fetch(`${SIDECAR}/fhe-sub`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      a: Buffer.from(a).toString('base64'),
      b: Buffer.from(b).toString('base64'),
    }),
  });
  if (!res.ok) throw new Error(`[fhe] fhe-sub failed: ${await res.text()}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Encrypt zero (used to zero out a balance ciphertext). */
export function encryptZero(): Promise<Uint8Array> {
  return encrypt(0n);
}

/** Return the serialized CompactPublicKey bytes for client-side use. */
export async function getPublicKeyBytes(): Promise<Uint8Array> {
  if (_publicKeyCache) return _publicKeyCache;
  const res = await fetch(`${SIDECAR}/public-key`);
  if (!res.ok) throw new Error(`[fhe] get public-key failed: ${await res.text()}`);
  _publicKeyCache = new Uint8Array(await res.arrayBuffer());
  return _publicKeyCache;
}
