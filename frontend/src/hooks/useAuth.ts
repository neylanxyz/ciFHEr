import { useCallback, useRef } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { WORKER_URL } from '../utils/constants'

interface CachedToken {
  token: string
  pubkey: string
  expiry: number
}

// Module-level cache: survives re-renders, cleared on page reload (intentional)
let cache: CachedToken | null = null

const REFRESH_BEFORE_MS = 5 * 60 * 1000 // re-auth 5 min before expiry

export function useAuth() {
  const { publicKey, signMessage } = useWallet()
  const inflightRef = useRef<Promise<string> | null>(null)

  const getToken = useCallback(async (): Promise<string> => {
    if (!publicKey || !signMessage) throw new Error('Wallet not connected')

    const pubkeyStr = publicKey.toBase58()

    // Return cached token if still fresh
    if (cache && cache.pubkey === pubkeyStr && cache.expiry > Date.now() + REFRESH_BEFORE_MS) {
      return cache.token
    }

    // Deduplicate concurrent calls (e.g. balance + intent at the same time)
    if (inflightRef.current) return inflightRef.current

    const authPromise = (async () => {
      const timestamp = Date.now()
      const messageText = `ciFHEr auth\npubkey: ${pubkeyStr}\ntimestamp: ${timestamp}`
      const message = new TextEncoder().encode(messageText)

      const signature = await signMessage(message)

      const res = await fetch(`${WORKER_URL}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pubkey: pubkeyStr,
          message: Buffer.from(message).toString('base64'),
          signature: Buffer.from(signature).toString('base64'),
        }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? 'Auth failed')
      }

      const { token } = (await res.json()) as { token: string }
      cache = { token, pubkey: pubkeyStr, expiry: Date.now() + 4 * 60 * 60 * 1000 }
      return token
    })()

    inflightRef.current = authPromise
    authPromise.finally(() => { inflightRef.current = null })
    return authPromise
  }, [publicKey, signMessage])

  return { getToken }
}
