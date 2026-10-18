// API.md §3.4 — Network inspection & interception (R/M).
// replay_request is the SEND PRIMITIVE Dev 1's 5.E fuzzers call — it is
// scope-checked (target()), gated (tier M), audited, and its traffic hits D's
// rate-limited proxy. A custom tool must never egress on its own; it routes here.
import { defineTool, type Tool } from '../tool'
import { optStr, str } from '../validate'
import { ToolExecError } from '../errors'
import { MAX_LIST_ITEMS, clampString } from '../limits'
import type { CapturedRequest } from '../../../shared/tabs'

interface RequestSpec {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

function parseRequestSpec(raw: unknown, key: string): RequestSpec {
  const v = (raw as Record<string, unknown>)?.[key]
  if (typeof v !== 'object' || v === null) throw new ToolExecError(`"${key}" must be an object`)
  return { url: str(v, 'url'), method: optStr(v, 'method') }
}

const replay_request = defineTool<{ base: RequestSpec }, unknown>({
  name: 'replay_request',
  description: 'Re-issue an HTTP request (optionally mutated). Scope-checked, gated.',
  riskTier: 'M',
  inputSchema: {
    type: 'object',
    required: ['base'],
    properties: {
      base: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
      overrides: { type: 'object' }
    }
  },
  outputSchema: { type: 'object', properties: { response: {}, bodyRef: { type: 'string' } } },
  parse: (raw) => ({ base: parseRequestSpec(raw, 'base') }),
  target: (i) => i.base.url, // scope boundary
  execute: async () => {
    throw new ToolExecError('replay_request: wire to CDP Fetch after spine (MVP-after)')
  }
})

function pending(name: string, description: string, tier: 'R' | 'M'): Tool {
  return defineTool<Record<string, never>, never>({
    name,
    description,
    riskTier: tier,
    inputSchema: { type: 'object', additionalProperties: true },
    outputSchema: { type: 'object' },
    parse: () => ({}),
    execute: async () => {
      throw new ToolExecError(`${name}: not implemented in Phase 1`)
    }
  }) as Tool
}

// A compact log row. The full header maps are deliberately NOT here — on a real
// page they are the bulk of the payload and would overflow the orchestrator's
// context in one call. The agent pulls headers/detail for a specific row via
// get_request(id). Keeps get_network_log cheap enough to call repeatedly.
interface NetworkLogRow {
  id: string
  method: string
  url: string
  resourceType: string
  statusCode?: number
  durationMs?: number
  fromCache?: boolean
  error?: string
}

function toRow(r: CapturedRequest): NetworkLogRow {
  return {
    id: r.id,
    method: r.method,
    url: clampString(r.url),
    resourceType: r.resourceType,
    statusCode: r.statusCode,
    durationMs: r.durationMs,
    fromCache: r.fromCache,
    error: r.error
  }
}

const get_network_log = defineTool<{ sinceId?: string }, unknown>({
  name: 'get_network_log',
  description:
    'Compact network log for the active tab since a cursor (the last entry\'s id from a prior call): ' +
    'id, method, url, status, timing. Headers/bodies are omitted to stay within context — ' +
    'call get_request(id) for one entry\'s full detail. Paginate with the returned nextCursor.',
  riskTier: 'R',
  inputSchema: {
    type: 'object',
    properties: { sinceId: { type: 'string' } },
    additionalProperties: false
  },
  outputSchema: { type: 'object' },
  parse: (raw) => {
    const r = raw as { sinceId?: unknown }
    return typeof r?.sinceId === 'string' ? { sinceId: r.sinceId } : {}
  },
  execute: async (i, ctx) => {
    // list() returns oldest→newest for the active tab. Keep the most recent
    // page — those are what the agent just caused — and report how many older
    // entries were dropped so it knows to paginate rather than assume it saw all.
    const all = ctx.network.list(i.sinceId)
    const entries = all.slice(-MAX_LIST_ITEMS).map(toRow)
    return {
      entries,
      total: all.length,
      omitted: Math.max(0, all.length - entries.length),
      nextCursor: entries.length > 0 ? entries[entries.length - 1].id : (i.sinceId ?? null)
    }
  }
})

const get_request = defineTool<{ id: string }, unknown>({
  name: 'get_request',
  description: 'Full request/response detail for one request id (from get_network_log).',
  riskTier: 'R',
  inputSchema: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' } },
    additionalProperties: false
  },
  outputSchema: { type: 'object' },
  parse: (raw) => ({ id: str(raw, 'id') }),
  execute: async (i, ctx) => {
    const req = ctx.network.get(i.id)
    if (!req) throw new ToolExecError(`no request with id "${i.id}" (it may have aged out)`)
    // Clamp long header values (cookies, tokens) so one row stays within budget
    // and serializes as valid JSON rather than being cut mid-object upstream.
    const trimValues = <V>(h: Record<string, V> | undefined): Record<string, V> | undefined =>
      h &&
      Object.fromEntries(
        Object.entries(h).map(([k, v]) => [
          k,
          (Array.isArray(v) ? v.map((x) => clampString(String(x))) : clampString(String(v))) as V
        ])
      )
    return {
      ...req,
      requestHeaders: trimValues(req.requestHeaders),
      responseHeaders: trimValues(req.responseHeaders)
    }
  }
})

export const networkTools: Tool[] = [
  replay_request as Tool,
  get_network_log as Tool,
  get_request as Tool,
  pending('set_intercept_rule', 'CDP Fetch rewrite rule. Gated — it is the scope boundary.', 'M')
]
