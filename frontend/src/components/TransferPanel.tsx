import { useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useConfidentialToken } from '../hooks/useConfidentialToken'

export function TransferPanel() {
  const { publicKey } = useWallet()
  const { transfer, fheReady } = useConfidentialToken()

  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [isError, setIsError] = useState(false)
  const [txSig, setTxSig] = useState<string | null>(null)

  async function handleTransfer(e: React.FormEvent) {
    e.preventDefault()
    if (!publicKey || !fheReady) return

    const parsedAmount = BigInt(Math.round(parseFloat(amount)))
    if (parsedAmount <= 0n) {
      setIsError(true)
      setMessage('Amount must be greater than zero.')
      return
    }

    setLoading(true)
    setIsError(false)
    setMessage('Homomorphic transfer in progress…')
    setTxSig(null)

    try {
      const sig = await transfer(recipient.trim(), parsedAmount)
      setTxSig(sig)
      setMessage('Transfer complete.')
      setRecipient('')
      setAmount('')
    } catch (err) {
      setIsError(true)
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const explorerLink = txSig
    ? `https://explorer.solana.com/tx/${txSig}?cluster=devnet`
    : null

  return (
    <div className="card">
      <h2>Transfer</h2>
      <p className="description">
        Send tokens. The worker computes new balances homomorphically — neither
        sender nor recipient balance is decrypted during the operation.
      </p>

      <form onSubmit={handleTransfer} className="form">
        <label className="field">
          <span>Recipient</span>
          <input
            type="text"
            placeholder="Base-58 public key"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            required
            disabled={loading}
          />
        </label>

        <label className="field">
          <span>Amount</span>
          <input
            type="number"
            placeholder="1"
            min="1"
            step="1"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            disabled={loading}
          />
        </label>

        <button
          type="submit"
          className="btn btn-primary"
          disabled={!publicKey || !fheReady || loading || !recipient || !amount}
        >
          {loading ? 'Transferring…' : 'Transfer'}
        </button>

        {!fheReady && publicKey && (
          <p className="note warning">FHE module loading — please wait…</p>
        )}
      </form>

      {message && (
        <div className={`status-msg ${isError ? 'status-error' : 'status-fulfilled'}`}>
          {message}
        </div>
      )}

      {explorerLink && (
        <div className="explorer-link">
          <a href={explorerLink} target="_blank" rel="noopener noreferrer">
            View on Solana Explorer ↗
          </a>
        </div>
      )}

      {!publicKey && (
        <p className="note">Connect your wallet to transfer.</p>
      )}
    </div>
  )
}
