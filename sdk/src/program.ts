/**
 * PDA derivation helpers and Anchor program utilities for ciFHEr.
 * These functions mirror the on-chain program logic for computing
 * deterministic account addresses.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program, Idl } from '@coral-xyz/anchor';
import { TOKEN_PROGRAM_ID, SWAP_PROGRAM_ID } from './constants';
import { WalletAdapter } from './types';

// ── IDLs ──────────────────────────────────────────────────────────────────────

import tokenIdlJson from './idl/confidential_token.json';
import swapIdlJson from './idl/confidential_swap.json';

const tokenIdl = tokenIdlJson as unknown as Idl;
const swapIdl = swapIdlJson as unknown as Idl;

// ── Provider factory ──────────────────────────────────────────────────────────

/**
 * Create an AnchorProvider from a connection and wallet.
 */
export function createProvider(connection: Connection, wallet: WalletAdapter): AnchorProvider {
  return new AnchorProvider(
    connection,
    {
      publicKey: wallet.publicKey,
      signTransaction: wallet.signTransaction.bind(wallet),
      signAllTransactions: wallet.signAllTransactions.bind(wallet),
    },
    { commitment: 'confirmed' },
  );
}

// ── Program factories ─────────────────────────────────────────────────────────

/** Get the confidential-token Anchor program. */
export function getTokenProgram(provider: AnchorProvider): Program {
  return new Program(tokenIdl, provider);
}

/** Get the confidential-swap Anchor program. */
export function getSwapProgram(provider: AnchorProvider): Program {
  return new Program(swapIdl, provider);
}

// ── PDA derivation ────────────────────────────────────────────────────────────

/**
 * Derive the ConfidentialMint PDA.
 * Seeds: ["mint"]
 */
export function getMintPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('mint')], TOKEN_PROGRAM_ID);
}

/**
 * Derive the ConfidentialAccount PDA for a given owner wallet.
 * Seeds: ["account", mintPda, owner]
 */
export function getConfidentialAccountPda(owner: PublicKey): [PublicKey, number] {
  const [mintPda] = getMintPda();
  return PublicKey.findProgramAddressSync(
    [Buffer.from('account'), mintPda.toBuffer(), owner.toBuffer()],
    TOKEN_PROGRAM_ID,
  );
}

/**
 * Derive the SOL vault PDA for the confidential-token program.
 * Seeds: ["vault", mintPda]
 */
export function getVaultPda(): [PublicKey, number] {
  const [mintPda] = getMintPda();
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), mintPda.toBuffer()],
    TOKEN_PROGRAM_ID,
  );
}

/**
 * Derive the SwapPool PDA.
 * Seeds: ["pool", mintPda]
 */
export function getSwapPoolPda(): [PublicKey, number] {
  const [mintPda] = getMintPda();
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), mintPda.toBuffer()],
    SWAP_PROGRAM_ID,
  );
}

/**
 * Derive the swap vault PDA.
 * Seeds: ["swap_vault", poolPda]
 */
export function getSwapVaultPda(poolPda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('swap_vault'), poolPda.toBuffer()],
    SWAP_PROGRAM_ID,
  );
}

// ── Worker authority ──────────────────────────────────────────────────────────

let cachedWorkerAuthority: PublicKey | null = null;

/**
 * Fetch the worker authority public key from the SwapPool on-chain account.
 *
 * The SwapPool layout is: discriminator(8) + worker_authority(32) + ...
 * The worker authority is used as the `treasury` account in fee-bearing
 * instructions (transfer_request, swap_sol_for_token).
 *
 * Result is cached at module level after the first successful fetch.
 * If you need to clear the cache (e.g. switching networks in tests),
 * call `clearWorkerAuthorityCache()`.
 */
export async function getWorkerAuthority(connection: Connection): Promise<PublicKey> {
  if (cachedWorkerAuthority) return cachedWorkerAuthority;

  const [poolPda] = getSwapPoolPda();
  const info = await connection.getAccountInfo(poolPda);
  if (!info) {
    throw new Error(
      'Swap pool account not found. Ensure the worker is running and initialized on-chain.',
    );
  }

  // worker_authority lives at bytes [8, 40) of the raw account data
  cachedWorkerAuthority = new PublicKey(info.data.slice(8, 40));
  return cachedWorkerAuthority;
}

/**
 * Reset the cached worker authority (useful for testing).
 */
export function clearWorkerAuthorityCache(): void {
  cachedWorkerAuthority = null;
}
