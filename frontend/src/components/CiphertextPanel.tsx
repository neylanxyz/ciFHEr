import { useState, useEffect, useRef } from 'react'
import './CiphertextPanel.css'

const HEX = '0123456789abcdef'
const COLS = 16
const ROWS = 10
const TOTAL = COLS * ROWS

function randomHex() {
  let s = ''
  for (let i = 0; i < TOTAL; i++) s += HEX[Math.floor(Math.random() * 16)]
  return s
}

export function CiphertextPanel() {
  const [bytes, setBytes] = useState(() => randomHex())
  const frameRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    function tick() {
      setBytes(prev => {
        const arr = prev.split('')
        const count = 3 + Math.floor(Math.random() * 5)
        for (let i = 0; i < count; i++) {
          const idx = Math.floor(Math.random() * TOTAL)
          arr[idx] = HEX[Math.floor(Math.random() * 16)]
        }
        return arr.join('')
      })
      frameRef.current = setTimeout(tick, 80 + Math.random() * 120)
    }
    frameRef.current = setTimeout(tick, 400)
    return () => { if (frameRef.current) clearTimeout(frameRef.current) }
  }, [])

  const rows: string[] = []
  for (let r = 0; r < ROWS; r++) {
    rows.push(bytes.slice(r * COLS, (r + 1) * COLS))
  }

  return (
    <div className="card cipher-card">
      <h3>On-Chain State</h3>
      <h2>What Validators See</h2>

      <div className="cipher-block" aria-hidden="true">
        {rows.map((row, r) => (
          <div key={r} className="cipher-row">
            <span className="cipher-addr">{(r * COLS).toString(16).padStart(4, '0')}</span>
            <span className="cipher-bytes">
              {row.split('').map((c, i) => (
                <span key={i} className="cipher-byte">{c}</span>
              ))}
            </span>
          </div>
        ))}
        <div className="cipher-ellipsis">· · · 16,748 bytes total · · ·</div>
      </div>

      <p className="description">
        Every balance is stored on-chain as an FHE ciphertext. Validators process
        transactions without ever reading the amounts — the encrypted bytes carry
        no information without the worker's secret key.
      </p>
    </div>
  )
}
