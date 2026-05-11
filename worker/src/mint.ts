/**
 * Handler for MintRequested events.
 *
 * Flow:
 *  1. User pays denomination lamports on-chain → event fires.
 *  2. Worker computes token amount = amount_lamports / denomination.
 *  3. Fetches user's current encrypted balance.
 *     - If empty: new balance = encrypt(tokenAmount)
 *     - If exists: new balance = fheAdd(existing, encrypt(tokenAmount))  ← homomorphic
 *  4. Writes new ciphertext to chain in chunks.
 */

import { PublicKey } from '@solana/web3.js';
import { getEncryptedBalance, writeEncryptedBalance } from './program';
import { encrypt, fheAdd } from './fhe';
import { pendingOps, makeOpId, opProcessing, opDone, opError } from './types';

const DENOMINATION = BigInt(process.env.DENOMINATION ?? '1000000000');

export async function handleMintRequested(event: any): Promise<void> {
  const userPubkey: PublicKey =
    event.user instanceof PublicKey ? event.user : new PublicKey(event.user.toString());

  const amountLamports: bigint = BigInt(
    event.amountLamports?.toString() ?? event.amount_lamports?.toString() ?? '0',
  );
  const tokenAmount: bigint = amountLamports / DENOMINATION;

  const op = {
    id: makeOpId('mint', userPubkey.toBase58()),
    type: 'mint' as const,
    user: userPubkey.toBase58(),
    status: 'pending' as const,
    timestamp: Date.now(),
  };
  pendingOps.set(op.id, op);
  console.log(`[mint] user=${op.user} tokens=${tokenAmount}`);

  try {
    opProcessing(op);

    const newCiphertext = await encrypt(tokenAmount);
    const existingBytes = await getEncryptedBalance(userPubkey);

    let finalCiphertext: Uint8Array;
    if (existingBytes) {
      try {
        finalCiphertext = await fheAdd(existingBytes, newCiphertext);
      } catch {
        console.log('[mint] Existing balance unreadable (old key) — overwriting');
        finalCiphertext = newCiphertext;
      }
    } else {
      finalCiphertext = newCiphertext;
    }

    await writeEncryptedBalance(userPubkey, finalCiphertext);
    console.log(`[mint] Done — ${finalCiphertext.length} bytes written in chunks`);
    opDone(op);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error(`[mint] Error for ${op.user}: ${msg}`);
    opError(op, msg);
  }
}
