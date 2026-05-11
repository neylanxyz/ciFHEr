/**
 * Handler for TransferRequested events.
 *
 * Flow:
 *  1. User registers intent via POST /transfer-intent { recipient, amount }.
 *  2. User calls transfer_request(recipient) on-chain → event fires.
 *  3. Worker fetches the stored intent (recipient + amount).
 *  4. Decrypts sender's balance to verify funds (balance check only).
 *  5. Encrypts `amount`, then:
 *       new_sender    = fheSub(senderCt, encAmount)   ← homomorphic, no decrypt of sender
 *       new_recipient = fheAdd(recipientCt, encAmount) ← homomorphic, no decrypt of recipient
 *  6. Writes both new ciphertexts to chain in chunks.
 */

import { PublicKey } from '@solana/web3.js';
import { getUserAccountData, getEncryptedBalance, writeEncryptedBalance } from './program';
import { encrypt, decrypt, fheAdd, fheSub } from './fhe';
import {
  pendingOps,
  pendingTransfers,
  makeOpId,
  opProcessing,
  opDone,
  opError,
} from './types';

export async function handleTransferRequested(event: any): Promise<void> {
  const senderPubkey: PublicKey =
    event.sender instanceof PublicKey ? event.sender : new PublicKey(event.sender.toString());

  const recipientPubkey: PublicKey =
    event.recipient instanceof PublicKey
      ? event.recipient
      : new PublicKey(event.recipient.toString());

  const op = {
    id: makeOpId('transfer', senderPubkey.toBase58()),
    type: 'transfer' as const,
    user: senderPubkey.toBase58(),
    status: 'pending' as const,
    timestamp: Date.now(),
  };
  pendingOps.set(op.id, op);
  console.log(`[transfer] sender=${op.user} recipient=${recipientPubkey.toBase58()}`);

  try {
    opProcessing(op);

    const intent = pendingTransfers.get(op.user);
    pendingTransfers.delete(op.user);
    if (!intent) {
      throw new Error(
        `No transfer intent registered for sender ${op.user}. ` +
          `POST /transfer-intent before calling transfer_request.`,
      );
    }
    const amount = intent.amount;

    // Fetch sender's current ciphertext
    const senderCt = await getEncryptedBalance(senderPubkey);
    if (!senderCt) throw new Error(`Sender ${op.user} has no balance`);

    // Decrypt sender balance for the ≥ check only
    const senderBalance = await decrypt(senderCt);
    if (amount > senderBalance) {
      throw new Error(`Insufficient balance: have ${senderBalance}, need ${amount}`);
    }

    // Verify recipient account exists
    const recipientData = await getUserAccountData(recipientPubkey);
    if (!recipientData) {
      throw new Error(
        `Recipient ${recipientPubkey.toBase58()} has not initialized their account`,
      );
    }
    const recipientCt = await getEncryptedBalance(recipientPubkey);

    // Encrypt the transfer amount once, reuse for both operations
    const encAmount = await encrypt(amount);

    // ── Homomorphic arithmetic ────────────────────────────────────────────────
    // senderCt and recipientCt are never decrypted during these operations.
    // The sidecar evaluates a + b (or a - b) purely on ciphertexts via ServerKey.
    // Only the resulting values are decrypted inside the sidecar for re-encryption.
    const newSenderCt = await fheSub(senderCt, encAmount);
    const newRecipientCt = recipientCt
      ? await fheAdd(recipientCt, encAmount)
      : encAmount; // recipient has zero balance — amount IS the new balance
    // ─────────────────────────────────────────────────────────────────────────

    console.log(`[transfer] amount=${amount} — homomorphic arithmetic done`);

    await writeEncryptedBalance(senderPubkey, newSenderCt);
    console.log(`[transfer] Sender balance written`);

    await writeEncryptedBalance(recipientPubkey, newRecipientCt);
    console.log(`[transfer] Recipient balance written`);

    opDone(op);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error(`[transfer] Error for ${op.user}: ${msg}`);
    opError(op, msg);
  }
}
