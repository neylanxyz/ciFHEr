/**
 * Handler for BurnRequested events.
 *
 * Flow:
 *  1. User signals burn intent on-chain → event fires.
 *  2. Worker fetches and decrypts user's encrypted_balance.
 *  3. Computes SOL to send = tokenAmount * denomination.
 *  4. Calls fulfill_burn(sol_to_send) — program sends SOL and zeros the balance.
 */

import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import {
  tokenProgram,
  mintPda,
  vaultPda,
  workerKeypair,
  getUserAccountPda,
  getEncryptedBalance,
} from './program';
import { decrypt } from './fhe';
import { pendingOps, makeOpId, opProcessing, opDone, opError } from './types';

const DENOMINATION = BigInt(process.env.DENOMINATION ?? '1000000000');
const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

export async function handleBurnRequested(event: any): Promise<void> {
  const userPubkey: PublicKey =
    event.user instanceof PublicKey ? event.user : new PublicKey(event.user.toString());

  const op = {
    id: makeOpId('burn', userPubkey.toBase58()),
    type: 'burn' as const,
    user: userPubkey.toBase58(),
    status: 'pending' as const,
    timestamp: Date.now(),
  };
  pendingOps.set(op.id, op);
  console.log(`[burn] user=${op.user}`);

  try {
    opProcessing(op);

    const encryptedBalance = await getEncryptedBalance(userPubkey);
    if (!encryptedBalance) {
      throw new Error(`User ${op.user} has no encrypted balance to burn`);
    }

    const tokenAmount = await decrypt(encryptedBalance);
    const solToSend = tokenAmount * DENOMINATION;
    console.log(`[burn] tokenAmount=${tokenAmount} solToSend=${solToSend}`);

    const [userAccountPda] = getUserAccountPda(userPubkey);
    await tokenProgram.methods
      .fulfillBurn(new BN(solToSend.toString()))
      .accounts({
        confidentialMint: mintPda,
        userAccount: userAccountPda,
        vault: vaultPda,
        user: userPubkey,
        authority: workerKeypair.publicKey,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc();

    console.log(`[burn] fulfillBurn submitted`);
    opDone(op);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error(`[burn] Error for ${op.user}: ${msg}`);
    opError(op, msg);
  }
}
