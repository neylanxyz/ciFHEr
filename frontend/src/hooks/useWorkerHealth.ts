import { useState, useEffect } from 'react'
import { WORKER_URL } from '../utils/constants'

export function useWorkerHealth() {
  const [online, setOnline] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`${WORKER_URL}/health`, { signal: AbortSignal.timeout(4000) })
      .then(r => { if (!cancelled) setOnline(r.ok) })
      .catch(() => { if (!cancelled) setOnline(false) })
    return () => { cancelled = true }
  }, [])

  return online
}
