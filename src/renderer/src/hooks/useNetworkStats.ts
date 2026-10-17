import { useEffect, useState } from 'react'
import type { NetworkStats } from '../../../shared/tabs'

const EMPTY: NetworkStats = { total: 0, perTab: {} }

/** Request counts captured from target pages, in total and per tab. */
export function useNetworkStats(): NetworkStats {
  const [stats, setStats] = useState<NetworkStats>(EMPTY)

  useEffect(() => {
    let live = true
    void window.reconix.network.getStats().then((initial) => {
      if (live && initial) setStats(initial)
    })
    const unsubscribe = window.reconix.network.onStats(setStats)
    return () => {
      live = false
      unsubscribe()
    }
  }, [])

  return stats
}
