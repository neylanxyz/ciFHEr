import { useState, useEffect, useRef } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useConfidentialToken } from '../hooks/useConfidentialToken'
import { WORKER_URL } from '../utils/constants'

type MintStatus = 'idle' | 'submitting' | 'pending' | 'fulfilled' | 'error'


export function MintPanel() {
  const { publicKey } = useWallet()
  const { mintRequest } = useConfidentialToken()

  const [status, setStatus] = useState<MintStatus>('idle')
  const [txSig, setTxSig] = useState<string | null>(null)
  const [message, setMessage] = useState<string>('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  function clearPoll() {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  useEffect(() => () => clearPoll(), [])

  async function handleMint() {
    if (!publicKey) return
    setStatus('submitting')
    setMessage('Sending mint request…')
    setTxSig(null)

    try {
      const sig = await mintRequest()
      setTxSig(sig)
      setStatus('pending')
      setMessage('Transaction confirmed. Waiting for worker…')

      pollRef.current = setInterval(async () => {
        try {
          const res = await fetch(`${WORKER_URL}/status/${publicKey.toBase58()}`)
          if (!res.ok) return

          const data = await res.json() as { ops: Array<{ type: string; status: string; error?: string }> }
          const mintOp = data.ops.find(op => op.type === 'mint')

          if (!mintOp) return
          if (mintOp.status === 'done') {
            clearPoll()
            setStatus('fulfilled')
            setMessage('Mint fulfilled. Encrypted balance updated.')
          } else if (mintOp.status === 'error') {
            clearPoll()
            setStatus('error')
            setMessage(`Worker error: ${mintOp.error ?? 'unknown'}`)
          }
        } catch {
          // network blip
        }
      }, 2000)
    } catch (err) {
      clearPoll()
      setStatus('error')
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }

  const explorerLink = txSig
    ? `https://explorer.solana.com/tx/${txSig}?cluster=devnet`
    : null

  return (
    <div className="card">
      <h2>Mint Token</h2>
      <p className="description">Lock 1 SOL in escrow. Receive 1 encrypted cifherSOL.</p>

      <button
        className="btn btn-primary"
        onClick={handleMint}
        disabled={!publicKey || status === 'submitting' || status === 'pending'}
      >
        {status === 'submitting' || status === 'pending'
          ? 'Processing…'
          : 'Mint 1 cifherSOL'}
      </button>

      {message && (
        <div className={`status-msg status-${status}`}>
          {(status === 'submitting' || status === 'pending') && (
            <span className="spinner" aria-label="Loading" />
          )}
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
        <p className="note">Connect your wallet to mint.</p>
      )}
    </div>
  )
}
