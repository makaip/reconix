import { useEffect, useState } from 'react'
import type { CapturedRequest } from '../../../shared/tabs'

/** Captured requests for one tab, kept live via network:requests. Resets when the tab changes. */
export function useNetworkRequests(tabId: number | null): CapturedRequest[] {
  const [requests, setRequests] = useState<CapturedRequest[]>([])

  useEffect(() => {
    setRequests([])
    if (tabId === null) return

    let live = true
    void window.reconix.network.list(tabId).then((initial) => {
      if (live) setRequests(initial)
    })
    const unsubscribe = window.reconix.network.onRequests((all) => {
      setRequests(all.filter((request) => request.tabId === tabId))
    })
    return () => {
      live = false
      unsubscribe()
    }
  }, [tabId])

  return requests
}
