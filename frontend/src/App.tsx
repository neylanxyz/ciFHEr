import { useMemo, useState } from 'react'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider, WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom'
import { useWallet } from '@solana/wallet-adapter-react'
import '@solana/wallet-adapter-react-ui/styles.css'

import { RPC_URL } from './utils/constants'
import { useConfidentialToken } from './hooks/useConfidentialToken'
import { BalanceDisplay } from './components/BalanceDisplay'
import { TransferPanel } from './components/TransferPanel'
import { SwapPanel } from './components/SwapPanel'
import './App.css'

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
      setInitMessage('Account initialized.')
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
            <span className="logo-text">c<span className="logo-i">ı<span className="logo-asterisk">*</span></span>FHEr</span>
          </div>
          <p className="tagline">Confidential Tokens on Solana</p>
        </div>
        <WalletMultiButton />
      </header>

      <main className="app-main">
        {!publicKey ? (
          <div className="connect-prompt">
            <div className="connect-card">
              <p className="connect-eyebrow">Fully Homomorphic Encryption</p>
              <h2>Connect Your Wallet</h2>
              <p>
                Swap, transfer, and hold confidential tokens. Balances are encrypted
                on-chain — nobody reads them without your key.
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
              <TransferPanel />
              <SwapPanel />
            </div>
          </>
        )}
      </main>

      <footer className="app-footer">
        <p>
          Balances are stored on-chain as FHE ciphertexts — validators and block explorers
          see only encrypted bytes. Only the authorized worker can compute on them.
        </p>
      </footer>
    </div>
  )
}

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
