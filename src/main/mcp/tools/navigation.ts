// API.md §3.2 — Navigation & page read (tier R). `navigate` is scope-checked
// via target(); the rest read the already-loaded page.
import { defineTool, type Tool } from '../tool'
import { urlString } from '../validate'
import { ToolExecError } from '../errors'

const navigate = defineTool<{ url: string }, unknown>({
  name: 'navigate',
  description: 'Navigate the target view to a URL. Scope-checked.',
  riskTier: 'R',
  inputSchema: {
    type: 'object',
    required: ['url'],
    properties: { url: { type: 'string', format: 'uri' } },
    additionalProperties: false
  },
  outputSchema: { type: 'object', properties: { status: {}, finalUrl: {} } },
  parse: (raw) => ({ url: urlString(raw, 'url') }),
  target: (i) => i.url, // <- pipeline scope-checks this before execute()
  execute: async (i, ctx) => {
    const { status, finalUrl } = await ctx.cdp.navigate(i.url)
    return { status, finalUrl }
  }
})

const get_page_info = defineTool<Record<string, never>, unknown>({
  name: 'get_page_info',
  description: 'Current url, title, readyState of the target view.',
  riskTier: 'R',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object' },
  parse: () => ({}),
  execute: async (_i, ctx) => ctx.cdp.pageInfo()
})

const get_cookies = defineTool<Record<string, never>, unknown>({
  name: 'get_cookies',
  description: 'Cookies for the target session (values redacted unless policy allows).',
  riskTier: 'R',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'array' },
  parse: () => ({}),
  execute: async (_i, ctx) => {
    const cookies = await ctx.cdp.cookies()
    if (ctx.policy.redactCookies) return cookies.map((c) => ({ ...c, value: '<redacted>' }))
    return cookies
  }
})

const screenshot = defineTool<{ fullPage?: boolean }, unknown>({
  name: 'screenshot',
  description: 'Capture the target view; returns a trace ref, not inline bytes.',
  riskTier: 'R',
  inputSchema: {
    type: 'object',
    properties: { fullPage: { type: 'boolean' } },
    additionalProperties: false
  },
  outputSchema: { type: 'object', properties: { traceRef: { type: 'string' } } },
  parse: (raw) => {
    const r = raw as { fullPage?: unknown }
    return typeof r?.fullPage === 'boolean' ? { fullPage: r.fullPage } : {}
  },
  execute: async (_i, ctx) => {
    const png = await ctx.cdp.screenshot()
    return { traceRef: await ctx.traces.save('screenshot', png) }
  }
})

// Schema-complete, handler pending the recon-extraction schema (open-decision 1/2).
function pending(name: string, description: string): Tool {
  return defineTool<Record<string, never>, never>({
    name,
    description,
    riskTier: 'R',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object' },
    parse: () => ({}),
    execute: async () => {
      throw new ToolExecError(`${name}: pending recon-extraction schema (open-decision 1/2)`)
    }
  }) as Tool
}

export const navigationTools: Tool[] = [
  navigate as Tool,
  get_page_info as Tool,
  get_cookies as Tool,
  screenshot as Tool,
  pending('get_dom_extract', 'Schema’d DOM extract: forms/inputs/endpoints/links/headers/CSRF.'),
  pending('list_forms', 'Forms on the current page with identity refs.'),
  pending('list_links', 'Links on the current page, in/out of scope.'),
  pending('get_headers', 'Response headers of the current document.')
]
