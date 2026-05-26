import { useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useConfidentialToken } from '../hooks/useConfidentialToken'
import { useWorkerBusy } from '../hooks/useWorkerBusy'

export function BalanceDisplay() {
  const { publicKey } = useWallet()
  const { getBalance } = useConfidentialToken()
  const { workerBusy, beginWorkerTask, endWorkerTask } = useWorkerBusy()

  const [balance, setBalance] = useState<bigint | null | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleRefresh() {
    beginWorkerTask('Decrypting balance')
    setLoading(true)
    setError(null)
    try {
      const b = await getBalance()
      setBalance(b)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
      endWorkerTask()
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

  const formatted = balance !== undefined && balance !== null
    ? formatBalance(balance as bigint | null)
    : null

  return (
    <div className="card">
      <h2>Your Balance</h2>

      <div className="balance-value">
        {workerBusy && !loading ? (
          <span className="balance-placeholder">—</span>
        ) : loading ? (
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

      {!workerBusy && error && <div className="error-msg">{error}</div>}

      <button
        className="btn btn-secondary"
        onClick={handleRefresh}
        disabled={workerBusy}
      >
        {loading ? 'Decrypting…' : 'Decrypt Balance'}
      </button>

      <p className="note">
        {workerBusy
          ? 'Balance unavailable while worker is processing.'
          : 'Decrypted on demand by the worker. On-chain, your balance is ciphertext.'}
      </p>
    </div>
  )
}
