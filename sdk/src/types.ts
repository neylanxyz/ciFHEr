import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';

// ── Wallet Interface ───────────────────────────────────────────────────────────

/**
 * Minimal wallet interface required by CiFHErClient.
 * Compatible with Phantom wallet adapter and any standard Solana wallet.
 *
 * For Node.js usage with a Keypair, use `keypairToWallet()` from this package.
 */
export interface WalletAdapter {
  /** The connected wallet's public key. */
  publicKey: PublicKey;

  /** Sign a single transaction. */
  signTransaction<T extends Transaction | VersionedTransaction>(
    transaction: T,
  ): Promise<T>;

  /** Sign multiple transactions in a batch. */
  signAllTransactions<T extends Transaction | VersionedTransaction>(
    transactions: T[],
  ): Promise<T[]>;

  /**
   * Sign an arbitrary message (used for worker authentication).
   * Returns the raw Ed25519 signature bytes.
   */
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

// ── Client Configuration ───────────────────────────────────────────────────────

/** Configuration for CiFHErClient. */
export interface CiFHErConfig {
  /**
   * URL of the ciFHEr worker REST API.
   * Example: 'https://worker.cifher.xyz' or 'http://localhost:3001'
   */
  workerUrl: string;

  /**
   * Solana RPC URL.
   * Defaults to the devnet public endpoint if not specified.
   */
  rpcUrl?: string;

  /** Connected wallet adapter. Must support signMessage for worker authentication. */
  wallet: WalletAdapter;
}

// ── Operations ─────────────────────────────────────────────────────────────────

/** Parameters for a confidential token transfer. */
export interface TransferParams {
  /** Recipient wallet address (base58). Must have an initialized confidential account. */
  to: string;

  /**
   * Amount of cifherSOL tokens to transfer.
   * This is in token units, not lamports.
   * Example: 1n = 1 cifherSOL
   */
  amount: bigint;
}

/** Status of a pending worker operation. */
export interface OperationStatus {
  id: string;
  type: 'mint' | 'transfer' | 'burn' | 'swap_sol_for_token' | 'swap_token_for_sol';
  user: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  timestamp: number;
  error?: string;
}

/** Result of a worker health check. */
export interface WorkerHealth {
  online: boolean;
  status?: string;
}

// ── Errors ─────────────────────────────────────────────────────────────────────

/** Thrown when the worker API returns an error. */
export class WorkerError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'WorkerError';
  }
}

/** Thrown when a wallet operation (sign/auth) fails. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}
