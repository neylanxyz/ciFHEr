import { useMemo, useState } from 'react'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider, WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom'
import { useWallet } from '@solana/wallet-adapter-react'
import '@solana/wallet-adapter-react-ui/styles.css'

import { RPC_URL } from './utils/constants'
import { useConfidentialToken } from './hooks/useConfidentialToken'
import { BalanceDisplay } from './components/BalanceDisplay'
import { MintPanel } from './components/MintPanel'
import { TransferPanel } from './components/TransferPanel'
import { SwapPanel } from './components/SwapPanel'
import './App.css'

// Inner component — must be rendered inside WalletProvider.
function AppInner() {
  const { publicKey } = useWallet()
  const { initializeAccount } = useConfidentialToken()

  const [initLoading, setInitLoading] = useState(false)
  const [initMessage, setInitMessage] = useState<string | null>(null)
  const [initError, setInitError] = useState(false)

  async function handleInitAccount() {
    setInitLoading(true)
    setInitError(false)
    setInitMessage('Creating on-chain confidential account…')
    try {
      await initializeAccount()
      setInitMessage('Account initialized successfully!')
    } catch (err) {
      setInitError(true)
      setInitMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setInitLoading(false)
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-content">
          <div className="logo">
            <span className="logo-icon">🔐</span>
            <span className="logo-text">ciFHEr</span>
          </div>
          <p className="tagline">Confidential Tokens on Solana</p>
        </div>
        <WalletMultiButton />
      </header>

      <main className="app-main">
        {!publicKey ? (
          <div className="connect-prompt">
            <div className="connect-card">
              <div className="connect-icon">🔒</div>
              <h2>Connect Your Wallet</h2>
              <p>
                Connect your Phantom wallet to mint, transfer, and swap confidential
                tokens powered by Fully Homomorphic Encryption.
              </p>
              <WalletMultiButton />
            </div>
          </div>
        ) : (
          <>
            <div className="init-section">
              <div className="card init-card">
                <h2>First Time?</h2>
                <p className="description">
                  Create your on-chain confidential account before using any token
                  features. You only need to do this once.
                </p>
                <button
                  className="btn btn-outline"
                  onClick={handleInitAccount}
                  disabled={initLoading}
                >
                  {initLoading ? 'Initializing…' : 'Initialize Account'}
                </button>
                {initMessage && (
                  <div
                    className={`status-msg ${initError ? 'status-error' : 'status-fulfilled'}`}
                  >
                    {initMessage}
                  </div>
                )}
              </div>
            </div>

            <div className="grid">
              <BalanceDisplay />
              <MintPanel />
              <TransferPanel />
              <SwapPanel />
            </div>
          </>
        )}
      </main>

      <footer className="app-footer">
        <p>
          Balances are encrypted on-chain via FHE — only the authorized worker can
          compute on them. Your balance is decrypted for you by the worker on demand.
        </p>
      </footer>
    </div>
  )
}

// Root component — sets up wallet and connection providers.
export default function App() {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], [])

  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <AppInner />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}
