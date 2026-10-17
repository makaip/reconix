// Scope compiler + per-tool scope checker (Dev 4 / §5.D + the 6.5 seam).
//
// ONE ScopeConfig is the source of truth. `compileScope` turns it into the
// deterministic `CompiledScope` artifacts the egress proxy and the nftables
// floor load. `makeScopeChecker` builds the pure, synchronous, deny-by-default
// per-tool check Dev 3's handlers call. Both the proxy and the checker reach
// their verdict by walking the SAME compiled `proxyRules` with the SAME matcher
// (`evaluateProxyRules`), so a URL allowed by one is allowed by the other.
//
// DEFAULT DENY is structural: the compiler always appends a catch-all deny as
// the last proxy rule and a catch-all drop as the last nft rule. Nothing the
// agent does can remove them; an unmatched request falls through to deny.

import type {
  ScopeConfig,
  ScopeTarget,
  ProxyRule,
  NftRule,
  CompiledScope,
  ScopeChecker
} from '../shared/scope'

/** Ports assumed when a target omits them: HTTP + HTTPS only. */
export const DEFAULT_PORTS: readonly number[] = [80, 443]

/** Default port for a URL scheme, used when the URL carries no explicit port. */
function defaultPortForProtocol(protocol: string): number | null {
  switch (protocol) {
    case 'http:':
      return 80
    case 'https:':
      return 443
    default:
      // ws/wss/ftp/etc. are not part of the frozen 80/443 default set — deny.
      return null
  }
}

/** Normalized request coordinates the matcher reasons about. */
export type RequestCoords = {
  host: string // hostname (DNS name or IP literal), lowercased, brackets stripped
  port: number
  path: string // URL pathname, always begins with '/'
}

// ---------------------------------------------------------------------------
// Host + IP matching
// ---------------------------------------------------------------------------

function normalizeHost(host: string): string {
  // Strip IPv6 brackets and lowercase. new URL() keeps `[::1]` bracketed.
  let h = host.trim().toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  return h
}

/**
 * Exact or wildcard host match. `*.example.com` matches any sub-domain
 * (`a.example.com`, `a.b.example.com`) but NOT the apex `example.com` —
 * deny-by-default favours strictness; list the apex explicitly if wanted.
 */
function hostMatches(ruleHost: string, reqHost: string): boolean {
  const rule = ruleHost.trim().toLowerCase()
  const req = reqHost // already normalized
  if (rule.startsWith('*.')) {
    const base = rule.slice(2)
    if (!base) return false
    return req.endsWith('.' + base) && req.length > base.length + 1
  }
  return rule === req
}

function isIpLiteral(host: string): boolean {
  return ipv4ToBig(host) !== null || ipv6ToBig(host) !== null
}

function ipv4ToBig(ip: string): bigint | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  let acc = 0n
  for (let i = 1; i <= 4; i++) {
    const o = Number(m[i])
    if (o > 255) return null
    acc = (acc << 8n) | BigInt(o)
  }
  return acc
}

function ipv6ToBig(ip: string): bigint | null {
  // Reject obvious non-v6 to keep v4 strings out of this path.
  if (!ip.includes(':')) return null
  let str = ip
  // Embedded IPv4 tail (e.g. ::ffff:1.2.3.4) -> convert tail to two hextets.
  const v4tail = str.match(/(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (v4tail) {
    const v4 = ipv4ToBig(v4tail[2])
    if (v4 === null) return null
    const hi = (v4 >> 16n) & 0xffffn
    const lo = v4 & 0xffffn
    str = v4tail[1] + hi.toString(16) + ':' + lo.toString(16)
  }
  const dbl = str.split('::')
  if (dbl.length > 2) return null
  const head = dbl[0] ? dbl[0].split(':') : []
  const tail = dbl.length === 2 ? (dbl[1] ? dbl[1].split(':') : []) : null
  let groups: string[]
  if (tail === null) {
    if (head.length !== 8) return null
    groups = head
  } else {
    const fill = 8 - head.length - tail.length
    if (fill < 0) return null
    groups = [...head, ...Array(fill).fill('0'), ...tail]
  }
  let acc = 0n
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    acc = (acc << 16n) | BigInt(parseInt(g, 16))
  }
  return acc
}

function ipInCidr(host: string, cidr: string): boolean {
  const slash = cidr.lastIndexOf('/')
  if (slash < 0) return false
  const net = cidr.slice(0, slash)
  const bits = Number(cidr.slice(slash + 1))
  if (!Number.isInteger(bits) || bits < 0) return false

  const v4net = ipv4ToBig(net)
  if (v4net !== null) {
    const v4host = ipv4ToBig(host)
    if (v4host === null || bits > 32) return false
    const mask = bits === 0 ? 0n : (~0n << BigInt(32 - bits)) & 0xffffffffn
    return (v4host & mask) === (v4net & mask)
  }

  const v6net = ipv6ToBig(net)
  if (v6net !== null) {
    const v6host = ipv6ToBig(host)
    if (v6host === null || bits > 128) return false
    const mask = bits === 0 ? 0n : (~0n << BigInt(128 - bits)) & ((1n << 128n) - 1n)
    return (v6host & mask) === (v6net & mask)
  }

  return false
}

// ---------------------------------------------------------------------------
// Rule matching (shared by proxy and checker)
// ---------------------------------------------------------------------------

/** True iff a single compiled proxy rule covers the request coordinates. */
export function matchProxyRule(rule: ProxyRule, req: RequestCoords): boolean {
  // Host/CIDR dimension. A rule with neither host nor cidr is a catch-all.
  let hostOk: boolean
  if (rule.cidr) {
    hostOk = isIpLiteral(req.host) && ipInCidr(req.host, rule.cidr)
  } else if (rule.host) {
    // A literal-IP rule host must match an IP request exactly; a DNS rule host
    // matches by name/wildcard. hostMatches handles exact equality either way.
    hostOk = hostMatches(rule.host, req.host)
  } else {
    hostOk = true
  }

  // Port dimension. Empty ports list = any port (catch-all only).
  const portOk = rule.ports.length === 0 ? true : rule.ports.includes(req.port)

  // Path dimension. Empty prefixes = all paths.
  const pathOk =
    rule.pathPrefixes.length === 0
      ? true
      : rule.pathPrefixes.some((p) => req.path === p || req.path.startsWith(p))

  return hostOk && portOk && pathOk
}

/**
 * Walk compiled rules in order; the FIRST matching rule decides. The compiler
 * guarantees a trailing catch-all deny, so an unmatched request is denied.
 * This is the single decision function the proxy and the checker share.
 */
export function evaluateProxyRules(rules: ProxyRule[], req: RequestCoords): 'allow' | 'deny' {
  for (const rule of rules) {
    if (matchProxyRule(rule, req)) return rule.action
  }
  return 'deny'
}

/** Parse a URL into request coordinates. Returns null on anything malformed. */
export function parseUrl(url: string): RequestCoords | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const host = normalizeHost(u.hostname)
  if (!host) return null
  let port: number
  if (u.port) {
    port = Number(u.port)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  } else {
    const def = defaultPortForProtocol(u.protocol)
    if (def === null) return null
    port = def
  }
  return { host, port, path: u.pathname || '/' }
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

function portsFor(t: ScopeTarget): number[] {
  return t.ports && t.ports.length ? [...t.ports] : [...DEFAULT_PORTS]
}

function targetToProxyRule(t: ScopeTarget): ProxyRule {
  const rule: ProxyRule = {
    action: 'allow',
    ports: portsFor(t),
    pathPrefixes: t.paths && t.paths.length ? [...t.paths] : []
  }
  if (t.cidr) rule.cidr = t.cidr
  else if (t.host) rule.host = t.host
  return rule
}

/**
 * Deterministic ScopeConfig -> CompiledScope. Same input, same output.
 * Order: infra allows, then target allows, then the catch-all deny/drop. The
 * model endpoint lives in `infra`, so it compiles to an explicit allow rule
 * ahead of the catch-all. nft rules are address-based (the blunt L3/L4 floor),
 * so only cidr-bearing entries produce an accept; host-only targets are left
 * to the proxy and the floor's default drop (see infra/nftables/README).
 */
export function compileScope(config: ScopeConfig): CompiledScope {
  const proxyRules: ProxyRule[] = []
  const nftRules: NftRule[] = []

  const emit = (t: ScopeTarget): void => {
    proxyRules.push(targetToProxyRule(t))
    if (t.cidr) {
      const nft: NftRule = { action: 'accept', cidr: t.cidr, ports: portsFor(t) }
      nftRules.push(nft)
    }
  }

  for (const t of config.infra) emit(t)
  for (const t of config.targets) emit(t)

  // Catch-all deny / drop — the structural default-deny floor. Always last.
  proxyRules.push({ action: 'deny', ports: [], pathPrefixes: [] })
  nftRules.push({ action: 'drop' })

  return { engagementId: config.engagementId, proxyRules, nftRules }
}

// ---------------------------------------------------------------------------
// Per-tool checker (6.5 seam)
// ---------------------------------------------------------------------------

/**
 * Build the deny-by-default per-tool scope check. It compiles the same config
 * the proxy compiles and evaluates against the identical proxyRules, so proxy
 * and checker never disagree. `method` is accepted per the frozen signature
 * and recorded by callers; the frozen rule shape carries no method dimension,
 * so it does not change the verdict today (reserved for future tightening).
 */
export function makeScopeChecker(config: ScopeConfig): ScopeChecker {
  const compiled = compileScope(config)
  return {
    isAllowed(url: string, _method?: string): boolean {
      const req = parseUrl(url)
      if (req === null) return false // malformed URL -> deny
      return evaluateProxyRules(compiled.proxyRules, req) === 'allow'
    }
  }
}
