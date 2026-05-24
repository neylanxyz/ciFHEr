import { useEffect } from 'react'
import './Landing.css'

const ROWS = [
  'a028 3f9c 7b14 e2d5  8b3a ff01 c742 9e13  f8a2 4d6b 1e9f 85c3  6a7d b291 0c4e 73f5  2817 9a4c',
  '4f2a 8d91 c63e 5b07  9f4e a183 2c76 d05b  e4a9 1f83 7c2d b560  1a9e 4f73 8c2b d614  3d8a f201',
  '8a1d 6f42 9c3e b570  2f8c 1a94 7d3b e6c2  b391 5e2a 8f47 c16d  0f9b 3c74 a285 1e6f  7c4d 9a02',
  '3f81 b5e4 4c9e 2817  6f3a d0b1 5c7a 2f94  b018 3d6e a742 9c1f  8b3d 5e20 f1a8 4c93  7d2e b605',
  'c29f 4e1a 8372 5d0b  f641 9e73 2c8a 1b5d  07e4 a918 3f62 d4b0  9c5e 2817 4f3a d0b6  1e8a 4f72',
]

const CIPHER_BG = Array.from({ length: 140 }, (_, i) => ROWS[i % ROWS.length]).join('\n')

const CIPHER_SAMPLE = `a028 3f9c 7b14 e2d5 8b3a ff01 c742 9e13 f8a2 4d6b
1e9f 85c3 6a7d b291 0c4e 73f5 2817 9a4c d3e8 6b15
4f2a 8d91 c63e 5b07 9f4e a183 2c76 d05b e4a9 1f83
7c2d b560 1a9e 4f73 8c2b d614 3d8a f201 7e94 c5b3
8a1d 6f42 9c3e b570 2f8c 1a94 7d3b e6c2 b391 5e2a
8f47 c16d 0f9b 3c74 a285 1e6f 7c4d 9a02 3f81 b5e4
4c9e 2817 6f3a d0b1 5c7a 2f94 b018 3d6e a742 9c1f
8b3d 5e20 f1a8 4c93 7d2e b605 3e9f 1b47 6a8c d250`

const STEPS = [
  {
    n: '01',
    title: 'Swap SOL for cifherSOL',
    body: 'Deposit SOL and receive confidential tokens, pegged 1:1. Your balance is encrypted the moment it lands on-chain.',
  },
  {
    n: '02',
    title: 'Transfer privately',
    body: 'Send tokens to anyone on Solana. The amount is invisible — to validators, to block explorers, to everyone but you.',
  },
  {
    n: '03',
    title: 'Your balance stays hidden',
    body: 'Every transaction updates your balance without ever exposing it. The arithmetic runs on the encrypted data directly. No plaintext, ever.',
  },
  {
    n: '04',
    title: 'Swap back anytime',
    body: 'Redeem cifherSOL for SOL at any time, 1:1. The peg is enforced by the program — not by trust.',
  },
]

export function Landing() {
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => entries.forEach(e => {
        if (e.isIntersecting) e.target.classList.add('visible')
      }),
      { threshold: 0.08 }
    )
    document.querySelectorAll('.reveal').forEach(el => observer.observe(el))
    return () => observer.disconnect()
  }, [])

  return (
    <div className="landing">

      {/* ── HERO ── */}
      <section className="l-hero">
        <div className="l-cipher-bg" aria-hidden="true">
          <pre>{CIPHER_BG}</pre>
        </div>
        <div className="l-hero-inner">
          <p className="l-hero-label">Confidential tokens on Solana</p>
          <h1 className="l-hero-wordmark">
            c<span className="l-logo-i">ı<span className="l-logo-dot">*</span></span>FHEr
          </h1>
          <p className="l-hero-tagline">Your balance. Nobody else's business.</p>
          <p className="l-hero-sub">Swap, transfer, and hold SOL-backed tokens with fully encrypted balances.</p>
          <a href="/app" className="l-btn-launch">Launch App</a>
        </div>
        <div className="l-scroll-hint" aria-hidden="true">↓</div>
      </section>

      {/* ── THE CIPHER ── */}
      <section className="l-section reveal">
        <div className="l-container">
          <p className="l-eyebrow">what others see</p>
          <h2 className="l-heading">This is your balance, on-chain.</h2>
          <div className="l-cipher-block">
            <pre className="l-cipher-code">{CIPHER_SAMPLE}</pre>
          </div>
          <p className="l-body-text">
            Unreadable noise — to validators, block explorers, and anyone watching
            the chain. Not hidden behind a middleman. Not obscured by routing.
            Mathematically encrypted, on-chain, at rest.
          </p>
        </div>
      </section>

      {/* ── DIFFERENT FROM EVERYTHING ELSE ── */}
      <section className="l-section l-section--alt reveal">
        <div className="l-container">
          <p className="l-eyebrow">a different kind of privacy</p>
          <h2 className="l-heading">Most privacy tools hide the sender. We hide the amount.</h2>
          <div className="l-compare">
            <div className="l-compare-panel">
              <p className="l-compare-label">Other privacy solutions</p>
              <p className="l-compare-text">
                Mixers, shielded pools, and ZK rollups obscure <em>who</em> sent what —
                but the amounts still exist somewhere in plaintext, and
                the privacy breaks the moment funds touch a normal wallet.
              </p>
            </div>
            <div className="l-compare-vs" aria-hidden="true">vs</div>
            <div className="l-compare-panel l-compare-panel--lit">
              <p className="l-compare-label">ciFHEr</p>
              <p className="l-compare-text">
                Your balance is never in plaintext — not on-chain, not during
                a transfer, not anywhere. The math happens directly on encrypted
                data. There is nothing to leak.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ── */}
      <section className="l-section reveal">
        <div className="l-container">
          <p className="l-eyebrow">how it works</p>
          <h2 className="l-heading">Simple to use. Impossible to read.</h2>
          <div className="l-steps">
            {STEPS.map(step => (
              <div className="l-step" key={step.n}>
                <span className="l-step-n">{step.n}</span>
                <div className="l-step-body">
                  <p className="l-step-title">{step.title}</p>
                  <p className="l-step-text">{step.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FINAL CTA ── */}
      <section className="l-section l-cta reveal">
        <div className="l-container l-container--center">
          <h2 className="l-cta-headline">Your balance. Encrypted. Always.</h2>
          <p className="l-cta-sub">Solana · SOL-backed · 1:1 peg</p>
          <a href="/app" className="l-btn-launch l-btn-launch--large">Launch App</a>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer className="l-footer">
        <p>ciFHEr · Devnet · 2026</p>
        <div className="l-footer-links">
          <a href="/docs">Docs</a>
          <a
            href="https://github.com/neylanxyz/ciFHEr"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub ↗
          </a>
        </div>
      </footer>

    </div>
  )
}
