import { AnchorProvider, Program, Idl } from '@coral-xyz/anchor'
import { Connection, PublicKey } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, SWAP_PROGRAM_ID } from './constants'
import confidentialTokenIdl from '../idl/confidential_token.json'
import confidentialSwapIdl from '../idl/confidential_swap.json'

export function getTokenProgram(provider: AnchorProvider): Program {
  return new Program(confidentialTokenIdl as Idl, provider)
}

export function getSwapProgram(provider: AnchorProvider): Program {
  return new Program(confidentialSwapIdl as Idl, provider)
}

export function getMintPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('mint')],
    TOKEN_PROGRAM_ID,
  )
}

export function getConfidentialAccountPda(owner: PublicKey): [PublicKey, number] {
  const [mintPda] = getMintPda()
  return PublicKey.findProgramAddressSync(
    [Buffer.from('account'), mintPda.toBuffer(), owner.toBuffer()],
    TOKEN_PROGRAM_ID,
  )
}

export function getSwapPoolPda(mintPubkey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), mintPubkey.toBuffer()],
    SWAP_PROGRAM_ID,
  )
}

let cachedAuthority: PublicKey | null = null

/**
 * Returns the worker authority pubkey by reading it from the SwapPool account.
 * SwapPool layout: discriminator(8) + worker_authority(32) + ...
 * Used to pass the treasury account in fee-bearing instructions.
 */
export async function getWorkerAuthority(connection: Connection): Promise<PublicKey> {
  if (cachedAuthority) return cachedAuthority
  const [mintPda] = getMintPda()
  const [poolPda] = getSwapPoolPda(mintPda)
  const info = await connection.getAccountInfo(poolPda)
  if (!info) throw new Error('Swap pool not found — is the worker running?')
  cachedAuthority = new PublicKey(info.data.slice(8, 40))
  return cachedAuthority
}
