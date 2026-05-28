/**
 * CiFHErClient — main entry point for the ciFHEr SDK.
 *
 * Provides a clean interface for integrating confidential tokens on Solana
 * into any TypeScript/JavaScript application. All operations that require
 * worker interaction handle authentication automatically.
 *
 * Usage:
 *   const client = new CiFHErClient({ workerUrl: '...', wallet })
 *   await client.initAccount()
 *   await client.mint()
 *   await client.transfer({ to: recipientAddress, amount: 1n })
 *   const balance = await client.getBalance()
 */

import { Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import BN from 'bn.js';

import { CiFHErConfig, TransferParams, OperationStatus, WalletAdapter, AuthError } from './types';
import { WorkerClient } from './worker';
import { DEFAULT_RPC_URL, TOKEN_PROGRAM_ID, SWAP_PROGRAM_ID, AUTH_PREFIX } from './constants';
import {
  createProvider,
  getTokenProgram,
  getSwapProgram,
  getMintPda,
  getConfidentialAccountPda,
  getVaultPda,
  getSwapPoolPda,
  getSwapVaultPda,
  getWorkerAuthority,
} from './program';

export class CiFHErClient {
  private readonly connection: Connection;
  private readonly workerClient: WorkerClient;
  private readonly wallet: WalletAdapter;

  /** Cached session token (expires in 4h; auto-refreshed). */
  private sessionToken: string | null = null;
  private sessionExpiry: number = 0;

  constructor(config: CiFHErConfig) {
    this.connection = new Connection(config.rpcUrl ?? DEFAULT_RPC_URL, 'confirmed');
    this.workerClient = new WorkerClient(config.workerUrl);
    this.wallet = config.wallet;
  }

  // ── Authentication ──────────────────────────────────────────────────────────

  /**
   * Authenticate with the worker and get a session token.
   *
   * The token is cached and reused until it expires (4 hours).
   * You don't need to call this manually — it's invoked automatically
   * by operations that require worker authentication.
   *
   * @returns Session token string
   */
  async auth(): Promise<string> {
    // Return cached token if still valid (with 60s safety margin)
    const now = Date.now();
    if (this.sessionToken && now < this.sessionExpiry - 60_000) {
      return this.sessionToken;
    }

    if (!this.wallet.signMessage) {
      throw new AuthError(
        'This wallet does not support signMessage. ' +
          'Worker authentication requires a wallet that can sign arbitrary messages.',
      );
    }

    const pubkey = this.wallet.publicKey.toBase58();
    const timestamp = now;
    const msgText = `${AUTH_PREFIX}\npubkey: ${pubkey}\ntimestamp: ${timestamp}`;
    const msgBytes = new TextEncoder().encode(msgText);

    let signature: Uint8Array;
    try {
      signature = await this.wallet.signMessage(msgBytes);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new AuthError(`Failed to sign auth message: ${msg}`);
    }

    const messageB64 = Buffer.from(msgBytes).toString('base64');
    const signatureB64 = Buffer.from(signature).toString('base64');

    const token = await this.workerClient.auth(pubkey, messageB64, signatureB64);

    // Cache for 4 hours (the worker's session TTL)
    this.sessionToken = token;
    this.sessionExpiry = now + 4 * 60 * 60 * 1000;

    return token;
  }

  // ── Account management ──────────────────────────────────────────────────────

  /**
   * Initialize a confidential account on-chain for the connected wallet.
   *
   * This must be called once per wallet before using any token operations.
   * It creates a PDA account that stores the user's encrypted FHE balance.
   *
   * This method is idempotent: if the account already exists it returns `null`
   * without submitting a transaction.
   *
   * @returns Transaction signature, or `null` if the account already existed
   */
  async initAccount(): Promise<string | null> {
    const provider = createProvider(this.connection, this.wallet);
    const program = getTokenProgram(provider);
    const owner = this.wallet.publicKey;
    const [mintPda] = getMintPda();
    const [accountPda] = getConfidentialAccountPda(owner);

    // Idempotent: skip if account already exists
    const existing = await (program.account as Record<string, {
      fetchNullable(pda: PublicKey): Promise<unknown>
    }>).confidentialAccount.fetchNullable(accountPda);
    if (existing) return null;

    return program.methods
      .initializeAccount()
      .accounts({
        confidentialMint: mintPda,
        confidentialAccount: accountPda,
        owner,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  /**
   * Check whether the connected wallet has an initialized confidential account.
   */
  async accountExists(): Promise<boolean> {
    const provider = createProvider(this.connection, this.wallet);
    const program = getTokenProgram(provider);
    const [accountPda] = getConfidentialAccountPda(this.wallet.publicKey);
    const account = await (program.account as Record<string, {
      fetchNullable(pda: PublicKey): Promise<unknown>
    }>).confidentialAccount.fetchNullable(accountPda);
    return account !== null;
  }

  // ── Token operations ────────────────────────────────────────────────────────

  /**
   * Mint 1 cifherSOL by locking exactly 1 SOL in the escrow vault.
   *
   * Emits a `MintRequested` on-chain event. The worker listens for this event,
   * encrypts the token amount using FHE, and writes the ciphertext to your
   * account in ~19 chunked transactions. This takes a few seconds.
   *
   * Fees: none (only the 1 SOL cost of the token itself)
   *
   * @returns Transaction signature for the on-chain mint request
   */
  async mint(): Promise<string> {
    const provider = createProvider(this.connection, this.wallet);
    const program = getTokenProgram(provider);
    const user = this.wallet.publicKey;
    const [mintPda] = getMintPda();
    const [vaultPda] = getVaultPda();
    const [accountPda] = getConfidentialAccountPda(user);

    return program.methods
      .mintRequest()
      .accounts({
        confidentialMint: mintPda,
        vault: vaultPda,
        userAccount: accountPda,
        user,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  /**
   * Transfer confidential tokens to another wallet.
   *
   * The transfer amount is encrypted and the arithmetic happens homomorphically —
   * neither the sender's nor the recipient's balance is ever decrypted during
   * the operation. Only the worker can read balances.
   *
   * Flow:
   *  1. Registers the transfer intent with the worker (authenticated)
   *  2. Submits transfer_request on-chain (emits event)
   *  3. Worker picks up event, performs FHE arithmetic, writes new ciphertexts
   *
   * Fees: 0.005 SOL flat fee per transfer
   *
   * @param to     Recipient wallet address (base58). Must have an initialized account.
   * @param amount Amount in cifherSOL token units (e.g. 1n = 1 token)
   * @returns Transaction signature
   */
  async transfer({ to, amount }: TransferParams): Promise<string> {
    const token = await this.auth();
    const sender = this.wallet.publicKey.toBase58();

    await this.workerClient.registerTransferIntent(sender, to, amount, token);

    const provider = createProvider(this.connection, this.wallet);
    const program = getTokenProgram(provider);
    const user = this.wallet.publicKey;
    const recipientKey = new PublicKey(to);
    const [mintPda] = getMintPda();
    const [accountPda] = getConfidentialAccountPda(user);
    const treasury = await getWorkerAuthority(this.connection);

    return program.methods
      .transferRequest(recipientKey)
      .accounts({
        confidentialMint: mintPda,
        userAccount: accountPda,
        user,
        treasury,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  /**
   * Burn all cifherSOL and receive the equivalent SOL back to your wallet.
   *
   * The worker decrypts your balance, returns the SOL from the vault,
   * and clears your encrypted balance on-chain.
   *
   * Fees: free
   *
   * @returns Transaction signature
   */
  async burn(): Promise<string> {
    const provider = createProvider(this.connection, this.wallet);
    const program = getTokenProgram(provider);
    const user = this.wallet.publicKey;
    const [mintPda] = getMintPda();
    const [accountPda] = getConfidentialAccountPda(user);

    return program.methods
      .burnRequest()
      .accounts({
        confidentialMint: mintPda,
        userAccount: accountPda,
        user,
      })
      .rpc();
  }

  // ── Swap ────────────────────────────────────────────────────────────────────

  /**
   * Swap SOL for cifherSOL via the confidential swap pool.
   *
   * The swap amount is not revealed in the pool state — both reserves
   * are stored as encrypted values.
   *
   * Fees: 0.3% of the SOL amount
   *
   * @param lamports Amount of SOL in lamports (1 SOL = 1_000_000_000n)
   * @returns Transaction signature
   */
  async swapSolForToken(lamports: bigint): Promise<string> {
    const provider = createProvider(this.connection, this.wallet);
    const program = getSwapProgram(provider);
    const user = this.wallet.publicKey;
    const [poolPda] = getSwapPoolPda();
    const [swapVaultPda] = getSwapVaultPda(poolPda);
    const treasury = await getWorkerAuthority(this.connection);

    return program.methods
      .swapSolForToken(new BN(lamports.toString()))
      .accounts({
        user,
        pool: poolPda,
        swapVault: swapVaultPda,
        treasury,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  /**
   * Swap cifherSOL back to SOL via the confidential swap pool.
   *
   * Registers the intent with the worker first (amount must be known
   * before the on-chain event fires).
   *
   * Fees: free
   *
   * @param amount Amount of cifherSOL tokens to swap (in token units, not lamports)
   * @returns Transaction signature
   */
  async swapTokenForSol(amount: bigint): Promise<string> {
    const token = await this.auth();
    const user = this.wallet.publicKey.toBase58();

    await this.workerClient.registerSwapIntent(user, amount, token);

    const provider = createProvider(this.connection, this.wallet);
    const program = getSwapProgram(provider);
    const userKey = this.wallet.publicKey;
    const [poolPda] = getSwapPoolPda();

    return program.methods
      .swapTokenForSolRequest()
      .accounts({
        user: userKey,
        pool: poolPda,
      })
      .rpc();
  }

  // ── Balance & status ────────────────────────────────────────────────────────

  /**
   * Get the decrypted cifherSOL balance for the connected wallet.
   *
   * The worker uses the FHE server key to decrypt the on-chain ciphertext.
   * Requires worker authentication.
   *
   * @returns Balance in token units (bigint), or null if the account has no balance
   */
  async getBalance(): Promise<bigint | null> {
    const token = await this.auth();
    const pubkey = this.wallet.publicKey.toBase58();
    return this.workerClient.getBalance(pubkey, token);
  }

  /**
   * Get the status of pending worker operations for a wallet.
   *
   * Useful for polling until a mint/transfer/burn completes.
   *
   * @param walletAddress Optional wallet address; defaults to connected wallet
   * @returns Array of operation status objects, newest first
   */
  async getOperationStatus(walletAddress?: string): Promise<OperationStatus[]> {
    const address = walletAddress ?? this.wallet.publicKey.toBase58();
    return this.workerClient.getStatus(address);
  }

  /**
   * Wait for all pending operations on the connected wallet to complete.
   *
   * Polls every `intervalMs` milliseconds for up to `timeoutMs`.
   *
   * @param intervalMs Polling interval (default: 2000ms)
   * @param timeoutMs  Maximum wait time (default: 120000ms / 2 minutes)
   */
  async waitForCompletion(intervalMs = 2000, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const ops = await this.getOperationStatus();
      const pending = ops.filter((op) => op.status === 'pending' || op.status === 'processing');

      if (pending.length === 0) return;

      const errored = ops.filter((op) => op.status === 'error');
      if (errored.length > 0) {
        throw new Error(`Operation failed: ${errored[0]?.error ?? 'unknown error'}`);
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(`waitForCompletion timed out after ${timeoutMs}ms`);
  }

  // ── Worker health ───────────────────────────────────────────────────────────

  /**
   * Check if the ciFHEr worker is online and reachable.
   */
  async isWorkerOnline(): Promise<boolean> {
    return this.workerClient.health();
  }

  // ── Connection ──────────────────────────────────────────────────────────────

  /** Returns the underlying Solana connection used by this client. */
  getConnection(): Connection {
    return this.connection;
  }

  /** Returns the program IDs used by the SDK. */
  getProgramIds(): { tokenProgramId: string; swapProgramId: string } {
    return {
      tokenProgramId: TOKEN_PROGRAM_ID.toBase58(),
      swapProgramId: SWAP_PROGRAM_ID.toBase58(),
    };
  }
}
