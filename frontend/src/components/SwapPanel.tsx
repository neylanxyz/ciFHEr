import { useState, useEffect, useRef } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useConfidentialToken } from '../hooks/useConfidentialToken'
import { useWorkerBusy } from '../hooks/useWorkerBusy'
import { WORKER_URL } from '../utils/constants'

export function SwapPanel() {
  const { publicKey: walletKey } = useWallet()
  const { swapSolForToken, swapTokenForSolRequest } = useConfidentialToken()
  const { workerBusy, beginWorkerTask, endWorkerTask } = useWorkerBusy()

  const solPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  function clearSolPoll() {
    if (solPollRef.current !== null) { clearInterval(solPollRef.current); solPollRef.current = null }
  }
  useEffect(() => () => clearSolPoll(), [])

  // SOL → Token
  const [solAmount, setSolAmount] = useState('')
  const [solMessage, setSolMessage] = useState<string | null>(null)
  const [solError, setSolError] = useState(false)
  const [solTxSig, setSolTxSig] = useState<string | null>(null)

  // Token → SOL
  const [tokenAmount, setTokenAmount] = useState('')
  const [tokenMessage, setTokenMessage] = useState<string | null>(null)
  const [tokenError, setTokenError] = useState(false)
  const [tokenTxSig, setTokenTxSig] = useState<string | null>(null)

  async function handleSolForToken(e: React.FormEvent) {
    e.preventDefault()
    if (!walletKey || workerBusy) return

    const lamports = BigInt(Math.round(parseFloat(solAmount) * 1e9))
    if (lamports <= 0n) {
      setSolError(true)
      setSolMessage('SOL amount must be greater than zero.')
      return
    }

    beginWorkerTask('Processing SOL → cifherSOL swap — waiting for worker to encrypt balance')
    setSolError(false)
    setSolMessage('Submitting swap transaction…')
    setSolTxSig(null)

    try {
      const sig = await swapSolForToken(lamports)
      setSolTxSig(sig)
      setSolMessage('Transaction confirmed — worker is encrypting your balance…')
      setSolAmount('')

      solPollRef.current = setInterval(async () => {
        try {
          const res = await fetch(`${WORKER_URL}/status/${walletKey.toBase58()}`)
          if (!res.ok) return
          const data = await res.json() as { ops: Array<{ type: string; status: string; error?: string }> }
          const op = data.ops.find(o => o.type === 'swap_sol_for_token')
          if (!op) return
          if (op.status === 'done') {
            clearSolPoll()
            endWorkerTask()
            setSolMessage('Swap fulfilled. Tokens added to encrypted balance.')
          } else if (op.status === 'error') {
            clearSolPoll()
            endWorkerTask()
            setSolError(true)
            setSolMessage(`Worker error: ${op.error ?? 'unknown'}`)
          }
        } catch { /* network blip */ }
      }, 2000)
    } catch (err) {
      clearSolPoll()
      endWorkerTask()
      setSolError(true)
      setSolMessage(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleTokenForSol(e: React.FormEvent) {
    e.preventDefault()
    if (!walletKey || workerBusy) return

    const parsed = BigInt(Math.round(parseFloat(tokenAmount)))
    if (parsed <= 0n) {
      setTokenError(true)
      setTokenMessage('Amount must be greater than zero.')
      return
    }

    beginWorkerTask('Processing cifherSOL → SOL redemption — FHE computation may take up to 30s')
    setTokenError(false)
    setTokenMessage('Registering swap intent…')
    setTokenTxSig(null)

    try {
      const sig = await swapTokenForSolRequest(parsed)
      setTokenTxSig(sig)
      setTokenMessage(`Request submitted. Worker will send SOL shortly.`)
      setTokenAmount('')
    } catch (err) {
      setTokenError(true)
      setTokenMessage(err instanceof Error ? err.message : String(err))
    } finally {
      endWorkerTask()
    }
  }

  function explorerUrl(sig: string) {
    return `https://explorer.solana.com/tx/${sig}?cluster=devnet`
  }

  return (
    <div className="card">
      <h2>Swap</h2>

      <div className="swap-section">
        <h3>SOL → cifherSOL</h3>
        <p className="description">
          Deposit SOL; the worker credits encrypted tokens to your balance.
        </p>
        <form onSubmit={handleSolForToken} className="form">
          <label className="field">
            <span>Amount (SOL)</span>
            <input
              type="number"
              placeholder="0.0"
              min="0.000000001"
              step="any"
              value={solAmount}
              onChange={(e) => setSolAmount(e.target.value)}
              required
              disabled={workerBusy}
            />
          </label>

          <button
            type="submit"
            className="btn btn-primary"
            disabled={!walletKey || workerBusy || !solAmount}
          >
            {workerBusy ? <><span className="spinner" /> Working…</> : 'Swap'}
          </button>
        </form>

        {solMessage && (
          <div className={`status-msg ${solError ? 'status-error' : workerBusy ? 'status-pending' : 'status-fulfilled'}`}>
            {workerBusy && !solError && <span className="spinner" />}
            {solMessage}
          </div>
        )}
        {solTxSig && (
          <div className="explorer-link">
            <a href={explorerUrl(solTxSig)} target="_blank" rel="noopener noreferrer">
              View on Solana Explorer ↗
            </a>
          </div>
        )}
      </div>

      <div className="swap-divider" />

      <div className="swap-section">
        <h3>cifherSOL → SOL</h3>
        <p className="description">
          Redeem tokens for SOL. Worker decrypts your balance, sends SOL, and
          updates the remaining ciphertext.
        </p>

        <form onSubmit={handleTokenForSol} className="form">
          <label className="field">
            <span>Amount (cifherSOL)</span>
            <input
              type="number"
              placeholder="1"
              min="1"
              step="1"
              value={tokenAmount}
              onChange={(e) => setTokenAmount(e.target.value)}
              required
              disabled={workerBusy}
            />
          </label>

          <button
            type="submit"
            className="btn btn-secondary"
            disabled={!walletKey || workerBusy || !tokenAmount}
          >
            {workerBusy ? <><span className="spinner" /> Working…</> : 'Redeem'}
          </button>
        </form>

        {tokenMessage && (
          <div className={`status-msg ${tokenError ? 'status-error' : workerBusy ? 'status-pending' : 'status-fulfilled'}`}>
            {workerBusy && !tokenError && <span className="spinner" />}
            {tokenMessage}
          </div>
        )}
        {tokenTxSig && (
          <div className="explorer-link">
            <a href={explorerUrl(tokenTxSig)} target="_blank" rel="noopener noreferrer">
              View on Solana Explorer ↗
            </a>
          </div>
        )}
      </div>

      {!walletKey && <p className="note">Connect your wallet to swap.</p>}
    </div>
  )
}
