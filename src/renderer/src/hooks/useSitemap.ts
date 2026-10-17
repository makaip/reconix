import { useEffect, useMemo, useState } from 'react'
import type { CapturedRequest } from '../../../shared/tabs'
import { buildSitemap, type SitemapNode } from '../lib/sitemap'

/** Passive sitemap across all tabs, rebuilt as the capture list changes. No new fetches. */
export function useSitemap(): SitemapNode[] {
  const [requests, setRequests] = useState<CapturedRequest[]>([])

  useEffect(() => {
    let live = true
    void window.reconix.network.list().then((initial) => {
      if (live) setRequests(initial)
    })
    const unsubscribe = window.reconix.network.onRequests((all) => setRequests(all))
    return () => {
      live = false
      unsubscribe()
    }
  }, [])

  return useMemo(() => buildSitemap(requests), [requests])
}
