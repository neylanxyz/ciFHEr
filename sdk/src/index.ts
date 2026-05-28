/**
 * @cifher/sdk
 *
 * SDK for integrating ciFHEr confidential tokens on Solana.
 *
 * Balances and transfer amounts are stored on-chain as real FHE ciphertexts.
 * Validators and observers see only encrypted bytes.
 *
 * Quick start:
 *
 *   import { CiFHErClient } from '@cifher/sdk'
 *
 *   const client = new CiFHErClient({
 *     workerUrl: 'https://your-worker-url',
 *     wallet: phantomWallet,
 *   })
 *
 *   await client.initAccount()
 *   await client.mint()
 *   await client.transfer({ to: recipientAddress, amount: 1n })
 *   const balance = await client.getBalance()
 */

// ── Main client ───────────────────────────────────────────────────────────────

export { CiFHErClient } from './client';

// ── Sub-clients (for advanced use) ───────────────────────────────────────────

export { WorkerClient } from './worker';

// ── Types ─────────────────────────────────────────────────────────────────────

export type {
  CiFHErConfig,
  WalletAdapter,
  TransferParams,
  OperationStatus,
  WorkerHealth,
} from './types';

export { WorkerError, AuthError } from './types';

// ── Program utilities (for advanced use) ─────────────────────────────────────

export {
  getMintPda,
  getConfidentialAccountPda,
  getVaultPda,
  getSwapPoolPda,
  getSwapVaultPda,
  getWorkerAuthority,
  getTokenProgram,
  getSwapProgram,
  createProvider,
  clearWorkerAuthorityCache,
} from './program';

// ── Constants ─────────────────────────────────────────────────────────────────

export {
  TOKEN_PROGRAM_ID,
  SWAP_PROGRAM_ID,
  DEFAULT_RPC_URL,
  DENOMINATION,
  CHUNK_SIZE,
} from './constants';
