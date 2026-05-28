import { PublicKey } from '@solana/web3.js';

/** On-chain program ID for the confidential-token Anchor program (devnet). */
export const TOKEN_PROGRAM_ID = new PublicKey('86C1FkYaVUjV2wyWmRMrnGhXGNNpnH9aFLAJQKkAtf6u');

/** On-chain program ID for the confidential-swap Anchor program (devnet). */
export const SWAP_PROGRAM_ID = new PublicKey('A2vktybx3Nahc7THvSckeVioTobVkHNEXM5ZteGkoLDK');

/** Default Solana RPC endpoint (devnet). */
export const DEFAULT_RPC_URL = 'https://api.devnet.solana.com';

/**
 * Denomination: 1 cifherSOL = 1_000_000_000 lamports = 1 SOL.
 * Used to convert between SOL and cifherSOL token units.
 */
export const DENOMINATION = 1_000_000_000n;

/** Maximum ciphertext chunk size per Solana transaction (bytes). */
export const CHUNK_SIZE = 880;

/** Auth message prefix used to authenticate with the worker REST API. */
export const AUTH_PREFIX = 'ciFHEr auth';
