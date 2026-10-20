// API.md §3.9 — Crawler. Exposes the app's scope-aware spider (§11.4) to the
// copilot. Start is tier M (it issues many GETs); status/results are read-only.
import { defineTool, type Tool } from '../tool'
import { ToolExecError, ToolInputError } from '../errors'

const crawl_start = defineTool<{ url: string; maxDepth?: number; maxPages?: number }, unknown>({
  name: 'crawl_start',
  description: 'Start a scope-aware crawl from a URL. Returns the initial crawl state.',
  riskTier: 'M',
  inputSchema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string' },
      maxDepth: { type: 'number' },
      maxPages: { type: 'number' }
    },
    additionalProperties: false
  },
  outputSchema: { type: 'object' },
  parse: (raw) => {
    const r = raw as Record<string, unknown>
    if (typeof r.url !== 'string' || r.url === '') throw new ToolInputError('"url" must be a non-empty string')
    return {
      url: r.url,
      maxDepth: typeof r.maxDepth === 'number' ? r.maxDepth : undefined,
      maxPages: typeof r.maxPages === 'number' ? r.maxPages : undefined
    }
  },
  // The crawl seeds from `url` and then follows links, so the pipeline's scope
  // check must gate the seed here — otherwise crawl_start would be the one send
  // path with no boundary (every followed link is re-checked by the spider).
  target: (i) => i.url,
  execute: async (i, ctx) => {
    if (!ctx.crawler) {
      throw new ToolExecError(
        'crawler not available in this build/surface — walk the target manually with navigate + list_links, then get_dom_extract on each page'
      )
    }
    const state = await ctx.crawler.start(i)
    if (state && (state as { stoppedReason?: string }).stoppedReason === 'error') {
      throw new ToolExecError(
        `crawl_start failed: ${(state as { error?: string }).error ?? 'invalid url'} — ` +
          'verify the URL is http(s) and inside the engagement scope, then retry',
        false
      )
    }
    return state
  }
})

const crawl_status = defineTool<Record<string, never>, unknown>({
  name: 'crawl_status',
  description: 'Get the current crawl state (running, pages visited/queued).',
  riskTier: 'R',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object' },
  parse: () => ({}),
  execute: async (_i, ctx) => {
    if (!ctx.crawler) {
      throw new ToolExecError(
        'crawler not available in this build/surface — no crawl can be running; use navigate + list_links instead'
      )
    }
    return ctx.crawler.getState()
  }
})

const crawl_stop = defineTool<Record<string, never>, unknown>({
  name: 'crawl_stop',
  description: 'Stop the running crawl.',
  riskTier: 'R',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object' },
  parse: () => ({}),
  execute: async (_i, ctx) => {
    if (!ctx.crawler) {
      throw new ToolExecError(
        'crawler not available in this build/surface — there is no crawl to stop; use navigate + list_links instead'
      )
    }
    return ctx.crawler.stop()
  }
})

export const crawlerTools: Tool[] = [crawl_start as Tool, crawl_status as Tool, crawl_stop as Tool]
