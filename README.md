# ciFHEr — Confidential Token on Solana

A fully-collateralized privacy wrapper for SOL. Balances and transfer amounts are stored on-chain as **real FHE ciphertexts** — validators and observers see only encrypted bytes.

```
1 cifherSOL = 1 SOL locked in escrow
```

Live on **Solana devnet**.

---

## How it works

Standard tokens expose every balance and every transfer amount on-chain. ciFHEr keeps them encrypted using **Fully Homomorphic Encryption** (FHE). The arithmetic happens directly on ciphertexts — when you transfer tokens, your balance is never decrypted during the operation.

```
User wallet   →   swap_sol_for_token(1 SOL)   →   SOL locked in vault
                                               →   Worker writes encrypt(1) to your account

User wallet   →   transfer_request()           →   Worker computes:
                                                     new_sender    = fheSub(senderCt, encAmount)
                                                     new_recipient = fheAdd(recipientCt, encAmount)
                                               →   No plaintext exposed during arithmetic
```

On-chain, every balance looks like this:

```
a028 3f9c 7b14 e2d5 ... (16,748 bytes of ciphertext)
```

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    FRONTEND (React)                 │
│  Connect wallet · Mint · Transfer · Swap · Burn     │
└──────────────┬──────────────────────┬───────────────┘
               │                      │
               ▼                      ▼
┌─────────────────────┐  ┌────────────────────────────┐
│   ANCHOR PROGRAMS   │  │      OFF-CHAIN WORKER       │
│                     │  │         (Node.js)           │
│  confidential-token │◄─┤  spawns fhe-sidecar (Rust) │
│  confidential-swap  │  │  all FHE ops via HTTP       │
│                     │  │  writes ciphertexts on-chain│
└─────────────────────┘  └────────────┬───────────────┘
                                       │
                          ┌────────────▼───────────────┐
                          │      FHE SIDECAR (Rust)     │
                          │   tfhe-rs 0.7 · ServerKey   │
                          │   genuine ciphertext arith  │
                          │   POST /fhe-add · /fhe-sub  │
                          └────────────────────────────┘
```

### Components

| Component | Stack | Role |
|---|---|---|
| `programs/confidential-token` | Anchor / Rust | Mint, transfer, burn instructions; chunked ciphertext storage |
| `programs/confidential-swap` | Anchor / Rust | SOL ↔ cifherSOL swap pool |
| `worker/` | Node.js / TypeScript | Event listener, REST API, on-chain writes |
| `fhe-sidecar/` | Rust (tfhe-rs 0.7) | FHE keygen, encrypt, decrypt, homomorphic add/sub |
| `frontend/` | React / TypeScript | Phantom wallet UI |

---

## FHE Implementation

The sidecar uses **tfhe-rs** with a `ServerKey` for genuine homomorphic evaluation:

```rust
// fhe-sidecar/src/main.rs — fhe_add endpoint
set_server_key(sk.clone());          // enables ciphertext arithmetic on this thread
let a = expand_ct(&a_bytes)?;        // CompactCiphertextList → FheUint64
let b = expand_ct(&b_bytes)?;
let sum = a + b;                     // HOMOMORPHIC — neither a nor b is decrypted
let result: u64 = sum.decrypt(&ck);  // only the result is revealed
encrypt_compact(result, &pk)         // re-compress to ~16 KB for on-chain storage
```

Ciphertext format: `CompactCiphertextList` (bincode) — **~16,748 bytes**, fitting comfortably within Solana's account model via chunked writes (880 bytes/transaction).

---

## Solana constraints & design

Solana limits make storing 16 KB ciphertexts non-trivial:

- **1,232 bytes/tx** — ciphertexts can't fit in a single transaction
- **10 KB max account growth per tx** — realloc must be incremental
- **32 KB BPF heap** — `Vec<u8>` for large data causes OOM

**Solution:** raw bytes at a fixed offset in account data, never as a `Vec<u8>` field, written in 880-byte chunks (~19 transactions per balance update).

```rust
pub struct ConfidentialAccount {
    pub owner: Pubkey,      // 32 bytes
    pub balance_len: u32,   // 4 bytes  — NOT Vec<u8>
    pub bump: u8,           // 1 byte
}
// ciphertext lives at data[45 .. 45 + balance_len]
```

---

## Fees

| Operation | Fee |
|---|---|
| SOL → cifherSOL | 0.3% of swap amount (charged on top) |
| Transfer | 0.005 SOL flat |
| cifherSOL → SOL | Free |

Fees go to the protocol treasury (worker keypair). The worker maintains a minimum 1 SOL floor and refuses to process operations that would drop it below that.

---

## Trust model

| Property | ciFHEr |
|---|---|
| Hidden transfer amounts | ✅ FHE ciphertexts on-chain |
| Hidden balances | ✅ Worker key required to decrypt |
| Hidden swap amounts | ✅ Confidential pool reserve |
| Hidden sender/receiver | ❌ Wallet addresses are public |
| Trustless operator | ❌ Single worker (MVP) |

The worker is a trusted operator — same model as most bridges and oracles. The roadmap replaces it with threshold FHE across a decentralized operator network.

---

## Program IDs (devnet)

| Program | Address |
|---|---|
| `confidential_token` | `86C1FkYaVUjV2wyWmRMrnGhXGNNpnH9aFLAJQKkAtf6u` |
| `confidential_swap` | `A2vktybx3Nahc7THvSckeVioTobVkHNEXM5ZteGkoLDK` |

---

## Running locally

**Prerequisites:** Rust, Anchor CLI, Node.js 20+, Solana CLI, Phantom wallet.

```bash
# 1. Start validator and deploy programs
solana-test-validator --reset &
anchor build && anchor deploy

# 2. Build the FHE sidecar (one-time, ~2 min)
cd fhe-sidecar && cargo build --release && cd ..

# 3. Configure and start the worker (auto-spawns the FHE sidecar)
cd worker
cp .env.example .env   # edit SOLANA_RPC_URL, WORKER_KEYPAIR_PATH, ADMIN_SECRET
npm install && npm run dev

# 4. Start the frontend
cd ../frontend
npm install && npm run dev   # localhost:5173
```

First run generates FHE keys (`fhe-sidecar/.fhe-keys/`) — takes 30–120 seconds. Subsequent starts load from disk in ~1 second.

### Tests

```bash
anchor test   # 10 integration tests — all passing
```

Tests use the tfhe WASM package directly and do not require the fhe-sidecar to be running.

### Worker env vars

```env
SOLANA_RPC_URL=http://127.0.0.1:8899
WORKER_KEYPAIR_PATH=~/.config/solana/id.json
DENOMINATION=1000000000
PORT=3001
ADMIN_SECRET=<your-secret>
```
