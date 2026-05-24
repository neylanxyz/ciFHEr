import { PublicKey } from '@solana/web3.js'

export const TOKEN_PROGRAM_ID = new PublicKey('86C1FkYaVUjV2wyWmRMrnGhXGNNpnH9aFLAJQKkAtf6u')
export const SWAP_PROGRAM_ID = new PublicKey('A2vktybx3Nahc7THvSckeVioTobVkHNEXM5ZteGkoLDK')
export const DENOMINATION = 1_000_000_000n // 1 SOL in lamports
export const WORKER_URL = import.meta.env.VITE_WORKER_URL || 'http://localhost:3001'
export const RPC_URL = import.meta.env.VITE_RPC_URL || 'https://api.devnet.solana.com'
