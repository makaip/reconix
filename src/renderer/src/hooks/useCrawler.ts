import { useEffect, useState } from 'react'
import type { CrawlStartInput, CrawlState } from '../../../shared/crawler'

const EMPTY: CrawlState = { running: false, startUrl: null, visited: 0, queued: 0, pages: [] }

export type CrawlerApi = {
  state: CrawlState
  start: (input: CrawlStartInput) => void
  stop: () => void
}

/** Drives the main-process spider and tracks its live state over crawl:state. */
export function useCrawler(): CrawlerApi {
  const [state, setState] = useState<CrawlState>(EMPTY)

  useEffect(() => {
    let live = true
    void window.reconix.crawler.getState().then((s) => {
      if (live) setState(s)
    })
    const unsubscribe = window.reconix.crawler.onState((s) => setState(s))
    return () => {
      live = false
      unsubscribe()
    }
  }, [])

  return {
    state,
    start: (input) => void window.reconix.crawler.start(input).then(setState),
    stop: () => void window.reconix.crawler.stop().then(setState)
  }
}
