import { BrowserWindow, ipcMain } from 'electron'
import type { Replayer } from './replay'
import { extractLinks } from '../shared/crawler'
import type {
  CrawlPageResult,
  CrawlStartInput,
  CrawlState,
  CrawlStopReason
} from '../shared/crawler'
import type { ReplayResult } from '../shared/tabs'

const DEFAULT_MAX_DEPTH = 2
const DEFAULT_MAX_PAGES = 50
const MAX_MAX_DEPTH = 10
const MAX_MAX_PAGES = 500
// Pause between fetches so a crawl never outpaces the replayer's per-host rate limit
// (default 1 req/s). A rate-limited result is retried a few times before the URL is skipped.
const FETCH_SPACING_MS = 1100
const RATE_RETRY_LIMIT = 3

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function validate(raw: unknown): CrawlStartInput | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.url !== 'string') return null
  let url: URL
  try {
    url = new URL(r.url)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (r.maxDepth !== undefined && (typeof r.maxDepth !== 'number' || !Number.isFinite(r.maxDepth))) {
    return null
  }
  if (r.maxPages !== undefined && (typeof r.maxPages !== 'number' || !Number.isFinite(r.maxPages))) {
    return null
  }
  if (r.includeResources !== undefined && typeof r.includeResources !== 'boolean') return null
  return {
    url: url.toString(),
    maxDepth: r.maxDepth as number | undefined,
    maxPages: r.maxPages as number | undefined,
    includeResources: r.includeResources as boolean | undefined
  }
}

const sameOrigin = (a: string, b: string): boolean => {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

const isHtml = (result: Extract<ReplayResult, { ok: true }>): boolean => {
  const ct = result.headers['content-type'] ?? result.headers['Content-Type'] ?? ''
  // Empty content-type is treated as HTML so link extraction still runs on terse servers.
  return ct === '' || ct.includes('text/html') || ct.includes('application/xhtml')
}

export type Crawler = { close: () => void }

/** Reusable, window-independent crawl engine (ARCHITECTURE.MD §11.4). */
export interface CrawlCore {
  start(raw: unknown): CrawlState
  stop(): CrawlState
  getState(): CrawlState
  onUpdate(cb: (state: CrawlState) => void): void
}

export function createCrawlCore(replayer: Replayer): CrawlCore {
  let state: CrawlState = { running: false, startUrl: null, visited: 0, queued: 0, pages: [] }
  // Incremented on every start/stop; an in-flight loop checks it to bail when superseded.
  let runToken = 0
  let listener: ((state: CrawlState) => void) | undefined

  const broadcast = (): void => {
    listener?.(state)
  }

  const finish = (reason: CrawlStopReason): void => {
    state = { ...state, running: false, queued: 0, stoppedReason: reason }
    broadcast()
  }

  // Fetches one URL through the replayer, retrying only the rate-limited case.
  const fetchPage = async (url: string, token: number): Promise<ReplayResult | null> => {
    for (let attempt = 0; attempt <= RATE_RETRY_LIMIT; attempt++) {
      if (token !== runToken) return null
      const result = await replayer({ method: 'GET', url })
      if (!(result.ok === false && result.reason === 'rate-limited')) return result
      await delay(FETCH_SPACING_MS)
    }
    return { ok: false, reason: 'rate-limited', error: 'rate limit exceeded' }
  }

  const run = async (input: CrawlStartInput, token: number): Promise<void> => {
    const maxDepth = clamp(Math.floor(input.maxDepth ?? DEFAULT_MAX_DEPTH), 0, MAX_MAX_DEPTH)
    const maxPages = clamp(Math.floor(input.maxPages ?? DEFAULT_MAX_PAGES), 1, MAX_MAX_PAGES)
    const includeResources = input.includeResources ?? false

    const visited = new Set<string>()
    const queue: { url: string; depth: number }[] = [{ url: input.url, depth: 0 }]
    const pages: CrawlPageResult[] = []

    while (queue.length > 0) {
      if (token !== runToken) return // superseded by a new start/stop
      if (pages.length >= maxPages) {
        finish('max-pages')
        return
      }
      const { url, depth } = queue.shift()!
      if (visited.has(url)) continue
      visited.add(url)

      const result = await fetchPage(url, token)
      if (token !== runToken) return
      if (result === null) return

      const page: CrawlPageResult = result.ok
        ? { url, depth, status: result.status }
        : { url, depth, status: null, reason: result.reason }
      if (result.ok && !isHtml(result)) page.reason = 'non-html'
      pages.push(page)

      if (result.ok && isHtml(result) && depth < maxDepth) {
        for (const candidate of extractLinks(result.body, url, { includeResources })) {
          if (!visited.has(candidate.url) && sameOrigin(candidate.url, input.url)) {
            queue.push({ url: candidate.url, depth: depth + 1 })
          }
        }
      }

      state = {
        running: true,
        startUrl: input.url,
        visited: visited.size,
        queued: queue.length,
        pages: [...pages]
      }
      broadcast()
      if (queue.length > 0) await delay(FETCH_SPACING_MS)
    }

    if (token === runToken) finish('done')
  }

  const start = (raw: unknown): CrawlState => {
    const input = validate(raw)
    if (!input) {
      state = { ...state, running: false, stoppedReason: 'error' }
      broadcast()
      return state
    }
    runToken++
    state = {
      running: true,
      startUrl: input.url,
      visited: 0,
      queued: 1,
      pages: [],
      stoppedReason: undefined
    }
    broadcast()
    void run(input, runToken)
    return state
  }

  const stop = (): CrawlState => {
    if (state.running) {
      runToken++
      finish('stopped')
    }
    return state
  }

  return {
    start,
    stop,
    getState: () => state,
    onUpdate: (cb) => {
      listener = cb
    }
  }
}

/**
 * Window/IPC wrapper around the reusable crawl core.
 */
export function createCrawler(win: BrowserWindow, replayer: Replayer, existingCore?: CrawlCore): Crawler {
  const core = existingCore ?? createCrawlCore(replayer)

  const handle = (channel: string, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, ...args) =>
      event.sender === win.webContents ? fn(...args) : null
    )
  }
  handle('crawl:start', (input) => core.start(input))
  handle('crawl:stop', () => core.stop())
  handle('crawl:get-state', () => core.getState())
  core.onUpdate((state) => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('crawl:state', state)
    }
  })

  const close = (): void => {
    for (const c of ['crawl:start', 'crawl:stop', 'crawl:get-state']) ipcMain.removeHandler(c)
  }
  win.on('closed', close)
  return { close }
}
