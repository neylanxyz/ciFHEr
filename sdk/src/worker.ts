/**
 * HTTP client for the ciFHEr worker REST API.
 *
 * The worker is an off-chain Node.js service that:
 *  - Listens to on-chain events (mint, transfer, burn, swap)
 *  - Performs FHE operations via the Rust sidecar (tfhe-rs)
 *  - Writes encrypted balances back to Solana in chunked transactions
 *
 * API endpoints:
 *  GET  /health              — liveness check
 *  POST /auth                — wallet-based authentication
 *  GET  /balance/:userId     — decrypt and return user's token balance
 *  GET  /status/:userId      — list pending operations for a user
 *  POST /transfer-intent     — register transfer intent before on-chain tx
 *  POST /swap-intent         — register swap intent before on-chain tx
 */

import { OperationStatus, WorkerError } from './types';

export class WorkerClient {
  private readonly baseUrl: string;

  constructor(workerUrl: string) {
    // Normalize: strip trailing slash
    this.baseUrl = workerUrl.replace(/\/$/, '');
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private async request<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let response: Response;

    try {
      response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers ?? {}),
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new WorkerError(`Network error connecting to worker at ${this.baseUrl}: ${msg}`);
    }

    if (!response.ok) {
      let body: { error?: string; code?: string } = {};
      try { body = (await response.json()) as typeof body; } catch { /* ignore */ }
      throw new WorkerError(
        body.error ?? `Worker returned ${response.status}`,
        response.status,
        body.code,
      );
    }

    return response.json() as Promise<T>;
  }

  private authHeader(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` };
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Check whether the worker is online.
   * Returns true if the worker responds with { status: 'ok' }.
   */
  async health(): Promise<boolean> {
    try {
      const res = await this.request<{ status: string }>('/health');
      return res.status === 'ok';
    } catch {
      return false;
    }
  }

  /**
   * Authenticate with the worker using a wallet signature.
   *
   * @param pubkey     Base58-encoded wallet public key
   * @param messageB64 Base64-encoded auth message
   * @param signatureB64 Base64-encoded Ed25519 signature
   * @returns Session token (valid for 4 hours)
   */
  async auth(pubkey: string, messageB64: string, signatureB64: string): Promise<string> {
    const res = await this.request<{ token: string }>('/auth', {
      method: 'POST',
      body: JSON.stringify({ pubkey, message: messageB64, signature: signatureB64 }),
    });
    return res.token;
  }

  /**
   * Fetch the decrypted cifherSOL balance for a wallet address.
   * Requires a valid session token.
   *
   * @returns Token balance as bigint, or null if the account has no balance yet
   */
  async getBalance(walletAddress: string, token: string): Promise<bigint | null> {
    try {
      const res = await this.request<{ balance: string }>(
        `/balance/${walletAddress}`,
        { headers: this.authHeader(token) },
      );
      return BigInt(res.balance);
    } catch (err) {
      if (err instanceof WorkerError && err.statusCode === 404) return null;
      throw err;
    }
  }

  /**
   * Get the status of pending/recent operations for a wallet.
   *
   * @returns Array of operation status objects, newest first
   */
  async getStatus(walletAddress: string): Promise<OperationStatus[]> {
    const res = await this.request<{ ops: OperationStatus[] }>(
      `/status/${walletAddress}`,
    );
    return res.ops;
  }

  /**
   * Register a transfer intent with the worker BEFORE submitting the
   * on-chain transfer_request instruction.
   *
   * The worker uses this intent to know the recipient and amount when it
   * receives the on-chain event.
   */
  async registerTransferIntent(
    senderAddress: string,
    recipientAddress: string,
    amount: bigint,
    token: string,
  ): Promise<void> {
    await this.request('/transfer-intent', {
      method: 'POST',
      headers: this.authHeader(token),
      body: JSON.stringify({
        user: senderAddress,
        recipient: recipientAddress,
        amount: amount.toString(),
      }),
    });
  }

  /**
   * Register a swap intent with the worker BEFORE submitting the
   * on-chain swap_token_for_sol_request instruction.
   */
  async registerSwapIntent(
    walletAddress: string,
    tokenAmount: bigint,
    token: string,
  ): Promise<void> {
    await this.request('/swap-intent', {
      method: 'POST',
      headers: this.authHeader(token),
      body: JSON.stringify({
        user: walletAddress,
        tokenAmount: tokenAmount.toString(),
      }),
    });
  }
}
