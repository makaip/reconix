// API.md §3.4 — Network inspection & interception (R/M).
// replay_request is the SEND PRIMITIVE Dev 1's 5.E fuzzers call — it is
// scope-checked (target()), gated (tier M), audited, and its traffic hits D's
// rate-limited proxy. A custom tool must never egress on its own; it routes here.
import { defineTool, type Tool } from '../tool'
import { optStr, str } from '../validate'
import { ToolExecError } from '../errors'

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

const get_network_log = defineTool<{ sinceId?: string }, unknown>({
  name: 'get_network_log',
  description:
    'Network entries observed on the target since a cursor (the last entry\'s id from a prior call) — ' +
    'method, url, status, timing, headers. Scoped to whatever tab is currently active, not the whole app.',
  riskTier: 'R',
  inputSchema: {
    type: 'object',
    properties: { sinceId: { type: 'string' } },
    additionalProperties: false
  },
  outputSchema: { type: 'array' },
  parse: (raw) => {
    const r = raw as { sinceId?: unknown }
    return typeof r?.sinceId === 'string' ? { sinceId: r.sinceId } : {}
  },
  execute: async (i, ctx) => ctx.network.list(i.sinceId)
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
    return req
  }
})

export const networkTools: Tool[] = [
  replay_request as Tool,
  get_network_log as Tool,
  get_request as Tool,
  pending('set_intercept_rule', 'CDP Fetch rewrite rule. Gated — it is the scope boundary.', 'M')
]
