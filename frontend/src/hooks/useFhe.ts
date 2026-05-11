import { useState, useEffect } from 'react'
import { WORKER_URL } from '../utils/constants'

/**
 * Checks that the worker is reachable and the FHE subsystem is initialized.
 * The frontend itself performs no FHE operations — all encryption/decryption
 * is handled by the trusted worker.
 */
export function useFhe() {
  const [fheReady, setFheReady] = useState(false)
  const [fheError, setFheError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`${WORKER_URL}/health`)
      .then((res) => {
        if (!res.ok) throw new Error(`Worker health check failed: ${res.status}`)
        return res.json()
      })
      .then(() => {
        if (!cancelled) setFheReady(true)
      })
      .catch((err) => {
        if (!cancelled) setFheError(err instanceof Error ? err.message : String(err))
      })
    return () => { cancelled = true }
  }, [])

  return { fheReady, fheError }
}
