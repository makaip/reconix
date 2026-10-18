import { useEffect, useState } from 'react'
import type { ProxyStatus } from '../../../shared/contracts'

export interface RuntimeStatus {
  /** Configured egress proxy, or `{ address: null }` when none is set. */
  proxy: ProxyStatus
  /** Authorized engagement id from scope.json, or null. */
  engagement: string | null
}

const EMPTY: RuntimeStatus = { proxy: { address: null }, engagement: null }

/** Proxy + engagement status for the status bar. Both are static per run, so a
 *  single mount-time fetch is enough. */
export function useRuntimeStatus(): RuntimeStatus {
  const [status, setStatus] = useState<RuntimeStatus>(EMPTY)

  useEffect(() => {
    let live = true
    void Promise.all([window.reconix.proxy.getStatus(), window.reconix.engagement.get()]).then(
      ([proxy, engagement]) => {
        if (live) setStatus({ proxy: proxy ?? EMPTY.proxy, engagement: engagement ?? null })
      }
    )
    return () => {
      live = false
    }
  }, [])

  return status
}
