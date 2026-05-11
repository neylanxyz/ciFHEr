/**
 * Handlers for swap events.
 *
 * SOL → Token:
 *  1. User sends SOL on-chain → SwapSolForTokenRequested fires.
 *  2. Worker computes token amount from price ratio.
 *  3. Credits user's encrypted balance via fheAdd (homomorphic).
 *  4. Updates pool's encrypted_token_reserve via fheAdd (homomorphic).
 *
 * Token → SOL:
 *  1. User registers intent via POST /swap-intent { tokenAmount }.
 *  2. User calls swap_token_for_sol_request() → event fires.
 *  3. Worker decrypts user's balance; computes SOL to send.
 *  4. Calls fulfill_token_for_sol (sends SOL, updates sol_reserve).
 *  5. Writes updated user balance + pool reserve in chunks.
 */

import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import {
  tokenProgram,
  swapProgram,
  mintPda,
  workerKeypair,
  getUserAccountData,
  getEncryptedBalance,
  getPoolData,
  getEncryptedPoolReserve,
  getPoolPda,
  getSwapVaultPda,
  writeEncryptedBalance,
  writePoolReserve,
} from './program';
import { encrypt, decrypt, encryptZero, fheAdd } from './fhe';
import {
  pendingOps,
  pendingSwapAmounts,
  makeOpId,
  opProcessing,
  opDone,
  opError,
} from './types';

const DENOMINATION = BigInt(process.env.DENOMINATION ?? '1000000000');
const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

function computeTokenOut(solAmount: bigint): bigint {
  return solAmount / DENOMINATION;
}

function computeSolOut(tokenAmount: bigint): bigint {
  return tokenAmount * DENOMINATION;
}

// ── SOL → Token ───────────────────────────────────────────────────────────────

export async function handleSwapSolForToken(event: any): Promise<void> {
  const userPubkey: PublicKey =
    event.user instanceof PublicKey ? event.user : new PublicKey(event.user.toString());

  const solAmount: bigint = BigInt(
    event.solAmount?.toString() ?? event.sol_amount?.toString() ?? '0',
  );

  const op = {
    id: makeOpId('swap_sol_for_token', userPubkey.toBase58()),
    type: 'swap_sol_for_token' as const,
    user: userPubkey.toBase58(),
    status: 'pending' as const,
    timestamp: Date.now(),
  };
  pendingOps.set(op.id, op);
  console.log(`[swap] SwapSolForToken user=${op.user} sol=${solAmount}`);

  try {
    opProcessing(op);

    const tokenAmount = computeTokenOut(solAmount);
    console.log(`[swap] tokenAmount=${tokenAmount}`);

    const encTokenAmount = await encrypt(tokenAmount);

    // Credit user account (skip if worker seed tx — no ConfidentialAccount)
    const accountData = await getUserAccountData(userPubkey);
    if (accountData) {
      const existing = await getEncryptedBalance(userPubkey);
      const finalUserCt = existing
        ? await fheAdd(existing, encTokenAmount)
        : encTokenAmount;
      await writeEncryptedBalance(userPubkey, finalUserCt);
      console.log(`[swap] User balance written`);
    } else {
      console.log(`[swap] No ConfidentialAccount for ${op.user} — skipping user credit`);
    }

    // Update pool reserve: pool gains tokens when user buys
    const existingReserve = await getEncryptedPoolReserve();
    const newPoolReserve = existingReserve
      ? await fheAdd(existingReserve, encTokenAmount)
      : encTokenAmount;
    await writePoolReserve(newPoolReserve);
    console.log(`[swap] Pool reserve written`);

    opDone(op);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error(`[swap] SwapSolForToken error for ${op.user}: ${msg}`);
    opError(op, msg);
  }
}

// ── Token → SOL ───────────────────────────────────────────────────────────────

export async function handleSwapTokenForSol(event: any): Promise<void> {
  const userPubkey: PublicKey =
    event.user instanceof PublicKey ? event.user : new PublicKey(event.user.toString());

  const op = {
    id: makeOpId('swap_token_for_sol', userPubkey.toBase58()),
    type: 'swap_token_for_sol' as const,
    user: userPubkey.toBase58(),
    status: 'pending' as const,
    timestamp: Date.now(),
  };
  pendingOps.set(op.id, op);
  console.log(`[swap] SwapTokenForSol user=${op.user}`);

  try {
    opProcessing(op);

    const accountData = await getUserAccountData(userPubkey);
    if (!accountData) throw new Error(`No ConfidentialAccount for ${op.user}`);

    const encryptedBalance = await getEncryptedBalance(userPubkey);
    if (!encryptedBalance) throw new Error(`User ${op.user} has no balance`);

    const totalBalance = await decrypt(encryptedBalance);

    const intendedAmount = pendingSwapAmounts.get(op.user);
    pendingSwapAmounts.delete(op.user);
    const swapAmount =
      intendedAmount !== undefined
        ? intendedAmount > totalBalance
          ? totalBalance
          : intendedAmount
        : totalBalance;
    const remainingBalance = totalBalance - swapAmount;

    const solAmount = computeSolOut(swapAmount);
    console.log(`[swap] swap=${swapAmount} tokens sol=${solAmount} remaining=${remainingBalance}`);

    const poolData = await getPoolData();
    if (!poolData) throw new Error('SwapPool not found');

    const solReserve = BigInt(poolData.solReserve.toString());
    if (solReserve < solAmount) {
      throw new Error(`Insufficient SOL in pool: reserve=${solReserve}, need=${solAmount}`);
    }

    const [poolPda] = getPoolPda(mintPda);
    const [swapVaultPda] = getSwapVaultPda(poolPda);

    // Send SOL to user and update pool.sol_reserve on-chain
    await swapProgram.methods
      .fulfillTokenForSol(new BN(solAmount.toString()))
      .accounts({
        workerAuthority: workerKeypair.publicKey,
        user: userPubkey,
        pool: poolPda,
        swapVault: swapVaultPda,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc();
    console.log(`[swap] fulfillTokenForSol submitted`);

    // Write remaining user balance
    const newUserCt =
      remainingBalance > 0n ? await encrypt(remainingBalance) : await encryptZero();
    await writeEncryptedBalance(userPubkey, newUserCt);
    console.log(`[swap] User balance written (remaining=${remainingBalance})`);

    // Update pool token reserve (pool loses tokens when selling for SOL)
    const existingReserve = await getEncryptedPoolReserve();
    let newPoolReserve: Uint8Array;
    if (existingReserve) {
      try {
        const poolTokens = await decrypt(existingReserve);
        const updatedPool = poolTokens > swapAmount ? poolTokens - swapAmount : 0n;
        newPoolReserve = await encrypt(updatedPool);
      } catch {
        newPoolReserve = await encryptZero();
      }
    } else {
      newPoolReserve = await encryptZero();
    }
    await writePoolReserve(newPoolReserve);
    console.log(`[swap] Pool reserve written`);

    opDone(op);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error(`[swap] SwapTokenForSol error for ${op.user}: ${msg}`);
    opError(op, msg);
  }
}
