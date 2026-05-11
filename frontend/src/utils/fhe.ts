/**
 * Minimal FHE stub for the frontend.
 *
 * All FHE operations (encrypt, decrypt, arithmetic) are performed by the
 * worker. The frontend never handles raw ciphertexts — it only calls REST
 * endpoints and submits on-chain instructions that carry no ciphertext data.
 *
 * This module is kept for forward-compatibility in case client-side
 * encryption is added in a future iteration.
 */

export async function initFhe(_publicKeyBytes: Uint8Array): Promise<void> {
  // No-op: frontend encryption removed; worker handles all FHE.
}
