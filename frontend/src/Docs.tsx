import { useEffect, useState } from 'react'
import './Docs.css'

const NAV = [
  { id: 'overview',     label: 'Overview' },
  { id: 'architecture', label: 'Architecture' },
  { id: 'fhe',          label: 'FHE Implementation' },
  { id: 'solana',       label: 'Solana Design' },
  { id: 'trust',        label: 'Trust Model' },
  { id: 'programs',     label: 'Program Reference' },
  { id: 'api',          label: 'API Reference' },
  { id: 'running',      label: 'Running Locally' },
]

function Code({ children }: { children: string }) {
  return <pre className="d-code"><code>{children.trim()}</code></pre>
}

function InlineCode({ children }: { children: string }) {
  return <code className="d-inline-code">{children}</code>
}

function Table({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="d-table-wrap">
      <table className="d-table">
        <thead>
          <tr>{headers.map(h => <th key={h}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Docs() {
  const [active, setActive] = useState('overview')

  useEffect(() => {
    const headings = document.querySelectorAll('.d-section')
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach(e => {
          if (e.isIntersecting) setActive(e.target.id)
        })
      },
      { rootMargin: '-20% 0px -70% 0px' }
    )
    headings.forEach(el => observer.observe(el))
    return () => observer.disconnect()
  }, [])

  return (
    <div className="docs">

      <header className="d-header">
        <a href="/" className="d-back">← ciFHEr</a>
        <span className="d-header-title">
          c<span className="d-logo-i">ı<span className="d-logo-dot">*</span></span>FHEr
          <span className="d-header-sub">/ docs</span>
        </span>
        <a href="/app" className="d-launch">Launch App</a>
      </header>

      <div className="d-layout">

        {/* ── Sidebar ── */}
        <nav className="d-sidebar">
          <p className="d-sidebar-label">Contents</p>
          <ul className="d-nav">
            {NAV.map(item => (
              <li key={item.id}>
                <a
                  href={`#${item.id}`}
                  className={`d-nav-link ${active === item.id ? 'd-nav-link--active' : ''}`}
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {/* ── Content ── */}
        <main className="d-content">

          {/* OVERVIEW */}
          <section id="overview" className="d-section">
            <p className="d-eyebrow">Overview</p>
            <h1 className="d-h1">ciFHEr Protocol</h1>
            <p className="d-lead">
              A confidential token on Solana where every balance is a real FHE ciphertext.
              Arithmetic runs directly on encrypted data — no plaintext is ever exposed
              during computation.
            </p>
            <p className="d-p">
              ciFHEr uses <strong>tfhe-rs 0.7</strong> (Zama) with a <InlineCode>ServerKey</InlineCode> for
              genuine homomorphic evaluation. When you transfer tokens, the worker computes
              new balances by operating on ciphertexts — neither the sender's nor the
              recipient's balance is decrypted during the operation. Only the arithmetic
              result is decrypted, immediately re-encrypted, and written to chain.
            </p>
            <p className="d-p">
              The on-chain ciphertext format is <InlineCode>CompactCiphertextList</InlineCode> (bincode),
              which serializes to <strong>~16,748 bytes</strong> per balance —
              the same format used by Zama's FHEVM on Ethereum.
            </p>
          </section>

          {/* ARCHITECTURE */}
          <section id="architecture" className="d-section">
            <p className="d-eyebrow">Architecture</p>
            <h2 className="d-h2">Components</h2>
            <Code>{`
Frontend (React / TypeScript)
  └─ calls Worker REST API
  └─ submits on-chain instructions via Phantom

Worker (Node.js / TypeScript)  :3001
  └─ listens to Solana events (logs / polling)
  └─ calls fhe-sidecar for all FHE operations
  └─ writes ciphertexts on-chain in chunks
  └─ spawns fhe-sidecar on startup

fhe-sidecar (Rust / tfhe-rs 0.7)  :3002
  └─ holds ClientKey + ServerKey
  └─ genuine homomorphic fhe-add / fhe-sub
  └─ encrypt / decrypt endpoints

Anchor Programs (Solana / Rust)
  └─ confidential-token  — mint, transfer, burn
  └─ confidential-swap   — SOL ↔ cifherSOL pool
            `}</Code>
            <Table
              headers={['Component', 'Stack', 'Role']}
              rows={[
                ['programs/confidential-token', 'Anchor / Rust', 'Mint, transfer, burn; chunked ciphertext storage'],
                ['programs/confidential-swap', 'Anchor / Rust', 'SOL ↔ cifherSOL swap pool'],
                ['worker/', 'Node.js / TypeScript', 'Event listener, REST API, on-chain writes'],
                ['fhe-sidecar/', 'Rust / tfhe-rs 0.7', 'FHE keygen, encrypt, decrypt, homomorphic add/sub'],
                ['frontend/', 'React / TypeScript', 'Phantom wallet UI'],
              ]}
            />
          </section>

          {/* FHE IMPLEMENTATION */}
          <section id="fhe" className="d-section">
            <p className="d-eyebrow">FHE Implementation</p>
            <h2 className="d-h2">Homomorphic Arithmetic</h2>
            <p className="d-p">
              The fhe-sidecar uses <InlineCode>set_server_key</InlineCode> to enable ciphertext
              arithmetic on each actix-web blocking thread. The <InlineCode>ServerKey</InlineCode> is
              loaded into a global <InlineCode>OnceLock</InlineCode> at startup and cloned once
              per thread via a thread-local flag.
            </p>
            <Code>{`
// fhe-sidecar/src/main.rs — fhe_add handler
set_server_key(sk.clone());           // thread-local, once per blocking thread
let a = expand_ct(&a_bytes)?;         // CompactCiphertextList → FheUint64
let b = expand_ct(&b_bytes)?;
let sum = a + b;                      // HOMOMORPHIC — inputs never decrypted
let val: u64 = sum.decrypt(&ck);      // only the result is revealed
encrypt_compact(val, &pk)             // re-encrypt as ~16 KB compact ciphertext
            `}</Code>

            <h3 className="d-h3">Transfer flow</h3>
            <Code>{`
// worker/src/transfer.ts
const senderBalance = await decrypt(senderCt)    // decrypt only for balance check
if (amount > senderBalance) throw new Error('Insufficient balance')

const encAmount    = await encrypt(amount)
const newSenderCt  = await fheSub(senderCt, encAmount)    // homomorphic — senderCt not decrypted
const newRecipientCt = await fheAdd(recipientCt, encAmount) // homomorphic
            `}</Code>

            <h3 className="d-h3">Ciphertext format</h3>
            <p className="d-p">
              Balances are stored as bincode-serialized <InlineCode>CompactCiphertextList</InlineCode> objects
              containing a single <InlineCode>FheUint64</InlineCode> element.
              This format is ~<strong>16,748 bytes</strong> — significantly smaller than the
              standard <InlineCode>FheUint64</InlineCode> serialization (~526 KB).
            </p>
            <Table
              headers={['Metric', 'Value']}
              rows={[
                ['Ciphertext size', '~16,748 bytes (CompactCiphertextList)'],
                ['fhe-add / fhe-sub (cold)', '~852ms (ServerKey thread init)'],
                ['fhe-add / fhe-sub (warm)', '~10ms'],
                ['Key generation', '30–120s (once, then loaded from disk)'],
                ['Key paths', 'fhe-sidecar/.fhe-keys/{client_key,server_key}.bin'],
              ]}
            />

            <h3 className="d-h3">Key management</h3>
            <p className="d-p">
              Keys are generated on first startup and saved to disk in bincode format.
              If deleted, new keys are generated but all existing on-chain ciphertexts
              become unreadable. The worker returns <InlineCode>409 KEY_MISMATCH</InlineCode> if it
              detects a key change.
            </p>
          </section>

          {/* SOLANA DESIGN */}
          <section id="solana" className="d-section">
            <p className="d-eyebrow">Solana Design</p>
            <h2 className="d-h2">Chunked Raw Byte Writes</h2>
            <p className="d-p">
              Solana's constraints make storing 16 KB ciphertexts non-trivial.
              Three limits interact:
            </p>
            <Table
              headers={['Constraint', 'Value', 'Impact']}
              rows={[
                ['Transaction size', '1,232 bytes', 'Ciphertext cannot fit in one tx'],
                ['Account growth per tx', '10,240 bytes', 'Realloc must be incremental'],
                ['BPF heap', '32 KB', 'Vec<u8> growth doubles capacity and OOMs'],
              ]}
            />

            <h3 className="d-h3">Account struct</h3>
            <p className="d-p">
              Ciphertexts are stored as raw bytes at a fixed offset in account data —
              never as a <InlineCode>Vec&lt;u8&gt;</InlineCode> field. A <InlineCode>u32</InlineCode> length
              field tracks how many bytes are written.
            </p>
            <Code>{`
pub struct ConfidentialAccount {
    pub owner:       Pubkey,  // 32 bytes  (offset  8)
    pub balance_len: u32,     //  4 bytes  (offset 40) ← NOT Vec<u8>
    pub bump:        u8,      //  1 byte   (offset 44)
}
// ACCOUNT_INIT_SPACE = 8 + 32 + 4 + 1 = 45
// ciphertext bytes at data[45 .. 45 + balance_len]

pub struct SwapPool {
    pub worker_authority:   Pubkey,  // 32
    pub token_mint:         Pubkey,  // 32
    pub token_reserve_len:  u32,     //  4 ← NOT Vec<u8>
    pub sol_reserve:        u64,     //  8
    pub price_numerator:    u64,     //  8
    pub price_denominator:  u64,     //  8
    pub bump:               u8,      //  1
}
// POOL_INIT_SPACE = 8 + 32 + 32 + 4 + 8 + 8 + 8 + 1 = 101
// ciphertext bytes at data[101 .. 101 + token_reserve_len]
            `}</Code>

            <h3 className="d-h3">Write protocol</h3>
            <p className="d-p">
              <InlineCode>CHUNK_SIZE = 880 bytes</InlineCode> keeps each transaction under
              the 1,232-byte limit. A full 16,748-byte ciphertext requires ~19 chunk
              transactions plus one <InlineCode>begin_write_balance</InlineCode> call.
            </p>
            <Code>{`
// 1. Shrink account to 45 bytes, reset balance_len = 0
begin_write_balance(new_size: u32)

// 2. Write 880-byte chunks, each reallocating the account
write_balance_chunk(offset: u32, chunk: Vec<u8>)  // × ~19
            `}</Code>

            <h3 className="d-h3">Reading ciphertext (TypeScript)</h3>
            <Code>{`
const info = await connection.getAccountInfo(accountPda)
const view = new DataView(info.data.buffer, info.data.byteOffset)

// ConfidentialAccount: balance_len at offset 40
const balanceLen = view.getUint32(40, true)
const ciphertext = info.data.slice(45, 45 + balanceLen)

// SwapPool: token_reserve_len at offset 72
const reserveLen = view.getUint32(72, true)
const reserve    = info.data.slice(101, 101 + reserveLen)
            `}</Code>
          </section>

          {/* TRUST MODEL */}
          <section id="trust" className="d-section">
            <p className="d-eyebrow">Trust Model</p>
            <h2 className="d-h2">What is and isn't trusted</h2>
            <Table
              headers={['Property', 'Status', 'Notes']}
              rows={[
                ['Hidden transfer amounts', '✓', 'FHE ciphertexts on-chain'],
                ['Hidden balances', '✓', 'Worker ClientKey required to decrypt'],
                ['Ciphertext integrity', '✓', 'On-chain — cannot be altered without a tx'],
                ['Trustless mint', '✓', 'SOL transfer enforced by program logic'],
                ['Hidden sender / receiver', '✗', 'Wallet addresses are public'],
                ['Trustless operator', '✗', 'Single worker holds ClientKey (MVP)'],
              ]}
            />
            <p className="d-p">
              The worker sees the arithmetic result during re-encryption to compact
              format (this step cannot be avoided in current tfhe-rs — see below).
              It does not see individual input balances during homomorphic operations.
            </p>
            <h3 className="d-h3">The re-encryption limitation</h3>
            <p className="d-p">
              After homomorphic addition/subtraction, the result is a large non-compact
              FheUint64 (~500 KB). Solana requires the ~16 KB compact form for on-chain
              storage. There is no way in current FHE libraries to compress a ciphertext
              without decrypting it first — the worker must briefly hold the plaintext
              result to re-encrypt it.
            </p>
            <h3 className="d-h3">Roadmap to trustlessness</h3>
            <p className="d-p">
              <strong>Threshold FHE</strong> — split the ClientKey across N independent
              operators (M-of-N to decrypt). The balance check can be made fully blind
              using homomorphic comparison:
            </p>
            <Code>{`
// reveal only a boolean, never the balance value
let sufficient: FheBool = sender_balance.ge(&enc_amount);
// threshold-decrypt just sufficient → true/false
            `}</Code>
            <p className="d-p">
              The compact re-encryption step still requires the quorum of M operators
              to collectively learn the new balance. With M-of-N, privacy holds as long
              as fewer than M operators collude.
            </p>
            <p className="d-p">
              <strong>TEE attestation</strong> (Intel SGX / AMD SEV / AWS Nitro) can
              prove, via remote attestation, that a specific code hash is running in an
              isolated enclave — giving cryptographic evidence that the plaintext is
              never logged or persisted outside the enclave.
            </p>
          </section>

          {/* PROGRAM REFERENCE */}
          <section id="programs" className="d-section">
            <p className="d-eyebrow">Program Reference</p>
            <h2 className="d-h2">On-chain Programs</h2>
            <Table
              headers={['Program', 'Address']}
              rows={[
                ['confidential_token', 'H6TaxPd91m5NMm3t3KSubsBTnMHBJHbaC4B3WhccuY7T'],
                ['confidential_swap',  'HyL5r4euova77wUoJVMA7hj8Y2s1jvJr55zSqAB1gvAa'],
              ]}
            />

            <h3 className="d-h3">PDA seeds</h3>
            <Table
              headers={['Account', 'Seeds', 'Program']}
              rows={[
                ['ConfidentialMint',    '["mint"]',                        'TOKEN_PROGRAM_ID'],
                ['Vault (SOL escrow)', '["vault", mintPda]',               'TOKEN_PROGRAM_ID'],
                ['ConfidentialAccount','["account", mintPda, ownerPubkey]','TOKEN_PROGRAM_ID'],
                ['SwapPool',           '["pool", mintPda]',                'SWAP_PROGRAM_ID'],
                ['SwapVault',          '["swap_vault", poolPda]',          'SWAP_PROGRAM_ID'],
              ]}
            />

            <h3 className="d-h3">confidential_token instructions</h3>
            <Code>{`
// User-callable
initialize_mint(denomination: u64)
initialize_account()
mint_request()                        // pays denomination lamports → vault
transfer_request(recipient: Pubkey)   // emits TransferRequested event
burn_request()                        // emits BurnRequested event

// Worker-only
begin_write_balance(new_size: u32)
write_balance_chunk(offset: u32, chunk: Vec<u8>)
fulfill_burn(sol_to_send: u64)
            `}</Code>

            <h3 className="d-h3">confidential_swap instructions</h3>
            <Code>{`
// User-callable
initialize_pool(price_numerator: u64, price_denominator: u64)
swap_sol_for_token(sol_amount: u64)       // emits SwapSolForTokenRequested
swap_token_for_sol_request()              // emits SwapTokenForSolRequested

// Worker-only
begin_write_pool_reserve(new_size: u32)
write_pool_reserve_chunk(offset: u32, chunk: Vec<u8>)
fulfill_token_for_sol(sol_amount: u64)
            `}</Code>
          </section>

          {/* API REFERENCE */}
          <section id="api" className="d-section">
            <p className="d-eyebrow">API Reference</p>
            <h2 className="d-h2">Worker REST API <span className="d-port">:3001</span></h2>
            <Table
              headers={['Method', 'Endpoint', 'Description']}
              rows={[
                ['GET',  '/health',             'Liveness check'],
                ['GET',  '/public-key',          'Serialized CompactPublicKey bytes (octet-stream)'],
                ['GET',  '/balance/:pubkey',     'Decrypt and return user balance'],
                ['GET',  '/status/:pubkey',      'Pending ops for a user'],
                ['POST', '/transfer-intent',     'Register { user, recipient, amount } before transfer_request'],
                ['POST', '/swap-intent',         'Register { user, tokenAmount } before swap_token_for_sol_request'],
              ]}
            />

            <h2 className="d-h2">fhe-sidecar HTTP API <span className="d-port">:3002</span></h2>
            <Table
              headers={['Method', 'Endpoint', 'Body / Response']}
              rows={[
                ['GET',  '/health',       '→ { status: "ok" }'],
                ['GET',  '/public-key',   '→ raw CompactPublicKey bytes'],
                ['GET',  '/ciphertext-size', '→ { bytes: 16748 }'],
                ['POST', '/encrypt',      '{ value: "<u64>" } → compact ciphertext bytes'],
                ['POST', '/decrypt',      'raw ciphertext bytes → { value: "<u64>" }'],
                ['POST', '/fhe-add',      '{ a: "<b64>", b: "<b64>" } → compact ciphertext bytes'],
                ['POST', '/fhe-sub',      '{ a: "<b64>", b: "<b64>" } → compact ciphertext bytes'],
              ]}
            />
            <p className="d-p">
              Ciphertexts are passed to <InlineCode>/fhe-add</InlineCode> and <InlineCode>/fhe-sub</InlineCode> as
              base64-encoded bytes in a JSON body. The response is raw bytes
              (Content-Type: application/octet-stream).
            </p>
          </section>

          {/* RUNNING LOCALLY */}
          <section id="running" className="d-section">
            <p className="d-eyebrow">Running Locally</p>
            <h2 className="d-h2">Prerequisites</h2>
            <p className="d-p">Rust, Anchor CLI, Node.js 20+, Solana CLI, Phantom wallet.</p>

            <h3 className="d-h3">1 — Start validator and deploy programs</h3>
            <Code>{`
solana-test-validator --reset &
anchor build && anchor deploy
            `}</Code>

            <h3 className="d-h3">2 — Build the FHE sidecar</h3>
            <p className="d-p">
              Required once. First run generates keys — takes 30–120 seconds.
              Subsequent starts load from disk instantly.
            </p>
            <Code>{`
cd fhe-sidecar
cargo build --release
            `}</Code>

            <h3 className="d-h3">3 — Start the worker</h3>
            <Code>{`
cd worker
cp .env.example .env
npm install
npm run dev        # spawns fhe-sidecar automatically
            `}</Code>

            <h3 className="d-h3">4 — Start the frontend</h3>
            <Code>{`
cd frontend
npm install
npm run dev        # localhost:5173
            `}</Code>

            <h3 className="d-h3">Run tests</h3>
            <Code>{`
anchor test        # 10 integration tests — all passing
            `}</Code>
            <p className="d-p">
              Tests use the tfhe WASM package directly and do not require
              the fhe-sidecar to be running.
            </p>

            <h3 className="d-h3">Environment variables</h3>
            <Code>{`
# worker/.env
SOLANA_RPC_URL=http://127.0.0.1:8899
WORKER_KEYPAIR_PATH=~/.config/solana/id.json
DENOMINATION=1000000000
PORT=3001

# frontend/.env
VITE_RPC_URL=http://127.0.0.1:8899
VITE_WORKER_URL=http://localhost:3001
            `}</Code>
          </section>

        </main>
      </div>
    </div>
  )
}
