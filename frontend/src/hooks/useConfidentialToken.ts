import { useCallback, useEffect, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { AnchorProvider } from '@coral-xyz/anchor'
import { PublicKey, SystemProgram } from '@solana/web3.js'
import BN from 'bn.js'
import {
  getTokenProgram,
  getSwapProgram,
  getMintPda,
  getConfidentialAccountPda,
  getSwapPoolPda,
  getWorkerAuthority,
} from '../utils/program'
import { useFhe } from './useFhe'
import { useAuth } from './useAuth'
import { WORKER_URL } from '../utils/constants'

export function useConfidentialToken() {
  const { connection } = useConnection()
  const wallet = useWallet()
  const { fheReady, fheError } = useFhe()
  const { getToken } = useAuth()
  const [accountExists, setAccountExists] = useState<boolean | null>(null)

  const getProvider = useCallback(() => {
    if (!wallet.publicKey || !wallet.signTransaction || !wallet.signAllTransactions) {
      throw new Error('Wallet not connected')
    }
    return new AnchorProvider(
      connection,
      {
        publicKey: wallet.publicKey,
        signTransaction: wallet.signTransaction,
        signAllTransactions: wallet.signAllTransactions,
      },
      { commitment: 'confirmed' },
    )
  }, [connection, wallet])

  useEffect(() => {
    if (!wallet.publicKey) { setAccountExists(null); return }
    let cancelled = false
    const provider = new AnchorProvider(
      connection,
      { publicKey: wallet.publicKey, signTransaction: wallet.signTransaction!, signAllTransactions: wallet.signAllTransactions! },
      { commitment: 'confirmed' },
    )
    const program = getTokenProgram(provider)
    const [confidentialAccountPda] = getConfidentialAccountPda(wallet.publicKey)
    ;(program.account as any).confidentialAccount
      .fetchNullable(confidentialAccountPda)
      .then((a: unknown) => { if (!cancelled) setAccountExists(a !== null) })
      .catch(() => { if (!cancelled) setAccountExists(false) })
    return () => { cancelled = true }
  }, [wallet.publicKey, connection, wallet.signTransaction, wallet.signAllTransactions])

  const initializeAccount = useCallback(async (): Promise<void> => {
    const provider = getProvider()
    const program = getTokenProgram(provider)
    const owner = provider.wallet.publicKey
    const [mintPda] = getMintPda()
    const [confidentialAccountPda] = getConfidentialAccountPda(owner)
    const existing = await (program.account as any).confidentialAccount.fetchNullable(
      confidentialAccountPda,
    )
    if (existing) { setAccountExists(true); return }
    await program.methods
      .initializeAccount()
      .accounts({
        confidentialMint: mintPda,
        confidentialAccount: confidentialAccountPda,
        owner,
        systemProgram: SystemProgram.programId,
      })
      .rpc()
    setAccountExists(true)
  }, [getProvider])

  const mintRequest = useCallback(async (): Promise<string> => {
    const provider = getProvider()
    const program = getTokenProgram(provider)
    const user = provider.wallet.publicKey
    const [mintPda] = getMintPda()
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), mintPda.toBuffer()],
      program.programId,
    )
    const [userAccountPda] = getConfidentialAccountPda(user)
    return program.methods
      .mintRequest()
      .accounts({
        confidentialMint: mintPda,
        vault: vaultPda,
        userAccount: userAccountPda,
        user,
        systemProgram: SystemProgram.programId,
      })
      .rpc()
  }, [getProvider])

  /**
   * Transfer tokens to a recipient.
   * Posts the transfer intent to the worker first, then submits transfer_request on-chain.
   * The worker handles all FHE: decrypts balances, computes new amounts, writes chunks.
   */
  const transfer = useCallback(
    async (recipientPubkey: string, amount: bigint): Promise<string> => {
      const provider = getProvider()
      const program = getTokenProgram(provider)
      const sender = provider.wallet.publicKey

      // Verify recipient has a confidential account
      const [mintPda] = getMintPda()
      const recipientKey = new PublicKey(recipientPubkey)
      const [receiverAccountPda] = getConfidentialAccountPda(recipientKey)
      const receiverAccount = await (program.account as any).confidentialAccount.fetchNullable(
        receiverAccountPda,
      )
      if (!receiverAccount) {
        throw new Error('Recipient has not initialized their confidential account')
      }

      // Resolve treasury once (cached after first call)
      const treasury = await getWorkerAuthority(connection)

      // Register transfer intent with worker before on-chain tx
      const token = await getToken()
      const intentRes = await fetch(`${WORKER_URL}/transfer-intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          user: sender.toBase58(),
          recipient: recipientPubkey,
          amount: amount.toString(),
        }),
      })
      if (!intentRes.ok) {
        const body = await intentRes.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? 'Failed to register transfer intent')
      }

      return program.methods
        .transferRequest(recipientKey)
        .accounts({
          confidentialMint: mintPda,
          userAccount: (await getConfidentialAccountPda(sender))[0],
          user: sender,
          treasury,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    },
    [getProvider, getToken],
  )

  const burnRequest = useCallback(async (): Promise<string> => {
    const provider = getProvider()
    const program = getTokenProgram(provider)
    const user = provider.wallet.publicKey
    const [mintPda] = getMintPda()
    const [userAccountPda] = getConfidentialAccountPda(user)
    return program.methods
      .burnRequest()
      .accounts({
        confidentialMint: mintPda,
        userAccount: userAccountPda,
        user,
      })
      .rpc()
  }, [getProvider])

  const getBalance = useCallback(async (): Promise<bigint | null> => {
    if (!wallet.publicKey) throw new Error('Wallet not connected')
    const token = await getToken()
    const res = await fetch(`${WORKER_URL}/balance/${wallet.publicKey.toBase58()}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    })
    if (res.status === 404) return null
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      throw new Error(body.error ?? `Worker error: ${res.status}`)
    }
    const { balance } = (await res.json()) as { balance: string }
    return BigInt(balance)
  }, [wallet.publicKey, getToken])

  const swapSolForToken = useCallback(
    async (solAmount: bigint): Promise<string> => {
      const provider = getProvider()
      const swapProg = getSwapProgram(provider)
      const user = provider.wallet.publicKey
      const [mintPda] = getMintPda()
      const [poolPda] = getSwapPoolPda(mintPda)
      const [swapVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('swap_vault'), poolPda.toBuffer()],
        swapProg.programId,
      )
      const treasury = await getWorkerAuthority(connection)
      return swapProg.methods
        .swapSolForToken(new BN(solAmount.toString()))
        .accounts({
          user,
          pool: poolPda,
          swapVault: swapVaultPda,
          treasury,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    },
    [getProvider, connection],
  )

  const swapTokenForSolRequest = useCallback(
    async (tokenAmount: bigint): Promise<string> => {
      const provider = getProvider()
      const swapProg = getSwapProgram(provider)
      const user = provider.wallet.publicKey

      // Register swap intent with worker
      const token = await getToken()
      const intentRes = await fetch(`${WORKER_URL}/swap-intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ user: user.toBase58(), tokenAmount: tokenAmount.toString() }),
      })
      if (!intentRes.ok) {
        const body = await intentRes.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? 'Failed to register swap intent')
      }

      const [mintPda] = getMintPda()
      const [poolPda] = getSwapPoolPda(mintPda)
      return swapProg.methods
        .swapTokenForSolRequest()
        .accounts({ user, pool: poolPda })
        .rpc()
    },
    [getProvider, getToken],
  )

  return {
    fheReady,
    fheError,
    accountExists,
    initializeAccount,
    mintRequest,
    transfer,
    burnRequest,
    getBalance,
    swapSolForToken,
    swapTokenForSolRequest,
  }
}
