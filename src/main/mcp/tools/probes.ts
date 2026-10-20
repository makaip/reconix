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
const REFLECTION_PARAM = '_reconix_probe'

/** Adds the marker as a query param without overwriting any existing key. */
function addMarkerParam(url: string, marker: string): string {
  const u = new URL(url)
  let name = REFLECTION_PARAM
  for (let n = 2; u.searchParams.has(name); n++) name = `${REFLECTION_PARAM}${n}`
  u.searchParams.set(name, marker)
  return u.href
}

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
      if (!url.includes(marker)) url = addMarkerParam(url, marker)
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
      bodyRef,
      note:
        inBody || inHeaders.length > 0
          ? 'marker reflected — follow up with an encoding/context-specific payload to confirm exploitability'
          : 'marker did not reflect in the body or response headers — try a different parameter name, location (body), or an encoding variant before ruling reflection out'
    }
  }
})

// ── vary helper (shared by vary_parameter and test_idor) ──────────────────────
type VaryLocation = 'query' | 'body' | 'path'
type VaryInput = { base: HttpRequestSpec; paramName: string; values: string[]; location?: VaryLocation }

/** Case-insensitive header lookup (the caller's header casing is arbitrary). */
function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return v
  return undefined
}

function parseJsonObject(body: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(body) as unknown
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Replaces one value in a URL path. Prefers an explicit `{param}` / `:param`
 * placeholder; otherwise swaps the final id-looking segment (numeric or UUID).
 * Throws when the path has no place to put the value — better than silently
 * probing the same URL N times and reporting a fake "no difference".
 */
function setPathParam(rawUrl: string, paramName: string, value: string): string {
  const encoded = encodeURIComponent(value)
  // `urlString` runs the URL constructor, which percent-encodes braces, so the
  // `{id}` convention reaches us as `%7Bid%7D` — accept both spellings.
  const tokens = [
    `{${paramName}}`,
    `%7B${paramName}%7D`,
    `%7b${paramName}%7d`,
    `:${paramName}`
  ]
  for (const token of tokens) {
    if (rawUrl.includes(token)) return rawUrl.split(token).join(encoded)
  }
  const segments = rawUrl.split('/')
  const last = segments.length - 1
  const tail = segments[last].split(/[?#]/)[0]
  if (tail && (/^\d+$/.test(tail) || UUID_RE.test(tail))) {
    // Keep any query/hash suffix attached to the final segment.
    segments[last] = segments[last].replace(tail, encoded)
    return segments.join('/')
  }
  throw new ToolExecError(
    `location "path" needs a {${paramName}} or :${paramName} placeholder in the url, ` +
      'or a numeric/UUID final path segment to vary'
  )
}

/**
 * Writes `value` into `paramName` while preserving the rest of the body.
 *
 * JSON bodies are edited through JSON.parse/stringify — never fed through
 * URLSearchParams, which would mangle quotes and turn a JSON document into a
 * form-encoded blob. URLSearchParams is used only for form-encoded bodies
 * (declared by content-type, or a body that is plainly `k=v&k2=v2`). Anything
 * else gets the raw `&name=value` append, which at least doesn't re-encode
 * bytes the caller already sent.
 */
function setBodyParam(base: HttpRequestSpec, paramName: string, value: string): string {
  const body = base.body ?? ''
  const contentType = headerValue(base.headers, 'content-type') ?? ''
  const jsonBody = body.trim().length > 0 ? parseJsonObject(body) : null

  if (jsonBody) {
    jsonBody[paramName] = value
    return JSON.stringify(jsonBody)
  }
  if (/json/i.test(contentType) && body.trim().length > 0) {
    // Declared JSON but unparseable — refuse to guess rather than re-encode it.
    throw new ToolExecError('location "body": content-type is JSON but the body does not parse as a JSON object')
  }

  const formDeclared = /application\/x-www-form-urlencoded/i.test(contentType)
  const looksForm = body.trim().length === 0 || /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(body.trim())
  if (formDeclared || looksForm) {
    const params = new URLSearchParams(body)
    params.set(paramName, value)
    return params.toString()
  }
  const pair = `${encodeURIComponent(paramName)}=${encodeURIComponent(value)}`
  return body ? `${body}&${pair}` : pair
}

async function varyAcross(i: VaryInput, ctx: Parameters<Tool['execute']>[1]): Promise<unknown> {
  const cap = ctx.policy?.maxReplayBatch ?? 20
  if (i.values.length > cap) {
    const batches = Math.ceil(i.values.length / cap)
    throw new ToolInputError(
      `vary has ${i.values.length} values; max ${cap} per call (engagement policy). ` +
        `Split into ${batches} calls of up to ${cap} values each (e.g. values[0..${cap - 1}], values[${cap}..${cap * 2 - 1}], ...).`
    )
  }
  const location = i.location ?? 'query'
  const buildSpec = (value: string): HttpRequestSpec => {
    if (location === 'path') return { ...i.base, url: setPathParam(i.base.url, i.paramName, value) }
    if (location === 'body') return { ...i.base, body: setBodyParam(i.base, i.paramName, value) }
    const u = new URL(i.base.url)
    u.searchParams.set(i.paramName, value)
    return { ...i.base, url: u.href }
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
  let outOfScope = 0
  for (const r of results) {
    if (typeof r?.status === 'number') {
      statuses[r.status] = (statuses[r.status] ?? 0) + 1
      if (baseline && r !== baseline) {
        r.anomalous = r.status !== baseline.status || r.bodyBytes !== baseline.bodyBytes
      }
    } else {
      errors++
      if (r?.error === 'out of scope — not sent') outOfScope++
    }
  }
  const sent = results.length - errors
  return {
    count: results.length,
    paramName: i.paramName,
    location,
    results,
    summary: { statuses, errors, sent, outOfScope },
    note:
      results.length > 0 && sent === 0
        ? outOfScope === results.length
          ? `no variants were sent: all ${results.length} URLs were out of scope — check base.url against the engagement scope`
          : `no variants were sent: every request failed — inspect the per-row errors (first: ${String(results[0]?.error ?? 'unknown')})`
        : errors > 0
          ? `${errors} of ${results.length} variants failed; inspect their error rows before drawing conclusions`
          : undefined
  }
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
    let stored: { request?: HttpRequestSpec; response?: { status: number; bodyBytes: number; body?: string } }
    try {
      stored = JSON.parse(Buffer.from(trace.data).toString('utf8'))
    } catch {
      throw new ToolExecError('trace is not a reqresp bundle')
    }
    if (!stored?.request?.url) throw new ToolExecError('trace is not a reqresp bundle')
    if (!ctx.scope.isInScope(stored.request.url)) throw new ToolExecError('stored request target out of scope — not sent')
    const result = await ctx.cdp.sendRequest(stored.request)
    // Oracle: status + exact byte length + the first 500 chars of the body.
    // Status+size alone calls two completely different pages a "match" when
    // their lengths coincidentally agree; the body head catches that.
    const expectedHead = typeof stored.response?.body === 'string' ? stored.response.body.slice(0, 500) : null
    const actualHead = result.body.slice(0, 500)
    const statusMatches = !!stored.response && result.status === stored.response.status
    const bytesMatch = !!stored.response && result.bodyBytes === stored.response.bodyBytes
    const bodyMatches = expectedHead === null || expectedHead === actualHead
    const matched = statusMatches && bytesMatch && bodyMatches
    const mismatches = [
      !statusMatches ? `status ${stored.response?.status} → ${result.status}` : null,
      !bytesMatch ? `body bytes ${stored.response?.bodyBytes} → ${result.bodyBytes}` : null,
      !bodyMatches ? 'body head differs' : null
    ].filter((x): x is string => x !== null)
    const reason = matched
      ? undefined
      : !stored.response
        ? 'stored trace has no baseline response to compare against'
        : `response no longer matches: ${mismatches.join('; ')}`
    const newRef = await ctx.traces.save('reqresp', JSON.stringify({ request: stored.request, response: result, reproducedFrom: i.traceRef }))
    return {
      matched,
      reason,
      traceRef: newRef,
      expected: stored.response ? { status: stored.response.status, bodyBytes: stored.response.bodyBytes, bodyHead: expectedHead } : null,
      actual: { status: result.status, statusText: result.statusText, bodyBytes: result.bodyBytes, durationMs: result.durationMs, bodyHead: actualHead },
      checks: { status: statusMatches, bodyBytes: bytesMatch, bodyHead: bodyMatches }
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

/**
 * Kills the whole process tree. A bare child.kill() only signals the direct
 * child, so a wrapper script (nmap -> sh -> helper, any `sh -c`) leaves
 * grandchildren running past the timeout. On POSIX the child is spawned
 * detached, which makes it a process-group leader, so a negative pid signals
 * the group; on Windows taskkill /T walks the tree.
 */
function killProcessTree(child: import('node:child_process').ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      })
    } catch {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
}

/** Appends a chunk without exceeding the byte cap; returns the new total. */
function appendCapped(chunks: Buffer[], total: number, chunk: Buffer): number {
  if (total >= RUN_TOOL_MAX_OUTPUT) return total
  const take = Math.min(chunk.length, RUN_TOOL_MAX_OUTPUT - total)
  chunks.push(chunk.subarray(0, take))
  return total + take
}

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
      const child = spawn(i.binary, i.args ?? [], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        // POSIX: own process group so timeout can signal the whole tree.
        detached: process.platform !== 'win32',
        windowsHide: true
      })
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let killed = false
      let settled = false
      let grace: NodeJS.Timeout | null = null

      const finish = (code: number | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (grace) clearTimeout(grace)
        // Decode once, after all chunks are in: per-chunk slicing split
        // multi-byte UTF-8 sequences at the cap and produced mojibake.
        resolve({
          exitCode: code,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          stdoutTruncated: stdoutBytes >= RUN_TOOL_MAX_OUTPUT,
          stderrTruncated: stderrBytes >= RUN_TOOL_MAX_OUTPUT,
          timedOut: killed
        })
      }

      const timer = setTimeout(() => {
        killed = true
        killProcessTree(child)
        // A grandchild holding the pipes open can delay 'close' forever; report
        // what we captured rather than leaving the MCP call hanging.
        grace = setTimeout(() => finish(null), 1_000)
        grace.unref?.()
      }, timeout)

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes = appendCapped(stdoutChunks, stdoutBytes, chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes = appendCapped(stderrChunks, stderrBytes, chunk)
      })
      child.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (grace) clearTimeout(grace)
        reject(new ToolExecError(`run_tool: failed to spawn "${i.binary}": ${err.message}`))
      })
      child.on('close', (code) => finish(code))
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
    // One row per role, in order. A role that is out of scope (or fails to
    // send) gets its own `error` row instead of aborting the whole comparison —
    // matching replay_batch, so the agent still sees the role that did run.
    const send = async (role: 'A' | 'B', token: string): Promise<Record<string, unknown>> => {
      const hn = i.headerName ?? 'Cookie'
      const spec = { ...i.base, headers: { ...(i.base.headers ?? {}), [hn]: token } }
      if (!ctx.scope.isInScope(spec.url)) {
        return { role, url: spec.url, error: 'out of scope — not sent' }
      }
      try {
        const r = await ctx.cdp.sendRequest(spec)
        const ref = await ctx.traces.save('reqresp', JSON.stringify({ request: spec, response: r, role: token }))
        return {
          role,
          url: spec.url,
          status: r.status,
          statusText: r.statusText,
          bodyBytes: r.bodyBytes,
          durationMs: r.durationMs,
          bodyPreview: clampString(r.body, 200),
          bodyHead: r.body.slice(0, 500),
          bodyRef: ref
        }
      } catch (err) {
        return { role, url: spec.url, error: (err as Error)?.message ?? String(err) }
      }
    }
    const [a, b] = await Promise.all([send('A', i.roleA), send('B', i.roleB)])
    const both = typeof a.status === 'number' && typeof b.status === 'number'
    const statusChanged = both ? a.status !== b.status : null
    const bodyBytesChanged = both ? a.bodyBytes !== b.bodyBytes : null
    const bodyChanged = both ? a.bodyHead !== b.bodyHead : null
    return {
      count: 2,
      roles: [a, b],
      statusChanged,
      bodyBytesChanged,
      bodyChanged,
      anomalous: both ? statusChanged || bodyBytesChanged || bodyChanged : null,
      note: both
        ? statusChanged || bodyBytesChanged || bodyChanged
          ? 'responses differ between roles — confirm the difference exposes data the other role should not see'
          : 'responses are identical for both roles — no evidence of a role-based access difference on this request'
        : `comparison incomplete: role ${typeof a.status === 'number' ? 'B' : 'A'} did not return a response (${String(a.error ?? b.error ?? 'unknown error')}) — fix that role's token/scope and retry`
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
      vulnerable: acao === 'https://evil.example' && acac === 'true',
      note:
        acao === undefined
          ? 'no Access-Control-Allow-Origin header on the response — CORS is not enabled for this endpoint (or the response was an error/cached)'
          : acao === 'https://evil.example' && acac === 'true'
            ? 'arbitrary Origin reflected with credentials — strong CORS misconfiguration signal'
            : `ACAO is ${String(acao)}${acac ? `, ACAC ${String(acac)}` : ''} — not the exploitable reflect+credentials combination`
    }
  }
})

// ── test_idor ─────────────────────────────────────────────────────────────────
const test_idor = defineTool<{ base: HttpRequestSpec; paramName: string; values: string[]; location?: VaryLocation }, unknown>({
  name: 'test_idor',
  description: 'IDOR probe: vary an ID-like parameter (query, body, or {id}/:id path segment) and flag responses that change (access control weakness).',
  riskTier: 'M',
  inputSchema: { type: 'object', required: ['base', 'paramName', 'values'], properties: {
    base: { type: 'object', required: ['url'], properties: { url: { type: 'string' }, method: { type: 'string' }, headers: { type: 'object' }, body: { type: 'string' } } },
    paramName: { type: 'string' }, values: { type: 'array', items: { type: 'string' } },
    location: { type: 'string', enum: ['query', 'body', 'path'] }
  }, additionalProperties: false },
  outputSchema: { type: 'object' },
  parse: (raw) => {
    const location = optStr(raw, 'location') ?? 'query'
    if (location !== 'query' && location !== 'body' && location !== 'path') {
      throw new ToolInputError('"location" must be "query", "body", or "path"')
    }
    return {
      base: parseRequestSpec(raw, 'base'),
      paramName: str(raw, 'paramName'),
      values: strArray(raw, 'values'),
      location: location as VaryLocation
    }
  },
  target: (i) => i.base.url,
  execute: async (i, ctx) => {
    const out = await varyAcross({ ...i, location: i.location ?? 'query' }, ctx)
    return { probe: 'idor', ...(out as Record<string, unknown>) }
  }
})

// ── fuzz (Intruder-style) ────────────────────────────────────────────────────
type FuzzLocation = 'query' | 'body' | 'header' | 'path' | 'marker'
interface FuzzInput {
  base: HttpRequestSpec
  injectionPoint: { location: FuzzLocation; name?: string; marker?: string }
  payloads: string[]
  concurrency?: number
  includeBaseline?: boolean
}

const ERROR_MARKERS = /sql\s*error|syntax error|exception|stack trace|traceback|undefined method|fatal error|warning:/i

function buildFuzzSpec(base: HttpRequestSpec, ip: FuzzInput['injectionPoint'], payload: string): HttpRequestSpec {
  const location = ip.location
  const marker = ip.marker ?? '§'
  if (location === 'marker') {
    const replace = (s: string) => s.split(marker).join(payload)
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(base.headers ?? {})) headers[k] = replace(v)
    return { ...base, url: replace(base.url), body: base.body == null ? base.body : replace(base.body), headers }
  }
  if (location === 'header') {
    const name = ip.name ?? ''
    const headers = { ...(base.headers ?? {}) }
    headers[name] = payload
    return { ...base, headers }
  }
  if (location === 'path') {
    return { ...base, url: setPathParam(base.url, ip.name ?? '', payload) }
  }
  if (location === 'body') {
    return { ...base, body: setBodyParam(base, ip.name ?? '', payload) }
  }
  const u = new URL(base.url)
  u.searchParams.set(ip.name ?? '', payload)
  return { ...base, url: u.href }
}

const fuzz = defineTool<FuzzInput, unknown>({
  name: 'fuzz',
  description:
    'Intruder-style fuzzer: send a base request with one injection point replaced by each payload, collect responses, and flag anomalies (status/length changes, error markers, timing outliers). Payloads can be hand-written or generated with reconix_gen_fuzz_payloads. Scope-checked per request; rate-limited by engagement policy.',
  riskTier: 'M',
  inputSchema: {
    type: 'object',
    required: ['base', 'injectionPoint', 'payloads'],
    additionalProperties: false,
    properties: {
      base: { type: 'object', required: ['url'], properties: { url: { type: 'string' }, method: { type: 'string' }, headers: { type: 'object' }, body: { type: 'string' } } },
      injectionPoint: {
        type: 'object',
        required: ['location'],
        properties: {
          location: { type: 'string', enum: ['query', 'body', 'header', 'path', 'marker'] },
          name: { type: 'string' },
          marker: { type: 'string' }
        }
      },
      payloads: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 },
      concurrency: { type: 'number', minimum: 1, maximum: 5 },
      includeBaseline: { type: 'boolean' }
    }
  },
  outputSchema: { type: 'object' },
  parse: (raw) => {
    const r = (raw ?? {}) as Record<string, unknown>
    const base = parseRequestSpec(raw, 'base')
    const ip = r.injectionPoint as Record<string, unknown> | undefined
    if (typeof ip !== 'object' || ip === null) throw new ToolInputError('"injectionPoint" must be an object')
    const location = ip.location
    if (typeof location !== 'string' || !['query', 'body', 'header', 'path', 'marker'].includes(location)) {
      throw new ToolInputError('"injectionPoint.location" must be query|body|header|path|marker')
    }
    if (location !== 'marker' && (typeof ip.name !== 'string' || !ip.name)) {
      throw new ToolInputError('"injectionPoint.name" is required for query/body/header/path locations')
    }
    const marker = typeof ip.marker === 'string' ? ip.marker : undefined
    const payloads = strArray(raw, 'payloads')
    if (!payloads || payloads.length === 0) throw new ToolInputError('"payloads" must be a non-empty array of strings')
    if (payloads.length > 100) throw new ToolInputError('"payloads" max 100 per call; split into batches')
    const concurrency = typeof r.concurrency === 'number' ? Math.min(5, Math.max(1, Math.floor(r.concurrency))) : 1
    const includeBaseline = typeof r.includeBaseline === 'boolean' ? r.includeBaseline : false
    return { base, injectionPoint: { location: location as FuzzLocation, name: ip.name as string | undefined, marker }, payloads, concurrency, includeBaseline }
  },
  target: (i) => i.base.url,
  execute: async (i, ctx) => {
    const cap = ctx.policy?.maxReplayBatch ?? 20
    if (i.payloads.length > cap * 5) {
      const batches = Math.ceil(i.payloads.length / (cap * 5))
      throw new ToolInputError(`fuzz has ${i.payloads.length} payloads; max ${cap * 5} per call. Split into ${batches} batches.`)
    }
    // Optional baseline request with an empty payload to establish the "normal" response.
    const baselineSpec = i.includeBaseline ? buildFuzzSpec(i.base, i.injectionPoint, '') : null
    const jobs: Array<{ payload: string; index: number }> = i.payloads.map((p, idx) => ({ payload: p, index: idx }))
    const results: Array<Record<string, unknown>> = new Array(i.payloads.length)
    const queue = [...jobs]
    const concurrency = i.concurrency ?? 1
    const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      for (;;) {
        const job = queue.shift()
        if (!job) return
        const { payload, index } = job
        const spec = buildFuzzSpec(i.base, i.injectionPoint, payload)
        const method = (spec.method || 'GET').toUpperCase()
        if (!ctx.scope.isInScope(spec.url)) {
          results[index] = { index, payload, url: spec.url, method, error: 'out of scope — not sent' }
          continue
        }
        try {
          const r = await ctx.cdp.sendRequest(spec)
          const bodyRef = await ctx.traces.save('reqresp', JSON.stringify({ request: spec, response: r }))
          results[index] = {
            index,
            payload,
            url: spec.url,
            method,
            status: r.status,
            statusText: r.statusText,
            bodyBytes: r.bodyBytes,
            durationMs: r.durationMs,
            bodyPreview: clampString(String(r.body ?? ''), 200),
            errorMarker: ERROR_MARKERS.test(r.body) || undefined,
            bodyRef
          }
        } catch (err) {
          results[index] = { index, payload, url: spec.url, method, error: (err as Error)?.message ?? String(err) }
        }
      }
    })
    // Baseline first (if requested) so it anchors anomaly detection.
    let baseline: { status: number; bodyBytes: number; durationMs: number } | null = null
    if (baselineSpec) {
      if (ctx.scope.isInScope(baselineSpec.url)) {
        try {
          const r = await ctx.cdp.sendRequest(baselineSpec)
          baseline = { status: r.status, bodyBytes: r.bodyBytes, durationMs: r.durationMs }
        } catch { /* ignore baseline failure */ }
      }
    }
    await Promise.all(workers)

    // Anomaly detection anchored on the first successful result (or baseline).
    const anchor = baseline ?? (results.find((r) => typeof r?.status === 'number') as { status: number; bodyBytes: number } | undefined)
    const anomalies: number[] = []
    const statusCounts: Record<string, number> = {}
    let errors = 0
    let outOfScope = 0
    for (const r of results) {
      if (r?.error === 'out of scope — not sent') { outOfScope++; continue }
      if (typeof r?.status !== 'number') { errors++; continue }
      statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1
      const isAnom =
        (anchor && (r.status !== anchor.status || r.bodyBytes !== anchor.bodyBytes)) ||
        Boolean(r.errorMarker)
      if (isAnom) anomalies.push(r.index as number)
    }
    const sent = results.length - errors - outOfScope
    return {
      total: i.payloads.length,
      sent,
      failed: errors,
      outOfScope,
      baseline: baseline ?? (anchor ? { status: anchor.status, bodyBytes: anchor.bodyBytes } : null),
      statusCounts,
      anomalies,
      anomalousCount: anomalies.length,
      note: anomalies.length > 0
        ? `${anomalies.length} of ${sent} responses differ from the baseline (status/length/error marker) — inspect those indices first.`
        : sent > 0
          ? 'no anomalies detected against the baseline; try different payloads or a different injection point'
          : 'no requests were sent successfully',
      results
    }
  }
})

export const probeTools: Tool[] = [
  submitForm as Tool,
  probe_reflection as Tool,
  vary_parameter as Tool,
  compare_roles as Tool,
  check_cors as Tool,
  test_idor as Tool,
  run_tool as Tool,
  fuzz as Tool
]

export const verifyTools: Tool[] = [
  reproduce as Tool,
  collect_evidence as Tool
]
