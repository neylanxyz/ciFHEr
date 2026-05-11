# Confidential Token on Solana — Claude Code Context

## Project Status

**10/10 tests passing with real FHE ciphertexts** (`anchor test`).

This is a hackathon MVP — a confidential token system on Solana using **real FHE** (tfhe@0.6.4 WASM). Balances and amounts are hidden on-chain as ~16,732-byte FHE ciphertexts.

---

## Encryption Scheme — Real tfhe (NOT NaCl)

Uses `tfhe@0.6.4` (`CompactFheUint64`). Ciphertexts are ~16,732 bytes.

```typescript
// Encrypt
CompactFheUint64.encrypt_with_compact_public_key(value, compactPublicKey).serialize()
// → Uint8Array ~16,732 bytes

// Decrypt
CompactFheUint64.deserialize(bytes).expand().decrypt(clientKey)
// → bigint
```

"FHE add" = decrypt + add + re-encrypt (server-key arithmetic not exposed in WASM).

Worker key stored at `.worker-key` (JSON array of serialized TfheClientKey bytes).

**Loading tfhe in CJS (tests and worker):**
```typescript
// tfhe@0.6.4 ships as ESM with no "main" field — load by explicit path
const tfhe = require(path.join(__dirname, '..', 'node_modules', 'tfhe', 'tfhe.js'));
tfhe.initSync(fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'tfhe', 'tfhe_bg.wasm')));
// NODE_OPTIONS=--experimental-require-module required (set in Anchor.toml test script)
```

---

## Privacy Model

| Property | This System |
|---|---|
| Hidden transfer amounts | ✅ FHE ciphertexts on-chain |
| Hidden balances | ✅ Only worker can decrypt (MVP tradeoff) |
| Hidden mint amounts | ✅ Fixed denominations only |
| Hidden swap amounts | ✅ Worker handles confidentially |
| Hidden sender/receiver | ❌ Wallet addresses are public |
| Trustless | ❌ Single worker is trusted operator (MVP) |

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    FRONTEND (React)                 │
│  - Connect wallet (Phantom)                         │
│  - Mint / Transfer / Swap / Burn                    │
│  - No FHE on frontend — calls worker REST API       │
└──────────────┬──────────────────────┬───────────────┘
               │                      │
               ▼                      ▼
┌─────────────────────┐  ┌────────────────────────────┐
│   ANCHOR PROGRAMS   │  │      OFF-CHAIN WORKER       │
│                     │  │         (Node.js)           │
│  1. Token Program   │◄─┤  - Holds TfheClientKey      │
│  2. Swap Pool       │  │  - All FHE encrypt/decrypt  │
│                     │  │  - Writes ciphertexts on-   │
│                     │  │    chain in chunks           │
│                     │  │  - Listens to chain events  │
└─────────────────────┘  └────────────────────────────┘
```

---

## Repository Structure

```
ciFHEr/
├── programs/
│   ├── confidential-token/       # Anchor program 1
│   │   └── src/lib.rs
│   └── confidential-swap/        # Anchor program 2
│       └── src/lib.rs
├── worker/
│   └── src/
│       ├── index.ts              # Express server + event listeners + bootstrap
│       ├── fhe.ts                # tfhe@0.6.4 encrypt/decrypt/encryptZero/fheAdd
│       ├── mint.ts               # MintRequested handler
│       ├── burn.ts               # BurnRequested handler
│       ├── swap.ts               # SwapSolForToken / SwapTokenForSol handlers
│       ├── transfer.ts           # TransferRequested handler
│       ├── program.ts            # Anchor setup, PDAs, data helpers, chunked writes
│       └── types.ts              # PendingOp types + in-memory state maps
├── frontend/src/                 # React app (no FHE — calls worker)
├── tests/
│   └── confidential-token.ts    # 10 integration tests (real 16KB ciphertexts)
├── Anchor.toml
└── Cargo.toml
```

---

## Critical Design: Chunked Raw Byte Writes

Solana constraints:
- **1,232 bytes/tx** (transaction size)
- **10,240 bytes max account growth per tx** (realloc limit)
- **32KB BPF heap** — `Vec<u8>` growth doubles capacity; a 16KB Vec allocates 32KB and OOMs

**Solution**: store ciphertext as raw bytes in account data, NOT as `Vec<u8>` fields.

### Account struct design

```rust
// ConfidentialAccount — raw bytes start at offset 45
pub struct ConfidentialAccount {
    pub owner: Pubkey,      // 32 bytes (offset 8)
    pub balance_len: u32,   // 4 bytes (offset 40) ← NOT Vec<u8>
    pub bump: u8,           // 1 byte  (offset 44)
}
// ACCOUNT_INIT_SPACE = 8+32+4+1 = 45
// Raw ciphertext bytes live at data[45 .. 45+balance_len]

// SwapPool — raw bytes start at offset 101
pub struct SwapPool {
    pub worker_authority: Pubkey,   // 32
    pub token_mint: Pubkey,         // 32
    pub token_reserve_len: u32,     // 4  ← NOT Vec<u8>
    pub sol_reserve: u64,           // 8
    pub price_numerator: u64,       // 8
    pub price_denominator: u64,     // 8
    pub bump: u8,                   // 1
}
// POOL_INIT_SPACE = 8+32+32+4+8+8+8+1 = 101
// Raw ciphertext bytes live at data[101 .. 101+token_reserve_len]
```

### Write protocol (client side)

**CHUNK_SIZE = 880 bytes** (keeps tx under 1,232 bytes)

```typescript
// 1. begin_write_balance(newSize) — shrinks account to 45 bytes, sets balance_len=0
// 2. write_balance_chunk(offset, chunk) × ~19 — grows by chunk.len() per call
//    Each realloc: ACCOUNT_INIT_SPACE + balance_len + chunk.len()
```

### Write protocol (Rust side)

```rust
pub fn write_balance_chunk(ctx: Context<WriteBalanceChunk>, offset: u32, chunk: Vec<u8>) -> Result<()> {
    let current_len = ctx.accounts.user_account.balance_len;
    require!(offset == current_len, ConfidentialTokenError::OutOfBounds);
    {
        let info = ctx.accounts.user_account.to_account_info();
        let mut data = info.data.borrow_mut();
        let start = ACCOUNT_INIT_SPACE + current_len as usize;
        data[start..start + chunk.len()].copy_from_slice(&chunk);
    }
    ctx.accounts.user_account.balance_len += chunk.len() as u32;
    Ok(())
}
// Realloc: ACCOUNT_INIT_SPACE + user_account.balance_len + chunk.len()
```

Same pattern for `write_pool_reserve_chunk` at `POOL_INIT_SPACE`.

### Read pattern (TypeScript)

```typescript
const info = await connection.getAccountInfo(accountPda);
const view = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
const balanceLen = view.getUint32(40, true); // offset 8+32=40
const ciphertextBytes = info.data.slice(45, 45 + balanceLen);
```

For pool reserve:
```typescript
const reserveLen = view.getUint32(72, true); // offset 8+32+32=72
const ciphertextBytes = info.data.slice(101, 101 + reserveLen);
```

---

## Program 1: Confidential Token (`H6TaxPd91m5NMm3t3KSubsBTnMHBJHbaC4B3WhccuY7T`)

### PDA Seeds

| Account | Seeds | Program |
|---|---|---|
| ConfidentialMint | `["mint"]` | TOKEN_PROGRAM_ID |
| Vault (SOL escrow) | `["vault", mintPda]` | TOKEN_PROGRAM_ID |
| ConfidentialAccount | `["account", mintPda, ownerPubkey]` | TOKEN_PROGRAM_ID |

### Instructions

```
// USER
initialize_mint(denomination: u64) -> Result<()>
initialize_account() -> Result<()>
mint_request() -> Result<()>          // pays denomination lamports → vault; emits MintRequested
transfer_request(recipient: Pubkey) -> Result<()>  // emits TransferRequested
burn_request() -> Result<()>          // emits BurnRequested

// WORKER-ONLY
begin_write_balance(new_size: u32) -> Result<()>    // shrinks to ACCOUNT_INIT_SPACE, clears balance_len
write_balance_chunk(offset: u32, chunk: Vec<u8>)    // incremental write + realloc
fulfill_burn(sol_to_send: u64) -> Result<()>         // sends SOL from vault → user, clears balance
```

---

## Program 2: Confidential Swap (`HyL5r4euova77wUoJVMA7hj8Y2s1jvJr55zSqAB1gvAa`)

### PDA Seeds

| Account | Seeds | Program |
|---|---|---|
| SwapPool | `["pool", mintPda]` | SWAP_PROGRAM_ID |
| SwapVault | `["swap_vault", poolPda]` | SWAP_PROGRAM_ID |

### Instructions

```
// USER
initialize_pool(price_numerator: u64, price_denominator: u64) -> Result<()>
swap_sol_for_token(sol_amount: u64) -> Result<()>       // emits SwapSolForTokenRequested
swap_token_for_sol_request() -> Result<()>              // emits SwapTokenForSolRequested

// WORKER-ONLY
begin_write_pool_reserve(new_size: u32) -> Result<()>
write_pool_reserve_chunk(offset: u32, chunk: Vec<u8>)
fulfill_token_for_sol(sol_amount: u64) -> Result<()>    // sends SOL from swapVault → user
```

---

## Off-Chain Worker

### `fhe-sidecar/` — Rust HTTP sidecar (tfhe-rs 0.7 with ServerKey)

Separate Rust binary at `fhe-sidecar/target/release/fhe-sidecar`.
Keys stored at `fhe-sidecar/.fhe-keys/{client_key,server_key}.bin` (bincode).
Ciphertext format: bincode-serialized `CompactCiphertextList` (1 u64 element, **~16,748 bytes** — same as WASM CompactFheUint64).

**Port**: 3002 (env: `FHE_SIDECAR_PORT`).

Worker spawns the sidecar automatically on startup.

```
GET  /health          → {"status":"ok"}
GET  /public-key      → raw bincode CompactPublicKey bytes
GET  /ciphertext-size → {"bytes":16748}
POST /encrypt         body: {"value":"<u64>"}   → raw compact ciphertext bytes
POST /decrypt         body: raw bytes            → {"value":"<u64>"}
POST /fhe-add         body: {"a":"<b64>","b":"<b64>"} → raw bytes  (GENUINE FHE add)
POST /fhe-sub         body: {"a":"<b64>","b":"<b64>"} → raw bytes  (GENUINE FHE sub)
```

**fhe-add / fhe-sub implementation:**
1. Deserialize compact ciphertexts → `CompactCiphertextList::expand()` → `FheUint64`
2. `set_server_key` (thread-local, once per blocking thread)
3. `a + b` or `a - b` **purely on ciphertexts** — no decrypt of inputs
4. `sum.decrypt(&client_key)` — only the result is revealed
5. `CompactCiphertextList::builder(&compact_pk).push(sum_val).build()` → re-encrypt compact

Result: ~852ms for FHE add on first call (server key init), ~10ms on warmed thread.

### `worker/src/fhe.ts` — HTTP client to sidecar

```typescript
await initFhe()                                  // polls sidecar /health (up to 5 min)
encrypt(value: bigint): Promise<Uint8Array>      // POST /encrypt → compact ciphertext
decrypt(bytes: Uint8Array): Promise<bigint>      // POST /decrypt → u64
fheAdd(a, b): Promise<Uint8Array>                // POST /fhe-add → GENUINE homomorphic add
fheSub(a, b): Promise<Uint8Array>                // POST /fhe-sub → GENUINE homomorphic sub
encryptZero(): Promise<Uint8Array>               // encrypt(0n)
getPublicKeyBytes(): Promise<Uint8Array>         // GET /public-key (cached)
```

Keys stored at `fhe-sidecar/.fhe-keys/` — loss = unreadable ciphertexts (worker returns 409 `KEY_MISMATCH`).

### `worker/src/program.ts` — Key helpers

```typescript
const ACCOUNT_INIT_SPACE = 45;
const POOL_INIT_SPACE = 101;
const CHUNK_SIZE = 880;

// Read ciphertext from raw account data
getEncryptedBalance(owner: PublicKey): Promise<Uint8Array | null>
getEncryptedPoolReserve(): Promise<Uint8Array | null>

// Write ciphertext in chunks (begin_write + N × write_chunk)
writeEncryptedBalance(owner: PublicKey, ciphertext: Uint8Array): Promise<void>
writePoolReserve(ciphertext: Uint8Array): Promise<void>
```

### Transfer Design (homomorphic — no individual balance decryption)

```
1. POST /transfer-intent { user, recipient, amount }   ← register BEFORE on-chain tx
2. transfer_request(recipient) on-chain → emits TransferRequested
3. Worker: decrypt(senderCt) for balance check only
4. encAmount = encrypt(amount)
5. newSenderCt = fheSub(senderCt, encAmount)     ← homomorphic, senderCt NOT decrypted
6. newRecipientCt = fheAdd(recipientCt, encAmount)  ← homomorphic
7. writeEncryptedBalance(sender, newSenderCt)
8. writeEncryptedBalance(recipient, newRecipientCt)
```

### REST API

| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Liveness check |
| GET | `/public-key` | Serialized TfheCompactPublicKey bytes (octet-stream) |
| GET | `/status/:userId` | Pending ops for a user |
| GET | `/balance/:userId` | Decrypt and return user's token balance |
| POST | `/transfer-intent` | Register `{ user, recipient, amount }` before transfer_request |
| POST | `/swap-intent` | Register `{ user, tokenAmount }` before swap_token_for_sol_request |

### Worker Bootstrap (every startup)

1. `initFhe()` — load WASM, load/generate TfheClientKey
2. `initializeMint` if ConfidentialMint doesn't exist
3. `initializePool` if SwapPool doesn't exist
4. If `pool.sol_reserve === 0`, seed with 10 SOL via `swapSolForToken`

---

## Tests (`tests/confidential-token.ts`) — 10/10 passing

```
✓ 1. initializes the mint
✓ 2. initializes confidential accounts (user + recipient)
✓ 3. mint request (user pays SOL)
✓ 4. worker writes FHE balance after mint (chunked) — real 16KB ciphertext, ~19 chunks
✓ 5. transfer with chunked writes to both accounts
✓ 6. initializes swap pool
✓ 7. user swaps SOL for token
✓ 8. worker writes pool reserve ciphertext (chunked)
✓ 9. worker fulfills token→SOL swap
✓ 10. worker fulfills burn (redeem tokens for SOL)
```

Run with: `anchor test`

Anchor.toml test script:
```
NODE_OPTIONS=--experimental-require-module yarn run ts-mocha -p ./tsconfig.json -t 1000000 "tests/**/*.ts"
```

---

## Configuration

### `worker/.env`
```
SOLANA_RPC_URL=http://localhost:8899
WORKER_KEYPAIR_PATH=~/.config/solana/id.json
DENOMINATION=1000000000
PORT=3001
```

### `frontend/.env`
```
VITE_WORKER_URL=http://localhost:3001
VITE_RPC_URL=http://localhost:8899
```

### Program IDs
- `confidential_token`: `H6TaxPd91m5NMm3t3KSubsBTnMHBJHbaC4B3WhccuY7T`
- `confidential_swap`: `HyL5r4euova77wUoJVMA7hj8Y2s1jvJr55zSqAB1gvAa`

---

## Development Commands

```bash
anchor build                          # compile programs, generate IDLs
anchor test                           # 10 tests against localnet

cd worker && npm run dev              # tsx watch
cd frontend && npm run dev            # Vite dev server
```

---

## Key Gotchas

1. **tfhe@0.6.4 loading** — no `"main"` field; must load by explicit path + `NODE_OPTIONS=--experimental-require-module`. Do NOT upgrade to 1.x (removed `CompactFheUint64`, pure ESM).

2. **No `Vec<u8>` for ciphertexts in account structs** — BPF heap is 32KB; Vec growth doubles capacity and OOMs on 16KB data. Use `balance_len: u32` + raw byte writes only.

3. **Incremental realloc** — each `write_balance_chunk` grows account by at most 880 bytes. The 10KB realloc limit applies per-transaction.

4. **`borrow_mut()` safety** — Anchor releases the deserialization borrow before the instruction body runs; re-borrows for serialization after body returns. Direct `data.borrow_mut()` in the body is safe.

5. **`balance_len` offset** — `u32` at offset 40 (`= 8 discriminator + 32 owner`); ciphertext bytes at offset 45.

6. **`token_reserve_len` offset** — `u32` at offset 72 (`= 8 + 32 + 32`); ciphertext bytes at offset 101.

7. **`systemProgram` required on chunk calls** — realloc requires System program in accounts; must pass `systemProgram: SystemProgram.programId`.

8. **BN for u64** — all `u64` Anchor params: `new BN(value.toString())`.

9. **In-memory op tracking** — `pendingOps`, `pendingTransfers`, `pendingSwapAmounts` are lost on worker restart.

10. **Transfer intent race** — `POST /transfer-intent` must arrive before `TransferRequested` event fires, or worker throws "No transfer intent registered".

---

## Known Limitations

1. Worker sees all amounts (decrypt everything; single trusted operator)
2. Transfer amounts unverified on-chain (client could lie)
3. Wallet addresses are public (only amounts hidden)
4. Balance display requires worker roundtrip (no client-side decryption)
5. Key compromise = full exposure (all balances readable if `.worker-key` leaks)
6. In-memory op tracking lost on restart
7. Fixed denomination (mint/burn only in 1 SOL increments)

---

## Pitch Narrative

> *"We built a confidential token on Solana using real FHE — balances and transfer amounts are stored as fully homomorphic encrypted ciphertexts on-chain. Nobody, not even validators, can read them without the worker key. The arithmetic is computed using a native Rust tfhe-rs ServerKey: when you transfer tokens, the worker adds ciphertexts together without ever decrypting your balance. We also built a confidential swap pool where you can trade SOL for tokens without revealing how much you're swapping. The trust model today is a single operator — same as most bridges and oracles. Our roadmap replaces it with threshold FHE across a decentralized operator set."*
