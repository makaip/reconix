/*
 * Reconix egress proxy — the SMART wall in front of the OpenCode container.
 *
 * Every byte the agent container sends to the outside world is meant to pass
 * through here (HTTP_PROXY / HTTPS_PROXY point at it; the nftables floor drops
 * anything that tries to go around it). The proxy loads the SAME ScopeConfig
 * the per-tool checker uses, compiles it with the SAME compiler, and decides
 * with the SAME matcher (`evaluateProxyRules`) — so proxy and checker never
 * disagree. Default deny: the compiled rule list ends in a catch-all deny.
 *
 *   in-scope  -> forward + structured allow log
 *   otherwise -> drop    + structured deny log
 *
 * The model endpoint lives in ScopeConfig.infra, so it compiles to an explicit
 * allow rule ahead of the catch-all — the container can reach inference, and
 * that path is explicit, never open internet.
 *
 * Run from compose as a second service; see infra/proxy/README.md.
 */

import http from 'node:http'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import type { ScopeConfig, CompiledScope } from '../../src/shared/scope'
import {
  compileScope,
  evaluateProxyRules,
  type RequestCoords
} from '../../src/main/scope'

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

const SCOPE_CONFIG_PATH = process.env.SCOPE_CONFIG_PATH ?? '/etc/reconix/scope.json'
const LISTEN_HOST = process.env.PROXY_LISTEN_HOST ?? '0.0.0.0' // inside container net only
const LISTEN_PORT = Number(process.env.PROXY_LISTEN_PORT ?? '8888')

/**
 * Rate-limit knob. Scope says WHERE traffic may go; the limiter bounds HOW HARD
 * it hits an in-scope host. "Safe to pound" is a human judgement and is OFF by
 * default — conservative. Flip it on (and raise rps) only for a target a human
 * has confirmed is safe to hammer. An out-of-scope host is dropped regardless.
 */
type RateConfig = {
  safeToPound: boolean // default false = conservative
  requestsPerSecond: number // per target host
  burst: number // token-bucket depth
}

function loadRateConfig(): RateConfig {
  const safeToPound = process.env.SAFE_TO_POUND === 'true'
  // Conservative default when not explicitly cleared to pound.
  const defaultRps = safeToPound ? 50 : 1
  const requestsPerSecond = Number(process.env.RATE_RPS_PER_TARGET ?? String(defaultRps))
  const burst = Number(process.env.RATE_BURST ?? String(Math.max(1, requestsPerSecond)))
  return { safeToPound, requestsPerSecond, burst }
}

function loadScope(): { config: ScopeConfig; compiled: CompiledScope } {
  const raw = readFileSync(SCOPE_CONFIG_PATH, 'utf8')
  const config = JSON.parse(raw) as ScopeConfig
  const compiled = compileScope(config)
  return { config, compiled }
}

const { config, compiled } = loadScope()
const rate = loadRateConfig()

// ---------------------------------------------------------------------------
// Structured logging (one JSON object per line, to stdout)
// ---------------------------------------------------------------------------

type Decision = 'allow' | 'deny' | 'ratelimit'

function logLine(fields: Record<string, unknown>): void {
  process.stdout.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      engagementId: compiled.engagementId,
      ...fields
    }) + '\n'
  )
}

// ---------------------------------------------------------------------------
// Per-target token-bucket rate limiter
// ---------------------------------------------------------------------------

const buckets = new Map<string, { tokens: number; last: number }>()

function allowByRate(targetKey: string): boolean {
  if (rate.requestsPerSecond <= 0) return false // 0 rps = never (hard pause)
  const now = Date.now()
  const b = buckets.get(targetKey) ?? { tokens: rate.burst, last: now }
  const elapsed = (now - b.last) / 1000
  b.tokens = Math.min(rate.burst, b.tokens + elapsed * rate.requestsPerSecond)
  b.last = now
  if (b.tokens < 1) {
    buckets.set(targetKey, b)
    return false
  }
  b.tokens -= 1
  buckets.set(targetKey, b)
  return true
}

// ---------------------------------------------------------------------------
// Scope decision (shared matcher — identical to the per-tool ScopeChecker)
// ---------------------------------------------------------------------------

function coordsFrom(host: string, port: number, path: string): RequestCoords {
  let h = host.trim().toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  return { host: h, port, path: path || '/' }
}

function scopeAllows(req: RequestCoords): boolean {
  return evaluateProxyRules(compiled.proxyRules, req) === 'allow'
}

// ---------------------------------------------------------------------------
// Plain HTTP (absolute-form request-target through a forward proxy)
// ---------------------------------------------------------------------------

const server = http.createServer((clientReq, clientRes) => {
  let target: URL
  try {
    target = new URL(clientReq.url ?? '')
  } catch {
    logLine({ decision: 'deny', reason: 'malformed-url', raw: clientReq.url })
    clientRes.writeHead(400).end('bad request-target')
    return
  }
  const port = target.port ? Number(target.port) : target.protocol === 'https:' ? 443 : 80
  const req = coordsFrom(target.hostname, port, target.pathname)
  const method = clientReq.method ?? 'GET'

  if (!scopeAllows(req)) {
    logLine({ decision: 'deny', reason: 'out-of-scope', method, host: req.host, port: req.port, path: req.path })
    clientRes.writeHead(403).end('out of scope')
    return
  }
  const key = `${req.host}:${req.port}`
  if (!allowByRate(key)) {
    logLine({ decision: 'ratelimit', method, host: req.host, port: req.port, path: req.path, rps: rate.requestsPerSecond, safeToPound: rate.safeToPound })
    clientRes.writeHead(429).end('rate limited')
    return
  }

  logLine({ decision: 'allow', layer: 'http', method, host: req.host, port: req.port, path: req.path })

  const upstream = http.request(
    {
      host: req.host,
      port: req.port,
      method,
      path: target.pathname + target.search,
      headers: clientReq.headers
    },
    (upRes) => {
      clientRes.writeHead(upRes.statusCode ?? 502, upRes.headers)
      upRes.pipe(clientRes)
    }
  )
  upstream.on('error', (err) => {
    logLine({ decision: 'allow', layer: 'http', note: 'upstream-error', host: req.host, error: String(err) })
    if (!clientRes.headersSent) clientRes.writeHead(502)
    clientRes.end('upstream error')
  })
  clientReq.pipe(upstream)
})

// ---------------------------------------------------------------------------
// HTTPS tunnels (CONNECT). The TLS body is opaque, so only host+port are
// checkable here — path-prefix rules apply to plaintext HTTP only (documented).
// ---------------------------------------------------------------------------

server.on('connect', (connectReq, clientSocket, head) => {
  const [hostPart, portPart] = (connectReq.url ?? '').split(':')
  const port = Number(portPart ?? '443')
  // Path unknown under TLS; evaluate with '/' — a host whose rule is path-scoped
  // for HTTP will still match on host+port here, which is the honest best we can
  // enforce at the tunnel. Tighten with explicit ports if that is too loose.
  const req = coordsFrom(hostPart ?? '', port, '/')

  if (!req.host || !scopeAllows(req)) {
    logLine({ decision: 'deny', layer: 'connect', reason: 'out-of-scope', host: req.host, port: req.port })
    clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    clientSocket.end()
    return
  }
  const key = `${req.host}:${req.port}`
  if (!allowByRate(key)) {
    logLine({ decision: 'ratelimit', layer: 'connect', host: req.host, port: req.port, rps: rate.requestsPerSecond, safeToPound: rate.safeToPound })
    clientSocket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n')
    clientSocket.end()
    return
  }

  logLine({ decision: 'allow', layer: 'connect', host: req.host, port: req.port })

  const upstream = net.connect(req.port, req.host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head && head.length) upstream.write(head)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })
  upstream.on('error', (err) => {
    logLine({ decision: 'allow', layer: 'connect', note: 'upstream-error', host: req.host, error: String(err) })
    clientSocket.end()
  })
  clientSocket.on('error', () => upstream.end())
})

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  logLine({
    decision: 'allow',
    note: 'proxy-up',
    listen: `${LISTEN_HOST}:${LISTEN_PORT}`,
    ruleCount: compiled.proxyRules.length,
    safeToPound: rate.safeToPound,
    rpsPerTarget: rate.requestsPerSecond
  })
})
