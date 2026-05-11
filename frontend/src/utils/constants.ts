import { PublicKey } from '@solana/web3.js'

export const TOKEN_PROGRAM_ID = new PublicKey('H6TaxPd91m5NMm3t3KSubsBTnMHBJHbaC4B3WhccuY7T')
export const SWAP_PROGRAM_ID = new PublicKey('HyL5r4euova77wUoJVMA7hj8Y2s1jvJr55zSqAB1gvAa')
export const DENOMINATION = 1_000_000_000n // 1 SOL in lamports
export const WORKER_URL = import.meta.env.VITE_WORKER_URL || 'http://localhost:3001'
export const RPC_URL = import.meta.env.VITE_RPC_URL || 'https://api.devnet.solana.com'
