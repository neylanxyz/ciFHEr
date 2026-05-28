# @cifher/sdk

SDK for integrating **ciFHEr** confidential tokens on Solana into any TypeScript or JavaScript application.

Balances and transfer amounts are stored on-chain as real **Fully Homomorphic Encryption (FHE)** ciphertexts — validators and block explorers see only encrypted bytes. Arithmetic happens directly on ciphertexts: your balance is never decrypted during a transfer.

> **Live on Solana devnet.** → [cifher.vercel.app](https://cifher.vercel.app)

---

## Installation

```bash
npm install @cifher/sdk @coral-xyz/anchor @solana/web3.js
```

> **Note on SDK version:** This SDK uses `@solana/web3.js` v1 (legacy) as a
> peer dependency because `@coral-xyz/anchor` v0.32 requires it. The Solana
> Foundation now recommends `@solana/kit` for new projects, but Anchor has not
> yet migrated. This SDK will follow the Anchor ecosystem as it evolves.

---

## Quick Start

### In a React / browser app (Phantom wallet)

```ts
import { CiFHErClient } from '@cifher/sdk'
import { useWallet } from '@solana/wallet-adapter-react'

function MyComponent() {
  const wallet = useWallet()

  const client = new CiFHErClient({
    workerUrl: 'https://your-worker-url.com',
    wallet,               // Phantom or any wallet adapter
    rpcUrl: 'https://api.devnet.solana.com', // optional
  })

  async function setup() {
    // 1. Initialize confidential account (once per wallet)
    await client.initAccount()

    // 2. Mint 1 cifherSOL (locks 1 SOL in escrow)
    const mintTx = await client.mint()
    console.log('Mint tx:', mintTx)

    // 3. Wait for the worker to encrypt and write the balance on-chain
    await client.waitForCompletion()

    // 4. Read decrypted balance
    const balance = await client.getBalance()
    console.log('Balance:', balance?.toString(), 'cifherSOL')
  }

  async function send(recipientAddress: string) {
    // Transfer 1 token — amount is FHE-encrypted during the operation
    const tx = await client.transfer({
      to: recipientAddress,
      amount: 1n,
    })
    console.log('Transfer tx:', tx)
  }
}
```

### In Node.js (Keypair)

```ts
import { CiFHErClient } from '@cifher/sdk'
import { Keypair, Connection, Transaction } from '@solana/web3.js'
import * as fs from 'fs'

// Load keypair from file
const raw = JSON.parse(fs.readFileSync('./keypair.json', 'utf-8'))
const keypair = Keypair.fromSecretKey(new Uint8Array(raw))

// Wrap Keypair in a WalletAdapter-compatible object
const wallet = {
  publicKey: keypair.publicKey,
  signTransaction: async <T extends Transaction>(tx: T) => {
    tx.partialSign(keypair)
    return tx
  },
  signAllTransactions: async <T extends Transaction>(txs: T[]) => {
    txs.forEach((tx) => tx.partialSign(keypair))
    return txs
  },
  signMessage: async (msg: Uint8Array) => {
    const { sign } = await import('@noble/ed25519')
    return sign(msg, keypair.secretKey.slice(0, 32))
  },
}

const client = new CiFHErClient({
  workerUrl: 'http://localhost:3001',
  wallet,
})

const balance = await client.getBalance()
console.log('Balance:', balance?.toString())
```

---

## API Reference

### `new CiFHErClient(config)`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `workerUrl` | `string` | ✅ | URL of the ciFHEr worker REST API |
| `wallet` | `WalletAdapter` | ✅ | Connected Solana wallet |
| `rpcUrl` | `string` | ❌ | Solana RPC URL (defaults to devnet) |

---

### Account Management

#### `client.initAccount(): Promise<string>`

Initialize a confidential on-chain account. Must be called once per wallet before any token operations. Returns the transaction signature.

```ts
await client.initAccount()
```

#### `client.accountExists(): Promise<boolean>`

Check whether the connected wallet has an initialized confidential account.

```ts
const exists = await client.accountExists()
```

---

### Token Operations

#### `client.mint(): Promise<string>`

Mint 1 cifherSOL by locking exactly 1 SOL in the protocol escrow. Emits an on-chain event — the worker encrypts the balance and writes it to your account asynchronously.

```ts
const txSig = await client.mint()
await client.waitForCompletion()
```

**Fee:** none (only the 1 SOL cost of the token)

#### `client.transfer(params): Promise<string>`

Transfer confidential tokens to a recipient. The transfer amount is FHE-encrypted — no plaintext is exposed during the operation.

```ts
const txSig = await client.transfer({
  to: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAs', // recipient base58
  amount: 1n, // cifherSOL token units
})
```

**Fee:** 0.005 SOL flat

#### `client.burn(): Promise<string>`

Burn all cifherSOL and receive the equivalent SOL back to your wallet. The worker decrypts your balance and sends the SOL from the vault.

```ts
const txSig = await client.burn()
await client.waitForCompletion()
```

**Fee:** free

---

### Swap

#### `client.swapSolForToken(lamports): Promise<string>`

Swap SOL for cifherSOL via the confidential pool.

```ts
// Swap 0.5 SOL
const txSig = await client.swapSolForToken(500_000_000n)
```

**Fee:** 0.3% of SOL amount

#### `client.swapTokenForSol(amount): Promise<string>`

Swap cifherSOL back to SOL.

```ts
const txSig = await client.swapTokenForSol(2n) // swap 2 cifherSOL
```

**Fee:** free

---

### Balance & Status

#### `client.getBalance(): Promise<bigint | null>`

Get the decrypted cifherSOL balance for the connected wallet. Returns `null` if the account has no balance yet.

```ts
const balance = await client.getBalance()
// balance: 3n (meaning 3 cifherSOL)
```

#### `client.getOperationStatus(walletAddress?): Promise<OperationStatus[]>`

Get the status of recent worker operations.

```ts
const ops = await client.getOperationStatus()
// [{ id, type, status: 'processing', timestamp }]
```

#### `client.waitForCompletion(intervalMs?, timeoutMs?): Promise<void>`

Poll until all pending operations are done. Rejects if any operation errors or if timeout is exceeded.

```ts
await client.waitForCompletion(2000, 120_000) // poll every 2s, timeout after 2min
```

---

### Utilities

#### `client.isWorkerOnline(): Promise<boolean>`

Check if the worker is reachable.

```ts
const online = await client.isWorkerOnline()
```

#### `client.auth(): Promise<string>`

Manually authenticate with the worker. Returns a session token (valid 4 hours). Normally you don't need to call this — it's invoked automatically.

---

## Architecture

```
Your App
   │
   ├─── @cifher/sdk ──────────────────────────────────┐
   │        │                                         │
   │        ▼                                         ▼
   │   Anchor Programs (on Solana)          Worker REST API
   │   · confidential-token                · POST /auth
   │   · confidential-swap                 · GET  /balance/:user
   │                                       · POST /transfer-intent
   │                                       · GET  /status/:user
   │                                               │
   │                                               ▼
   │                                     FHE Sidecar (Rust/tfhe-rs)
   │                                     · Real homomorphic arithmetic
   │                                     · 16 KB ciphertexts on-chain
   └──────────────────────────────────────────────────┘
```

---

## Network costs

Every Solana transaction has a base fee of **5,000 lamports** (~$0.001) per
signature. Writing a 16 KB FHE ciphertext requires ~19 chunked transactions
(880 bytes each, well within Solana's 10 KiB per-instruction data limit).

| Operation | Network fees | Protocol fees |
|---|---|---|
| `initAccount()` | 1 tx × 5,000 lamports | none |
| `mint()` | 1 tx + ~19 chunk writes × 5,000 lamports | none (you pay 1 SOL for the token) |
| `transfer()` | 1 tx + ~38 chunk writes × 5,000 lamports | 0.005 SOL |
| `burn()` | 1 tx + worker settles | none |
| `swapSolForToken()` | 1 tx + ~19 chunk writes × 5,000 lamports | 0.3% of swap |
| `swapTokenForSol()` | 1 tx + worker settles | none |

---

## How FHE works in ciFHEr

Standard tokens expose every balance and transfer amount on-chain. ciFHEr keeps them encrypted using **Fully Homomorphic Encryption**:

```
On-chain balance: a028 3f9c 7b14 e2d5 ... (16,748 bytes of ciphertext)

Transfer of amount A from Alice to Bob:
  new_alice = fheSub(alice_ciphertext, encrypt(A))   ← no plaintext exposed
  new_bob   = fheAdd(bob_ciphertext, encrypt(A))     ← no plaintext exposed
```

The arithmetic runs on `tfhe-rs` with a `ServerKey` — neither balance is decrypted during the operation. Only the final result is revealed (only to the authorized worker).

---

## Solana constraints satisfied

The ciFHEr design navigates three hard Solana limits that make on-chain FHE
non-trivial:

| Constraint | Limit | How ciFHEr handles it |
|---|---|---|
| Max transaction size | 1,232 bytes | Ciphertexts written in 880-byte chunks (~19 txs each) |
| Max account data growth / instruction | 10,240 bytes (10 KiB) | 880 bytes per chunk — well within limit |
| BPF heap size | 32,768 bytes (32 KB) | Ciphertext stored as raw bytes at fixed offset, never as `Vec<u8>` |
| PDA canonical bump | Required for security | `findProgramAddressSync` always returns the canonical bump |

---

## Program IDs (Devnet)

| Program | Address |
|---|---|
| `confidential-token` | `86C1FkYaVUjV2wyWmRMrnGhXGNNpnH9aFLAJQKkAtf6u` |
| `confidential-swap` | `A2vktybx3Nahc7THvSckeVioTobVkHNEXM5ZteGkoLDK` |

---

## TypeScript Types

```ts
interface CiFHErConfig {
  workerUrl: string
  rpcUrl?: string
  wallet: WalletAdapter
}

interface WalletAdapter {
  publicKey: PublicKey
  signTransaction<T>(tx: T): Promise<T>
  signAllTransactions<T>(txs: T[]): Promise<T[]>
  signMessage(message: Uint8Array): Promise<Uint8Array>
}

interface TransferParams {
  to: string     // recipient base58 address
  amount: bigint // token units
}

interface OperationStatus {
  id: string
  type: 'mint' | 'transfer' | 'burn' | 'swap_sol_for_token' | 'swap_token_for_sol'
  user: string
  status: 'pending' | 'processing' | 'done' | 'error'
  timestamp: number
  error?: string
}
```

---

## Links

- [Live App](https://cifher.vercel.app) — try it on Solana devnet
- [GitHub](https://github.com/neylanxyz/ciFHEr) — source code and programs
- [tfhe-rs](https://github.com/zama-ai/tfhe-rs) — the FHE library powering the sidecar
