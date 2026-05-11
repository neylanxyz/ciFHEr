import { useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useConfidentialToken } from '../hooks/useConfidentialToken'

export function BalanceDisplay() {
  const { publicKey } = useWallet()
  const { getBalance } = useConfidentialToken()

  const [balance, setBalance] = useState<bigint | null | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleRefresh() {
    setLoading(true)
    setError(null)
    try {
      const b = await getBalance()
      setBalance(b)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  if (!publicKey) {
    return (
      <div className="card">
        <h2>Balance</h2>
        <div className="balance-locked">Connect wallet to view balance</div>
      </div>
    )
  }

  function formatBalance(b: bigint | null): { amount: string; unit: string } {
    if (b === null) return { amount: '—', unit: 'not initialized' }
    return { amount: b.toString(), unit: `cifherSOL` }
  }

  const formatted = balance !== undefined && balance !== null && typeof balance !== 'undefined'
    ? formatBalance(balance as bigint | null)
    : null

  return (
    <div className="card">
      <h2>Your Balance</h2>

      <div className="balance-value">
        {loading ? (
          <span className="spinner" aria-label="Loading" />
        ) : balance === undefined ? (
          <span className="balance-placeholder">—</span>
        ) : (
          <>
            <span className="balance-amount">{formatted?.amount}</span>
            {formatted?.unit && (
              <span className="balance-unit">{formatted.unit}</span>
            )}
          </>
        )}
      </div>

      {error && <div className="error-msg">{error}</div>}

      <button className="btn btn-secondary" onClick={handleRefresh} disabled={loading}>
        {loading ? 'Decrypting…' : 'Decrypt Balance'}
      </button>

      <p className="note">
        Decrypted on demand by the worker. On-chain, your balance is ciphertext.
      </p>
    </div>
  )
}
