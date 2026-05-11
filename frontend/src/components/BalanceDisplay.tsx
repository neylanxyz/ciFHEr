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
        <div className="balance-locked">🔒 Connect your wallet to view balance</div>
      </div>
    )
  }

  function formatBalance(b: bigint | null): string {
    if (b === null) return 'Account not initialized'
    // 1 token = 1 denomination unit; display as plain integer
    return `${b.toString()} token${b === 1n ? '' : 's'}`
  }

  return (
    <div className="card">
      <h2>Your Balance</h2>

      <div className="balance-value">
        {loading ? (
          <span className="spinner" aria-label="Loading" />
        ) : balance === undefined ? (
          <span className="balance-placeholder">—</span>
        ) : (
          <span className="balance-amount">{formatBalance(balance)}</span>
        )}
      </div>

      {error && <div className="error-msg">{error}</div>}

      <button className="btn btn-secondary" onClick={handleRefresh} disabled={loading}>
        {loading ? 'Refreshing…' : 'Refresh'}
      </button>

      <p className="note">
        Balance is decrypted by the worker — others see 🔒.
      </p>
    </div>
  )
}
