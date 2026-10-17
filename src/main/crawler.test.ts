import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { ReplayResult } from '../shared/tabs'
import type { CrawlState } from '../shared/crawler'
import { createCrawler } from './crawler'

// Capture the wrapped IPC handlers so the test can invoke crawl:* directly.
const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    removeHandler: (channel: string) => handlers.delete(channel)
  }
}))

const states: CrawlState[] = []
const fakeWin = {
  isDestroyed: () => false,
  webContents: {
    isDestroyed: () => false,
    send: (_channel: string, state: CrawlState) => states.push(state)
  },
  on: vi.fn()
} as unknown as BrowserWindow

// The IPC wrapper only runs fn when event.sender === win.webContents.
function invoke(channel: string, input?: unknown): unknown {
  const fn = handlers.get(channel)!
  return fn({ sender: fakeWin.webContents }, input)
}

const html = (hrefs: string[]): string => hrefs.map((h) => `<a href="${h}">x</a>`).join('')
const okHtml = (body: string): ReplayResult => ({
  ok: true,
  status: 200,
  headers: { 'content-type': 'text/html' },
  body,
  bodyTruncated: false,
  timingMs: 1
})

const lastState = (): CrawlState => states[states.length - 1]

beforeEach(() => {
  handlers.clear()
  states.length = 0
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('createCrawler', () => {
  it('walks same-origin links breadth-first and ignores cross-origin', async () => {
    const replayer = vi.fn(async (raw: unknown): Promise<ReplayResult> => {
      const { url } = raw as { url: string }
      if (url === 'https://t/') return okHtml(html(['/a', 'https://other/x']))
      if (url === 'https://t/a') return okHtml('')
      return { ok: false, reason: 'denied', error: 'out of scope' }
    })
    createCrawler(fakeWin, replayer)

    invoke('crawl:start', { url: 'https://t/', maxDepth: 2, maxPages: 50 })
    await vi.advanceTimersByTimeAsync(10_000)

    const final = lastState()
    expect(final.running).toBe(false)
    expect(final.stoppedReason).toBe('done')
    expect(final.visited).toBe(2)
    expect(final.pages.map((p) => p.url)).toEqual(['https://t/', 'https://t/a'])
    // cross-origin https://other/x was never fetched
    expect(replayer).not.toHaveBeenCalledWith(expect.objectContaining({ url: 'https://other/x' }))
  })

  it('stops at the maxPages cap', async () => {
    const replayer = vi.fn(async (): Promise<ReplayResult> => okHtml(html(['/a', '/b', '/c', '/d'])))
    createCrawler(fakeWin, replayer)

    invoke('crawl:start', { url: 'https://t/', maxDepth: 5, maxPages: 2 })
    await vi.advanceTimersByTimeAsync(10_000)

    const final = lastState()
    expect(final.stoppedReason).toBe('max-pages')
    expect(final.pages).toHaveLength(2)
  })

  it('records a denied fetch without expanding it', async () => {
    const replayer = vi.fn(
      async (): Promise<ReplayResult> => ({ ok: false, reason: 'denied', error: 'out of scope' })
    )
    createCrawler(fakeWin, replayer)

    invoke('crawl:start', { url: 'https://t/', maxDepth: 2, maxPages: 50 })
    await vi.advanceTimersByTimeAsync(10_000)

    const final = lastState()
    expect(final.stoppedReason).toBe('done')
    expect(final.pages).toEqual([{ url: 'https://t/', depth: 0, status: null, reason: 'denied' }])
  })

  it('flags a non-html page and does not extract links from it', async () => {
    const replayer = vi.fn(
      async (): Promise<ReplayResult> => ({
        ok: true,
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '<a href="/a">x</a>',
        bodyTruncated: false,
        timingMs: 1
      })
    )
    createCrawler(fakeWin, replayer)

    invoke('crawl:start', { url: 'https://t/', maxDepth: 2, maxPages: 50 })
    await vi.advanceTimersByTimeAsync(10_000)

    const final = lastState()
    expect(final.pages).toEqual([{ url: 'https://t/', depth: 0, status: 200, reason: 'non-html' }])
  })

  it('rejects invalid start input', () => {
    createCrawler(fakeWin, vi.fn())
    const result = invoke('crawl:start', { url: 'not a url' }) as CrawlState
    expect(result.running).toBe(false)
    expect(result.stoppedReason).toBe('error')
  })

  it('stop() ends a running crawl', async () => {
    const replayer = vi.fn(async (): Promise<ReplayResult> => okHtml(html(['/a', '/b', '/c'])))
    createCrawler(fakeWin, replayer)

    invoke('crawl:start', { url: 'https://t/', maxDepth: 5, maxPages: 500 })
    await vi.advanceTimersByTimeAsync(1200) // one page fetched, mid-crawl
    const stopped = invoke('crawl:stop') as CrawlState
    expect(stopped.running).toBe(false)
    expect(stopped.stoppedReason).toBe('stopped')
  })
})
