// API.md §3.4 — Network inspection & interception (R/M).
// replay_request is the SEND PRIMITIVE Dev 1's 5.E fuzzers call — it is
// scope-checked (target()), gated (tier M), audited, and its traffic hits D's
// rate-limited proxy. A custom tool must never egress on its own; it routes here.
import { defineTool, type Tool } from '../tool'
import { optStr, str, urlString } from '../validate'
import { ToolExecError } from '../errors'
import { MAX_LIST_ITEMS, clampString } from '../limits'
import type { HttpRequestSpec } from '../cdp'
import type { CapturedRequest } from '../../../shared/tabs'

type RequestSpec = HttpRequestSpec

/** A forged/edited token set as an auth header in one step — the common case
 *  after a JWT is decoded and re-signed (e.g. alg:none / tampered claim probes).
 *  `scheme: null` writes the bare token with no prefix. */
interface JwtOverride {
  headerName: string
  scheme: string | null
  token: string
}

/** Overrides merged onto `base`. A header value of null REMOVES that header (so
 *  you can strip an auth/cookie header); body null drops the body. `jwt` is a
 *  convenience that sets one auth header from a raw token. */
interface RequestOverrides {
  url?: string
  method?: string
  headers?: Record<string, string | null>
  body?: string | null
  jwt?: JwtOverride
}

// RFC 7230 token — header name must be a bare field-name (also blocks CR/LF).
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

function parseJwtOverride(value: unknown): JwtOverride {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ToolExecError('"overrides.jwt" must be an object: { token, headerName?, scheme? }')
  }
  const j = value as Record<string, unknown>

  if (typeof j.token !== 'string' || j.token.trim().length === 0) {
    throw new ToolExecError('"overrides.jwt.token" must be a non-empty string')
  }
  // The token is pasted verbatim into a header value; CR/LF would split it into
  // an extra header (request smuggling), so reject rather than sanitize.
  if (/[\r\n]/.test(j.token)) {
    throw new ToolExecError('"overrides.jwt.token" must not contain CR/LF')
  }

  const headerName = j.headerName === undefined ? 'Authorization' : j.headerName
  if (typeof headerName !== 'string' || !HEADER_NAME_RE.test(headerName)) {
    throw new ToolExecError('"overrides.jwt.headerName" must be a valid HTTP header name')
  }

  let scheme: string | null
  if (j.scheme === undefined) scheme = 'Bearer'
  else if (j.scheme === null) scheme = null
  else if (typeof j.scheme !== 'string') {
    throw new ToolExecError('"overrides.jwt.scheme" must be a string, or null/empty for a bare token')
  } else {
    if (/[\r\n]/.test(j.scheme)) throw new ToolExecError('"overrides.jwt.scheme" must not contain CR/LF')
    const trimmed = j.scheme.trim()
    scheme = trimmed.length === 0 ? null : trimmed
  }

  return { headerName, scheme, token: j.token }
}

function parseHeaderMap(obj: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const h = obj[key]
  if (h === undefined) return undefined
  if (typeof h !== 'object' || h === null || Array.isArray(h)) {
    throw new ToolExecError(`"${key}" must be an object of string header values`)
  }
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(h as Record<string, unknown>)) {
    if (typeof value !== 'string') throw new ToolExecError(`header "${name}" must be a string`)
    out[name] = value
  }
  return out
}

function parseRequestSpec(raw: unknown, key: string): RequestSpec {
  const v = (raw as Record<string, unknown>)?.[key]
  if (typeof v !== 'object' || v === null) throw new ToolExecError(`"${key}" must be an object`)
  const spec = v as Record<string, unknown>
  return {
    url: urlString(spec, 'url'), // http(s) only, before scope check
    method: optStr(spec, 'method'),
    headers: parseHeaderMap(spec, 'headers'),
    body: optStr(spec, 'body')
  }
}

function parseOverrides(raw: unknown): RequestOverrides | undefined {
  const o = (raw as Record<string, unknown>)?.overrides
  if (o === undefined) return undefined
  if (typeof o !== 'object' || o === null || Array.isArray(o)) {
    throw new ToolExecError('"overrides" must be an object')
  }
  const ov = o as Record<string, unknown>
  const out: RequestOverrides = {}
  if (ov.url !== undefined) out.url = urlString(ov, 'url')
  if (ov.method !== undefined) out.method = optStr(ov, 'method')
  if (ov.headers !== undefined) {
    if (typeof ov.headers !== 'object' || ov.headers === null || Array.isArray(ov.headers)) {
      throw new ToolExecError('"overrides.headers" must be an object')
    }
    const hdrs: Record<string, string | null> = {}
    for (const [k, val] of Object.entries(ov.headers as Record<string, unknown>)) {
      if (val !== null && typeof val !== 'string') {
        throw new ToolExecError(`override header "${k}" must be a string, or null to remove it`)
      }
      hdrs[k] = val as string | null
    }
    out.headers = hdrs
  }
  if ('body' in ov) {
    if (ov.body !== null && typeof ov.body !== 'string') {
      throw new ToolExecError('"overrides.body" must be a string, or null to drop the body')
    }
    out.body = ov.body as string | null
  }
  if (ov.jwt !== undefined) out.jwt = parseJwtOverride(ov.jwt)
  return out
}

/** Header names are case-insensitive, so a jwt override replaces any existing
 *  casing of the same header instead of sending both. */
function deleteHeaderCI(headers: Record<string, string>, name: string): void {
  const lower = name.toLowerCase()
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) delete headers[k]
  }
}

function applyOverrides(base: RequestSpec, ov?: RequestOverrides): RequestSpec {
  if (!ov) return base
  const headers: Record<string, string> = { ...(base.headers ?? {}) }
  if (ov.headers) {
    for (const [k, v] of Object.entries(ov.headers)) {
      if (v === null) delete headers[k]
      else headers[k] = v
    }
  }
  // Applied last so an explicit token wins over any header override.
  if (ov.jwt) {
    deleteHeaderCI(headers, ov.jwt.headerName)
    headers[ov.jwt.headerName] = ov.jwt.scheme
      ? `${ov.jwt.scheme} ${ov.jwt.token}`
      : ov.jwt.token
  }
  const body = ov.body === null ? undefined : ov.body ?? base.body
  return {
    url: ov.url ?? base.url,
    method: ov.method ?? base.method,
    headers: Object.keys(headers).length ? headers : undefined,
    body
  }
}

const replay_request = defineTool<{ base: RequestSpec; overrides?: RequestOverrides }, unknown>({
  name: 'replay_request',
  description:
    'Re-issue an HTTP request, optionally mutated via `overrides` (change url/method/headers/body; ' +
    'a header value of null removes it, e.g. to strip auth). Runs through the target session so it ' +
    'carries that session\'s cookies. Scope-checked and gated (tier M).\n' +
    'To replay with a forged/edited JWT, pass `overrides.jwt: { token, headerName?, scheme? }` — it sets ' +
    '`headerName` (default "Authorization") to `scheme + " " + token` (scheme defaults to "Bearer"; pass ' +
    'null or "" for a bare token). This is equivalent to setting the header yourself but avoids hand-building ' +
    'the value, so a token from a JWT decode/re-sign step can be dropped straight in. If `overrides.headers` ' +
    'also targets that header (any casing), the jwt token wins.',
  riskTier: 'M',
  inputSchema: {
    type: 'object',
    required: ['base'],
    properties: {
      base: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string' },
          method: { type: 'string' },
          headers: { type: 'object' },
          body: { type: 'string' }
        }
      },
      overrides: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          method: { type: 'string' },
          headers: { type: 'object' },
          body: { type: ['string', 'null'] },
          jwt: {
            type: 'object',
            required: ['token'],
            description:
              'Convenience auth header: sets headerName (default "Authorization") to "[scheme ]token".',
            properties: {
              token: { type: 'string', description: 'Raw token value (e.g. a forged JWT).' },
              headerName: {
                type: 'string',
                description: 'Header to write. Default "Authorization".'
              },
              scheme: {
                type: ['string', 'null'],
                description:
                  'Prefix before the token. Default "Bearer"; null or "" writes the token alone.'
              }
            }
          }
        }
      }
    }
  },
  outputSchema: { type: 'object', properties: { response: {}, bodyRef: { type: 'string' } } },
  parse: (raw) => ({ base: parseRequestSpec(raw, 'base'), overrides: parseOverrides(raw) }),
  // Scope boundary: check the ACTUAL egress URL (override wins over base).
  target: (i) => i.overrides?.url ?? i.base.url,
  execute: async (i, ctx) => {
    const spec = applyOverrides(i.base, i.overrides)
    const result = await ctx.cdp.sendRequest(spec)
    // Full request+response → trace store (evidence / replayable PoC); the
    // inline body is clamped so a large response can't overflow the context.
    const bodyRef = await ctx.traces.save(
      'reqresp',
      JSON.stringify({ request: spec, response: result })
    )
    return {
      response: {
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
        durationMs: result.durationMs,
        bodyBytes: result.bodyBytes,
        body: clampString(result.body)
      },
      bodyRef
    }
  }
})

// ── replay_batch ───────────────────────────────────────────────────────────
// One base request swept across many variants in a single tool call. Each
// orchestrator tool call is a full model round-trip to a slow local model, so
// collapsing an N-URL / N-payload sweep into one call is the biggest efficiency
// win the repeater has. Output is deliberately compact (one row per variant +
// a bodyRef for detail) to stay under the per-result context ceiling.
// The sweep-size cap is editable via engagement policy (Policy.maxReplayBatch).
// This is only the fallback used when a context carries no policy.
const DEFAULT_MAX_REPLAY_BATCH = 20
const BATCH_CONCURRENCY = 5
const BATCH_BODY_PREVIEW = 120

type BatchRow =
  | {
      index: number
      url: string
      method: string
      status: number
      statusText: string
      bodyBytes: number
      durationMs: number
      bodyPreview: string
      bodyRef: string
      anomalous?: boolean
    }
  | { index: number; url: string; method: string; error: string }

/** Run `fn` over items with at most `limit` in flight, preserving input order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

function parseVariants(raw: unknown): RequestOverrides[] {
  const v = (raw as Record<string, unknown>)?.variants
  if (!Array.isArray(v) || v.length === 0) {
    throw new ToolExecError('"variants" must be a non-empty array of override objects')
  }
  // The size cap is enforced in execute against the engagement policy
  // (Policy.maxReplayBatch) — parse has no access to the context.
  return v.map((item, idx) => {
    try {
      // Reuse the single-request override parser by wrapping each item.
      return parseOverrides({ overrides: item }) ?? {}
    } catch (e) {
      throw new ToolExecError(`variants[${idx}]: ${(e as Error).message}`)
    }
  })
}

const replay_batch = defineTool<{ base: RequestSpec; variants: RequestOverrides[] }, unknown>({
  name: 'replay_batch',
  description:
    'Replay one base request across many variants in a SINGLE call — e.g. an array of URLs, or the ' +
    'base request with a different payload per variant. Each variant is merged onto `base` (set ' +
    'url/method/headers/body; a header value of null removes it). Returns a compact row per variant ' +
    '(status, size, timing, preview, bodyRef, and an `anomalous` flag vs the first response) so a ' +
    `whole sweep costs one round-trip. Capped by engagement policy (default ${DEFAULT_MAX_REPLAY_BATCH}). ` +
    'Each variant URL is scope-checked; out-of-scope ones are not sent. Gated (tier M).',
  riskTier: 'M',
  inputSchema: {
    type: 'object',
    required: ['base', 'variants'],
    properties: {
      base: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string' },
          method: { type: 'string' },
          headers: { type: 'object' },
          body: { type: 'string' }
        }
      },
      variants: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            method: { type: 'string' },
            headers: { type: 'object' },
            body: { type: ['string', 'null'] },
            jwt: {
              type: 'object',
              required: ['token'],
              description:
                'Same as replay_request: sets an auth header to "[scheme ]token" for this variant.',
              properties: {
                token: { type: 'string' },
                headerName: { type: 'string' },
                scheme: { type: ['string', 'null'] }
              }
            }
          }
        }
      }
    }
  },
  outputSchema: { type: 'object' },
  parse: (raw) => ({ base: parseRequestSpec(raw, 'base'), variants: parseVariants(raw) }),
  // Representative target for the pipeline's single scope check + the permission
  // resource; EVERY variant URL is re-checked in execute before it is sent.
  target: (i) => i.base.url,
  execute: async (i, ctx) => {
    const cap = ctx.policy?.maxReplayBatch ?? DEFAULT_MAX_REPLAY_BATCH
    if (i.variants.length > cap) {
      throw new ToolExecError(
        `batch has ${i.variants.length} variants; max ${cap} per call (engagement policy). ` +
          'Split the sweep, or raise Policy.maxReplayBatch.'
      )
    }
    const specs = i.variants.map((ov) => applyOverrides(i.base, ov))
    const results = await mapWithConcurrency<RequestSpec, BatchRow>(
      specs,
      BATCH_CONCURRENCY,
      async (spec, index) => {
        const method = (spec.method || 'GET').toUpperCase()
        // Per-variant scope enforcement — an out-of-scope URL is never sent.
        if (!ctx.scope.isInScope(spec.url)) {
          return { index, url: spec.url, method, error: 'out of scope — not sent' }
        }
        try {
          const r = await ctx.cdp.sendRequest(spec)
          const bodyRef = await ctx.traces.save(
            'reqresp',
            JSON.stringify({ request: spec, response: r })
          )
          return {
            index,
            url: spec.url,
            method,
            status: r.status,
            statusText: r.statusText,
            bodyBytes: r.bodyBytes,
            durationMs: r.durationMs,
            bodyPreview: clampString(r.body, BATCH_BODY_PREVIEW),
            bodyRef
          }
        } catch (err) {
          return { index, url: spec.url, method, error: (err as Error)?.message ?? String(err) }
        }
      }
    )

    // Cheap oracle: flag variants whose (status, size) differs from the first
    // successful response — those are the ones worth a closer look.
    const baseline = results.find((r): r is Extract<BatchRow, { status: number }> => 'status' in r)
    const statuses: Record<string, number> = {}
    let errors = 0
    for (const r of results) {
      if ('status' in r) {
        statuses[r.status] = (statuses[r.status] ?? 0) + 1
        if (baseline) r.anomalous = r.status !== baseline.status || r.bodyBytes !== baseline.bodyBytes
      } else {
        errors++
      }
    }
    return { count: results.length, results, summary: { statuses, errors } }
  }
})

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

// WebSocket *messages* are captured over CDP (Network.webSocketFrame*) by
// src/main/websocket.ts, but that capture is owned by the inspector and is not
// exposed on ToolContext — so this tool cannot read frames yet. What IS
// available is the handshake URL from the network reader (webRequest sees the
// upgrade request as resourceType 'websocket', never the frames). Report that
// honestly instead of pretending to return messages.
const get_websocket_messages = defineTool<Record<string, never>, unknown>({
  name: 'get_websocket_messages',
  description:
    'List WebSocket handshake URLs observed in the network log. Frame/message capture is not ' +
    'exposed to MCP tools yet — `messages` is always empty; do not infer traffic from it.',
  riskTier: 'R',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object' },
  parse: () => ({}),
  execute: async (_i, ctx) => {
    const handshakes = ctx.network
      .list()
      .filter((r) => /websocket/i.test(r.resourceType) || /^wss?:/i.test(r.url))
    const urls = [...new Set(handshakes.map((r) => r.url))]
    return {
      urls,
      connections: urls.length,
      messages: [],
      messagesSupported: false,
      note:
        urls.length > 0
          ? 'urls come from the network log handshake. Message/frame payloads are not implemented for MCP tools (CDP frame capture exists in the app UI only).'
          : 'No WebSocket handshakes in the network log. Message/frame payloads are not implemented for MCP tools (CDP frame capture exists in the app UI only).'
    }
  }
})

export const networkTools: Tool[] = [
  replay_request as Tool,
  replay_batch as Tool,
  get_network_log as Tool,
  get_request as Tool,
  get_websocket_messages as Tool,
  defineTool<{ raw: unknown }, unknown>({
    name: 'set_intercept_rule',
    description: 'Create a match/replace intercept rule (CDP Fetch). Gated.',
    riskTier: 'M',
    inputSchema: { type: 'object', required: ['raw'], properties: { raw: { type: 'object' } }, additionalProperties: false },
    outputSchema: { type: 'object' },
    parse: (raw) => {
      const r = raw as { raw?: unknown }
      return { raw: r?.raw }
    },
    execute: async (i, ctx) => {
      if (!ctx.interceptor) throw new ToolExecError('interceptor not available')
      const rule = ctx.interceptor.save(i.raw)
      if (rule === null) throw new ToolExecError('set_intercept_rule: invalid rule payload', false)
      return { rule }
    }
  }) as Tool
]
