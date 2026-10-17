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

export const networkTools: Tool[] = [
  replay_request as Tool,
  pending('get_network_log', 'Network entries observed on the target since a cursor.', 'R'),
  pending('get_request', 'Full request/response + body ref for one request id.', 'R'),
  pending('set_intercept_rule', 'CDP Fetch rewrite rule. Gated — it is the scope boundary.', 'M')
]
