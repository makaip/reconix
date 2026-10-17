// Types shared by the main process (tab manager, network capture), preload and renderer.

export type TabInfo = {
  id: number
  /** Page title; empty until the page sets one. */
  title: string
  /** Current URL; empty for a blank tab. */
  url: string
  loading: boolean
}

export type TabsState = {
  tabs: TabInfo[]
  activeId: number | null
  canGoBack: boolean
  canGoForward: boolean
}

export type NavigateResult = { ok: true } | { ok: false; error: string }

export type CapturedRequest = {
  id: string
  tabId: number
  method: string
  url: string
  resourceType: string
  startedAt: number
  statusCode?: number
  fromCache?: boolean
  error?: string
  durationMs?: number
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string[]>
}

export type NetworkStats = {
  total: number
  perTab: Record<number, number>
}
