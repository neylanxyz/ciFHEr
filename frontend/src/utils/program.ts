import { AnchorProvider, Program, Idl } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'
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
