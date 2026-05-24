/**
 * Anchor program setup and PDA / data helpers.
 * Also exports writeEncryptedBalance / writePoolReserve for chunked FHE ciphertext uploads.
 */

import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

// ── Environment ───────────────────────────────────────────────────────────────

const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const keypairPath = (process.env.WORKER_KEYPAIR_PATH ?? '~/.config/solana/id.json').replace(
  /^~/,
  process.env.HOME ?? '~',
);

// ── Keypair ───────────────────────────────────────────────────────────────────

function loadKeypair(filePath: string): Keypair {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(raw) as number[]));
}

export const workerKeypair: Keypair = loadKeypair(keypairPath);

// ── Connection & Provider ─────────────────────────────────────────────────────

export const connection = new Connection(rpcUrl, 'confirmed');
const wallet = new anchor.Wallet(workerKeypair);
export const provider = new anchor.AnchorProvider(connection, wallet, {
  commitment: 'confirmed',
});
anchor.setProvider(provider);

// ── IDLs ──────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-var-requires
const tokenIdl = require('./idl/confidential_token.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const swapIdl = require('./idl/confidential_swap.json');

export const TOKEN_PROGRAM_ID = new PublicKey(tokenIdl.address as string);
export const SWAP_PROGRAM_ID = new PublicKey(swapIdl.address as string);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const tokenProgram: any = new anchor.Program(tokenIdl, provider);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const swapProgram: any = new anchor.Program(swapIdl, provider);

// ── PDAs ──────────────────────────────────────────────────────────────────────

export const [mintPda] = PublicKey.findProgramAddressSync(
  [Buffer.from('mint')],
  TOKEN_PROGRAM_ID,
);

export const [vaultPda] = PublicKey.findProgramAddressSync(
  [Buffer.from('vault'), mintPda.toBuffer()],
  TOKEN_PROGRAM_ID,
);

export function getUserAccountPda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('account'), mintPda.toBuffer(), owner.toBuffer()],
    TOKEN_PROGRAM_ID,
  );
}

export function getPoolPda(tokenMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), tokenMint.toBuffer()],
    SWAP_PROGRAM_ID,
  );
}

export function getSwapVaultPda(pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('swap_vault'), pool.toBuffer()],
    SWAP_PROGRAM_ID,
  );
}

// ── Data helpers ──────────────────────────────────────────────────────────────

export async function getMintData(): Promise<any> {
  return tokenProgram.account.confidentialMint.fetch(mintPda);
}

export async function getUserAccountData(owner: PublicKey): Promise<any | null> {
  const [pda] = getUserAccountPda(owner);
  try {
    return await tokenProgram.account.confidentialAccount.fetch(pda);
  } catch {
    return null;
  }
}

export async function getPoolData(): Promise<any | null> {
  const [poolPda] = getPoolPda(mintPda);
  try {
    return await swapProgram.account.swapPool.fetch(poolPda);
  } catch {
    return null;
  }
}

// Raw ciphertext bytes in ConfidentialAccount start at offset 45:
// discriminator(8) + owner(32) + balance_len(4) + bump(1)
const ACCOUNT_INIT_SPACE = 45;

// Raw ciphertext bytes in SwapPool start at offset 101:
// discriminator(8) + worker_authority(32) + token_mint(32) + token_reserve_len(4)
// + sol_reserve(8) + price_numerator(8) + price_denominator(8) + bump(1)
const POOL_INIT_SPACE = 101;

/** Returns the FHE ciphertext bytes for a user's balance, or null if empty. */
export async function getEncryptedBalance(owner: PublicKey): Promise<Uint8Array | null> {
  const [pda] = getUserAccountPda(owner);
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;
  const view = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
  const balanceLen = view.getUint32(40, true); // offset 8+32
  if (balanceLen === 0) return null;
  return new Uint8Array(info.data.slice(ACCOUNT_INIT_SPACE, ACCOUNT_INIT_SPACE + balanceLen));
}

/** Returns the FHE ciphertext bytes for the pool's token reserve, or null if empty. */
export async function getEncryptedPoolReserve(): Promise<Uint8Array | null> {
  const [poolPda] = getPoolPda(mintPda);
  const info = await connection.getAccountInfo(poolPda);
  if (!info) return null;
  const view = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
  const reserveLen = view.getUint32(72, true); // offset 8+32+32
  if (reserveLen === 0) return null;
  return new Uint8Array(info.data.slice(POOL_INIT_SPACE, POOL_INIT_SPACE + reserveLen));
}

// ── Minimum balance guard ─────────────────────────────────────────────────────

const MIN_BALANCE = BigInt(process.env.MIN_WORKER_BALANCE ?? '1000000000'); // 1 SOL default

// Estimated cost per balance update: ~20 txs × 5000 lamports each
const ESTIMATED_WRITE_COST = 100_000n;

async function assertWorkerSolvent(estimatedCost = ESTIMATED_WRITE_COST): Promise<void> {
  const balance = BigInt(await connection.getBalance(workerKeypair.publicKey));
  if (balance - estimatedCost < MIN_BALANCE) {
    throw new Error(
      `Worker balance too low (${balance} lamports). ` +
      `Minimum required: ${MIN_BALANCE} lamports. Refusing to process.`
    );
  }
}

// ── Chunked ciphertext write helpers ─────────────────────────────────────────

const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

/**
 * Write a full FHE ciphertext into a user's encrypted_balance field.
 * Calls begin_write_balance (realloc) then write_balance_chunk for each 880-byte slice.
 */
export async function writeEncryptedBalance(
  userPubkey: PublicKey,
  ciphertext: Uint8Array,
  chunkSize = 880,
): Promise<void> {
  await assertWorkerSolvent();
  const [userAccountPda] = getUserAccountPda(userPubkey);

  await tokenProgram.methods
    .beginWriteBalance(ciphertext.length)
    .accounts({
      confidentialMint: mintPda,
      userAccount: userAccountPda,
      authority: workerKeypair.publicKey,
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .rpc();

  for (let offset = 0; offset < ciphertext.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, ciphertext.length);
    const chunk = Buffer.from(ciphertext.slice(offset, end));
    await tokenProgram.methods
      .writeBalanceChunk(offset, chunk)
      .accounts({
        confidentialMint: mintPda,
        userAccount: userAccountPda,
        authority: workerKeypair.publicKey,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc();
  }
}

/**
 * Write a full FHE ciphertext into the swap pool's encrypted_token_reserve field.
 */
export async function writePoolReserve(
  ciphertext: Uint8Array,
  chunkSize = 880,
): Promise<void> {
  await assertWorkerSolvent();
  const [poolPda] = getPoolPda(mintPda);

  await swapProgram.methods
    .beginWritePoolReserve(ciphertext.length)
    .accounts({
      workerAuthority: workerKeypair.publicKey,
      pool: poolPda,
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .rpc();

  for (let offset = 0; offset < ciphertext.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, ciphertext.length);
    const chunk = Buffer.from(ciphertext.slice(offset, end));
    await swapProgram.methods
      .writePoolReserveChunk(offset, chunk)
      .accounts({
        workerAuthority: workerKeypair.publicKey,
        pool: poolPda,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc();
  }
}
