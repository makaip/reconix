import { BrowserWindow, ipcMain, session } from 'electron'
import type { CapturedRequest, NetworkStats } from '../shared/tabs'
import { TARGET_PARTITION, type TabManager } from './tabs'

const MAX_REQUESTS = 2000
const BROADCAST_LIMIT = 200
const STATS_THROTTLE_MS = 150

export type NetworkCapture = {
  /** Drops everything captured for a tab that was closed. */
  forgetTab: (tabId: number) => void
}

/**
 * Records requests made by target pages via the session's webRequest hooks. This sees
 * URLs, methods, headers, status and timing, but not response bodies.
 */
export function startNetworkCapture(win: BrowserWindow, tabs: TabManager): NetworkCapture {
  const { webRequest } = session.fromPartition(TARGET_PARTITION)
  const requests = new Map<string, CapturedRequest>()
  let statsTimer: NodeJS.Timeout | null = null

  const stats = (): NetworkStats => {
    const perTab: Record<number, number> = {}
    for (const request of requests.values()) perTab[request.tabId] = (perTab[request.tabId] ?? 0) + 1
    return { total: requests.size, perTab }
  }

  // Matches network:list's cap: most recent 200 across all tabs, in request-start order.
  const recentRequests = (): CapturedRequest[] => [...requests.values()].slice(-BROADCAST_LIMIT)

  // One throttled broadcast for both the aggregate counts (status bar) and the full
  // request list (Network panel) — callers don't need to know which one changed.
  const scheduleBroadcast = (): void => {
    if (statsTimer) return
    statsTimer = setTimeout(() => {
      statsTimer = null
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('network:stats', stats())
        win.webContents.send('network:requests', recentRequests())
      }
    }, STATS_THROTTLE_MS)
  }

  const tabIdOf = (webContentsId: number | undefined): number | undefined =>
    webContentsId === undefined ? undefined : tabs.tabIdFor(webContentsId)

  webRequest.onBeforeRequest((details, callback) => {
    callback({})
    const tabId = tabIdOf(details.webContentsId)
    if (tabId === undefined) return
    // A redirect reuses the request id, so the entry reflects the latest hop.
    requests.set(String(details.id), {
      id: String(details.id),
      tabId,
      method: details.method,
      url: details.url,
      resourceType: details.resourceType,
      startedAt: details.timestamp
    })
    if (requests.size > MAX_REQUESTS) {
      const oldest = requests.keys().next().value
      if (oldest !== undefined) requests.delete(oldest)
    }
    scheduleBroadcast()
  })

  webRequest.onBeforeSendHeaders((details, callback) => {
    callback({ requestHeaders: details.requestHeaders })
    const entry = requests.get(String(details.id))
    if (entry) entry.requestHeaders = details.requestHeaders
    // headers alone aren't shown in the request list, so no broadcast needed here
  })

  webRequest.onCompleted((details) => {
    const entry = requests.get(String(details.id))
    if (!entry) return
    entry.statusCode = details.statusCode
    entry.fromCache = details.fromCache
    entry.responseHeaders = details.responseHeaders
    entry.durationMs = Math.max(0, Math.round(details.timestamp - entry.startedAt))
    scheduleBroadcast()
  })

  webRequest.onErrorOccurred((details) => {
    const entry = requests.get(String(details.id))
    if (entry) entry.error = details.error
    scheduleBroadcast()
  })

  const handle = (channel: string, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, ...args) => (event.sender === win.webContents ? fn(...args) : null))
  }
  handle('network:get-stats', () => stats())
  handle('network:list', (tabId) =>
    [...requests.values()].filter((r) => typeof tabId !== 'number' || r.tabId === tabId).slice(-200)
  )

  win.on('closed', () => {
    if (statsTimer) clearTimeout(statsTimer)
    ipcMain.removeHandler('network:get-stats')
    ipcMain.removeHandler('network:list')
    webRequest.onBeforeRequest(null)
    webRequest.onBeforeSendHeaders(null)
    webRequest.onCompleted(null)
    webRequest.onErrorOccurred(null)
  })

  return {
    forgetTab: (tabId) => {
      for (const [id, request] of requests) if (request.tabId === tabId) requests.delete(id)
      scheduleBroadcast()
    }
  }
}
