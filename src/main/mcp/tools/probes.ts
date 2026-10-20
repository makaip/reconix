// API.md §3.5 — Active probes / exploit (M/D) and §3.6 — Verify & evidence (R).
// Detection, not weaponization (probe_reflection uses benign markers). run_tool
// (brokered external binaries) is tier D and gated behind an explicit allowlist
// (§8.6): argv-only, no shell, resource/time caps. External binaries are not
// shipped with Reconix, so it returns a clear error unless one is allowlisted.
import { defineTool, type Tool } from '../tool'
import { ToolExecError, ToolInputError } from '../errors'
import { str, optStr, strArray, num, urlString } from '../validate'
import { submitForm } from './submitForm'
import { clampString } from '../limits'
import type { HttpRequestSpec } from '../cdp'
import { spawn } from 'node:child_process'

function parseRequestSpec(raw: unknown, key: string): HttpRequestSpec {
  const v = (raw as Record<string, unknown>)?.[key]
  if (typeof v !== 'object' || v === null) throw new ToolInputError(`"${key}" must be an object`)
  const spec = v as Record<string, unknown>
  const url = urlString(spec, 'url')
  const method = optStr(spec, 'method')
  let headers: Record<string, string> | undefined
  const h = spec.headers
  if (h !== undefined) {
    if (typeof h !== 'object' || h === null || Array.isArray(h)) throw new ToolInputError('"headers" must be an object')
    headers = {}
    for (const [k, val] of Object.entries(h as Record<string, unknown>)) {
      if (typeof val !== 'string') throw new ToolInputError(`header "${k}" must be a string`)
      headers[k] = val
    }
  }
  const body = optStr(spec, 'body')
  return { url, method, headers, body }
}

// ── probe_reflection ──────────────────────────────────────────────────────────
// Benign-marker reflection probe (detection only). Sends `base` with a unique
// marker injected into the URL query (unless the caller already placed it) and
// reports whether the marker reflects in the response body or headers. Tier M
// because it issues a real request.
const probe_reflection = defineTool<{ base: HttpRequestSpec; marker?: string }, unknown>({
  name: 'probe_reflection',
  description:
    'Benign-marker reflection probe (detection only). Sends `base` with a unique marker and reports whether the marker reflects in the response body/headers.',
  riskTier: 'M',
  inputSchema: {
    type: 'object',
    required: ['base'],
    properties: {
      base: { type: 'object', required: ['url'], properties: { url: { type: 'string' }, method: { type: 'string' }, headers: { type: 'object' }, body: { type: 'string' } } },
      marker: { type: 'string' }
    },
    additionalProperties: false
  },
  outputSchema: { type: 'object' },
  parse: (raw) => ({ base: parseRequestSpec(raw, 'base'), marker: optStr(raw, 'marker') }),
  target: (i) => i.base.url,
  execute: async (i, ctx) => {
    const marker = i.marker && i.marker.length > 0 ? i.marker : `reconix_probe_${Math.random().toString(36).slice(2, 10)}`
    let url = i.base.url
    try {
      const u = new URL(url)
      if (!url.includes(marker)) {
        if (!u.searchParams.has('probe')) u.searchParams.set('probe', marker)
        url = u.href
      }
    } catch {
      // leave url as-is
    }
    const spec = { ...i.base, url }
    if (!ctx.scope.isInScope(spec.url)) throw new ToolExecError('target out of scope — not sent')
    const result = await ctx.cdp.sendRequest(spec)
    const inBody = result.body.includes(marker)
    const inHeaders: string[] = []
    for (const [k, v] of Object.entries(result.headers)) {
      if (String(v).includes(marker)) inHeaders.push(k)
    }
    const bodyRef = await ctx.traces.save('reqresp', JSON.stringify({ request: spec, response: result, marker }))
    return {
      reflected: inBody || inHeaders.length > 0,
      inBody,
      inHeaders,
      marker,
      response: { status: result.status, statusText: result.statusText, bodyBytes: result.bodyBytes, durationMs: result.durationMs },
      bodyRef
    }
  }
})

// ── vary helper (shared by vary_parameter and test_idor) ──────────────────────
type VaryInput = { base: HttpRequestSpec; paramName: string; values: string[]; location?: 'query' | 'body' }
async function varyAcross(i: VaryInput, ctx: Parameters<Tool['execute']>[1]): Promise<unknown> {
  const cap = ctx.policy?.maxReplayBatch ?? 20
  if (i.values.length > cap) {
    throw new ToolExecError(`vary has ${i.values.length} values; max ${cap} per call (engagement policy).`)
  }
  const location = i.location ?? 'query'
  const buildSpec = (value: string): HttpRequestSpec => {
    if (location === 'query') {
      const u = new URL(i.base.url)
      u.searchParams.set(i.paramName, value)
      return { ...i.base, url: u.href }
    }
    let body = i.base.body ?? ''
    try {
      const params = new URLSearchParams(body)
      if (params.has(i.paramName) || body.includes('=')) {
        params.set(i.paramName, value)
        body = params.toString()
      } else {
        body = body ? `${body}&${encodeURIComponent(i.paramName)}=${encodeURIComponent(value)}` : `${encodeURIComponent(i.paramName)}=${encodeURIComponent(value)}`
      }
    } catch {
      body = body ? `${body}&${encodeURIComponent(i.paramName)}=${encodeURIComponent(value)}` : `${encodeURIComponent(i.paramName)}=${encodeURIComponent(value)}`
    }
    return { ...i.base, body }
  }

  const specs = i.values.map(buildSpec)
  const results: Array<Record<string, unknown>> = []
  const limit = 5
  const queue = specs.map((spec, index) => ({ spec, index }))
  const workers = Array.from({ length: Math.min(limit, specs.length) }, async () => {
    for (;;) {
      const job = queue.shift()
      if (!job) return
      const { spec, index } = job
      const method = (spec.method || 'GET').toUpperCase()
      if (!ctx.scope.isInScope(spec.url)) {
        results[index] = { index, value: i.values[index], url: spec.url, method, error: 'out of scope — not sent' }
        continue
      }
      try {
        const r = await ctx.cdp.sendRequest(spec)
        const bodyRef = await ctx.traces.save('reqresp', JSON.stringify({ request: spec, response: r }))
        results[index] = {
          index,
          value: i.values[index],
          url: spec.url,
          method,
          status: r.status,
          statusText: r.statusText,
          bodyBytes: r.bodyBytes,
          durationMs: r.durationMs,
          bodyPreview: clampString(r.body, 120),
          bodyRef
        }
      } catch (err) {
        results[index] = { index, value: i.values[index], url: spec.url, method, error: (err as Error)?.message ?? String(err) }
      }
    }
  })
  await Promise.all(workers)

  const baseline = results.find((r): r is Record<string, unknown> & { status: number } => typeof r?.status === 'number')
  const statuses: Record<string, number> = {}
  let errors = 0
  for (const r of results) {
    if (typeof r?.status === 'number') {
      statuses[r.status] = (statuses[r.status] ?? 0) + 1
      if (baseline && r !== baseline) {
        r.anomalous = r.status !== baseline.status || r.bodyBytes !== baseline.bodyBytes
      }
    } else {
      errors++
    }
  }
  return { count: results.length, paramName: i.paramName, location, results, summary: { statuses, errors } }
}

// ── vary_parameter ────────────────────────────────────────────────────────────
// Differential over one parameter across a value set (IDOR/BAC/fuzz). Each
// variant is scope-checked before it is sent; anomalies are flagged vs the
// first successful response.
const vary_parameter = defineTool<{ base: HttpRequestSpec; paramName: string; values: string[]; location?: 'query' | 'body' }, unknown>({
  name: 'vary_parameter',
  description: 'Vary one parameter across values and diff responses (IDOR/BAC/fuzz). Rate-limited.',
  riskTier: 'M',
  inputSchema: {
    type: 'object',
    required: ['base', 'paramName', 'values'],
    properties: {
      base: { type: 'object', required: ['url'], properties: { url: { type: 'string' }, method: { type: 'string' }, headers: { type: 'object' }, body: { type: 'string' } } },
      paramName: { type: 'string', minLength: 1 },
      values: { type: 'array', items: { type: 'string' }, minItems: 1 },
      location: { type: 'string', enum: ['query', 'body'] }
    },
    additionalProperties: false
  },
  outputSchema: { type: 'object' },
  parse: (raw) => {
    const paramName = str(raw, 'paramName')
    const values = strArray(raw, 'values')
    const location = optStr(raw, 'location')
    if (location !== undefined && location !== 'query' && location !== 'body') {
      throw new ToolInputError('"location" must be "query" or "body"')
    }
    return { base: parseRequestSpec(raw, 'base'), paramName, values, location: (location as 'query' | 'body' | undefined) ?? 'query' }
  },
  target: (i) => i.base.url,
  execute: async (i, ctx) => varyAcross(i, ctx)
})

// ── reproduce ─────────────────────────────────────────────────────────────────
// Replay a stored reqresp trace and report whether the response still matches.
const reproduce = defineTool<{ traceRef: string }, unknown>({
  name: 'reproduce',
  description: 'Replay a stored interaction (reqresp trace) and report whether the response still matches.',
  riskTier: 'R',
  inputSchema: { type: 'object', required: ['traceRef'], properties: { traceRef: { type: 'string' } }, additionalProperties: false },
  outputSchema: { type: 'object' },
  parse: (raw) => ({ traceRef: str(raw, 'traceRef') }),
  execute: async (i, ctx) => {
    const trace = ctx.traces.get(i.traceRef)
    if (!trace) throw new ToolExecError(`no trace for ref ${i.traceRef}`)
    let stored: { request?: HttpRequestSpec; response?: { status: number; bodyBytes: number } }
    try {
      stored = JSON.parse(Buffer.from(trace.data).toString('utf8'))
    } catch {
      throw new ToolExecError('trace is not a reqresp bundle')
    }
    if (!stored?.request?.url) throw new ToolExecError('trace is not a reqresp bundle')
    if (!ctx.scope.isInScope(stored.request.url)) throw new ToolExecError('stored request target out of scope — not sent')
    const result = await ctx.cdp.sendRequest(stored.request)
    const matched = !!stored.response && result.status === stored.response.status && result.bodyBytes === stored.response.bodyBytes
    const newRef = await ctx.traces.save('reqresp', JSON.stringify({ request: stored.request, response: result, reproducedFrom: i.traceRef }))
    return {
      matched,
      traceRef: newRef,
      expected: stored.response ? { status: stored.response.status, bodyBytes: stored.response.bodyBytes } : null,
      actual: { status: result.status, statusText: result.statusText, bodyBytes: result.bodyBytes, durationMs: result.durationMs }
    }
  }
})

// ── collect_evidence ──────────────────────────────────────────────────────────
// Bundle a screenshot + page info into a single trace ref for a finding.
const collect_evidence = defineTool<Record<string, never>, unknown>({
  name: 'collect_evidence',
  description: 'Capture a screenshot and bundle it with page info into a trace ref for a finding.',
  riskTier: 'R',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object', properties: { traceRef: { type: 'string' } } },
  parse: () => ({}),
  execute: async (_i, ctx) => {
    const png = await ctx.cdp.screenshot()
    const screenshotRef = await ctx.traces.save('screenshot', png)
    const info = await ctx.cdp.pageInfo().catch(() => null)
    const bundle = { url: info?.url ?? null, title: info?.title ?? null, screenshotRef, ts: Date.now() }
    const traceRef = await ctx.traces.save('trace', JSON.stringify(bundle))
    return { traceRef, screenshotRef }
  }
})

// ── run_tool ──────────────────────────────────────────────────────────────────
// Brokered external binary (§8.6, post-MVP). Implemented as a safe, argv-only
// runner: no shell, strict allowlist (RECONIX_RUN_TOOL_ALLOWLIST or built-in
// default), resource/time caps. External binaries are not shipped with Reconix,
// so this returns a clear error unless an allowlisted binary is installed.
const RUN_TOOL_ALLOWLIST = (process.env.RECONIX_RUN_TOOL_ALLOWLIST ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const RUN_TOOL_TIMEOUT_MS = 60_000
const RUN_TOOL_MAX_OUTPUT = 1_000_000

const run_tool = defineTool<{ binary: string; args?: string[]; timeoutMs?: number }, unknown>({
  name: 'run_tool',
  description: 'Run an allowlisted external binary (argv only, no shell). Tier D — gated. Post-MVP: requires an installed binary and an entry in RECONIX_RUN_TOOL_ALLOWLIST.',
  riskTier: 'D',
  inputSchema: {
    type: 'object',
    required: ['binary'],
    properties: {
      binary: { type: 'string', minLength: 1 },
      args: { type: 'array', items: { type: 'string' } },
      timeoutMs: { type: 'number' }
    },
    additionalProperties: false
  },
  outputSchema: { type: 'object' },
  parse: (raw) => {
    const binary = str(raw, 'binary')
    const r = raw as Record<string, unknown>
    const args = Array.isArray(r.args) ? (r.args as unknown[]).map((a, idx) => {
      if (typeof a !== 'string') throw new ToolInputError(`args[${idx}] must be a string`)
      return a
    }) : []
    const timeoutMs = r.timeoutMs === undefined ? undefined : num(raw, 'timeoutMs')
    if (timeoutMs !== undefined && (timeoutMs <= 0 || timeoutMs > RUN_TOOL_TIMEOUT_MS)) {
      throw new ToolInputError(`timeoutMs must be between 1 and ${RUN_TOOL_TIMEOUT_MS}`)
    }
    return { binary, args, timeoutMs }
  },
  execute: async (i) => {
    if (RUN_TOOL_ALLOWLIST.length === 0 || !RUN_TOOL_ALLOWLIST.includes(i.binary)) {
      throw new ToolExecError(
        `run_tool: "${i.binary}" is not allowlisted. Set RECONIX_RUN_TOOL_ALLOWLIST (comma-separated) to enable. ` +
          '§8.6 requires a sandboxed broker; this build runs argv-only with no allowlist by default.'
      )
    }
    const timeout = i.timeoutMs ?? RUN_TOOL_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      const child = spawn(i.binary, i.args ?? [], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      let killed = false
      const timer = setTimeout(() => {
        killed = true
        try { child.kill('SIGKILL') } catch { /* ignore */ }
      }, timeout)
      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length < RUN_TOOL_MAX_OUTPUT) stdout += chunk.toString('utf8').slice(0, RUN_TOOL_MAX_OUTPUT - stdout.length)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < RUN_TOOL_MAX_OUTPUT) stderr += chunk.toString('utf8').slice(0, RUN_TOOL_MAX_OUTPUT - stderr.length)
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        reject(new ToolExecError(`run_tool: failed to spawn "${i.binary}": ${err.message}`))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ exitCode: code, stdout, stderr, timedOut: killed })
      })
    })
  }
})

// ── compare_roles ─────────────────────────────────────────────────────────────
// Replay the same request with two different session tokens and report the
// differences — the core primitive for IDOR/BAC detection.
const compare_roles = defineTool<
  { base: HttpRequestSpec; roleA: string; roleB: string; headerName?: string },
  unknown
>({
  name: 'compare_roles',
  description: 'Replay one request as two roles (different auth tokens) and diff the responses (IDOR/BAC).',
  riskTier: 'M',
  inputSchema: {
    type: 'object',
    required: ['base', 'roleA', 'roleB'],
    properties: {
      base: { type: 'object', required: ['url'], properties: { url: { type: 'string' }, method: { type: 'string' }, headers: { type: 'object' }, body: { type: 'string' } } },
      roleA: { type: 'string', minLength: 1 },
      roleB: { type: 'string', minLength: 1 },
      headerName: { type: 'string' }
    },
    additionalProperties: false
  },
  outputSchema: { type: 'object' },
  parse: (raw) => {
    const headerName = optStr(raw, 'headerName') ?? 'Cookie'
    return {
      base: parseRequestSpec(raw, 'base'),
      roleA: str(raw, 'roleA'),
      roleB: str(raw, 'roleB'),
      headerName
    }
  },
  target: (i) => i.base.url,
  execute: async (i, ctx) => {
    const send = async (token: string) => {
      const hn = i.headerName ?? 'Cookie'
      const spec = { ...i.base, headers: { ...(i.base.headers ?? {}), [hn]: token } }
      if (!ctx.scope.isInScope(spec.url)) throw new ToolExecError('target out of scope — not sent')
      const r = await ctx.cdp.sendRequest(spec)
      const ref = await ctx.traces.save('reqresp', JSON.stringify({ request: spec, response: r, role: token }))
      return { status: r.status, statusText: r.statusText, bodyBytes: r.bodyBytes, durationMs: r.durationMs, bodyPreview: clampString(r.body, 200), bodyRef: ref }
    }
    const [a, b] = await Promise.all([send(i.roleA), send(i.roleB)])
    return {
      roleA: a,
      roleB: b,
      statusChanged: a.status !== b.status,
      bodyBytesChanged: a.bodyBytes !== b.bodyBytes,
      anomalous: a.status !== b.status || a.bodyBytes !== b.bodyBytes
    }
  }
})

// ── check_cors ────────────────────────────────────────────────────────────────
const check_cors = defineTool<{ url: string }, unknown>({
  name: 'check_cors',
  description: 'Send an arbitrary Origin and report whether it is reflected with credentials (CORS weakness).',
  riskTier: 'M',
  inputSchema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } }, additionalProperties: false },
  outputSchema: { type: 'object' },
  parse: (raw) => ({ url: urlString(raw, 'url') }),
  target: (i) => i.url,
  execute: async (i, ctx) => {
    const spec = { url: i.url, headers: { Origin: 'https://evil.example' } }
    if (!ctx.scope.isInScope(spec.url)) throw new ToolExecError('target out of scope — not sent')
    const r = await ctx.cdp.sendRequest(spec)
    const acao = r.headers['access-control-allow-origin'] ?? r.headers['Access-Control-Allow-Origin']
    const acac = r.headers['access-control-allow-credentials'] ?? r.headers['Access-Control-Allow-Credentials']
    return {
      reflectedOrigin: acao === 'https://evil.example' || acao === '*',
      allowCredentials: acac === 'true',
      acao, acac,
      vulnerable: acao === 'https://evil.example' && acac === 'true'
    }
  }
})

// ── test_idor ─────────────────────────────────────────────────────────────────
const test_idor = defineTool<{ base: HttpRequestSpec; paramName: string; values: string[] }, unknown>({
  name: 'test_idor',
  description: 'IDOR probe: vary an ID-like parameter and flag responses that change (access control weakness).',
  riskTier: 'M',
  inputSchema: { type: 'object', required: ['base', 'paramName', 'values'], properties: {
    base: { type: 'object', required: ['url'], properties: { url: { type: 'string' }, method: { type: 'string' }, headers: { type: 'object' }, body: { type: 'string' } } },
    paramName: { type: 'string' }, values: { type: 'array', items: { type: 'string' } }
  }, additionalProperties: false },
  outputSchema: { type: 'object' },
  parse: (raw) => ({ base: parseRequestSpec(raw, 'base'), paramName: str(raw, 'paramName'), values: strArray(raw, 'values') }),
  target: (i) => i.base.url,
  execute: async (i, ctx) => {
    const out = await varyAcross({ ...i, location: 'query' }, ctx)
    return { probe: 'idor', ...(out as Record<string, unknown>) }
  }
})

export const probeTools: Tool[] = [
  submitForm as Tool,
  probe_reflection as Tool,
  vary_parameter as Tool,
  compare_roles as Tool,
  check_cors as Tool,
  test_idor as Tool,
  run_tool as Tool
]

export const verifyTools: Tool[] = [
  reproduce as Tool,
  collect_evidence as Tool
]
