import { describe, it, expect } from 'vitest'
import type { ScopeConfig } from '../shared/scope'
import {
  compileScope,
  makeScopeChecker,
  evaluateProxyRules,
  parseUrl,
  matchProxyRule,
  DEFAULT_PORTS
} from './scope'

// A representative engagement: one wildcard DNS target scoped to a path,
// one CIDR target on a custom port, plus an internal model endpoint in infra.
const config: ScopeConfig = {
  engagementId: 'eng-001',
  infra: [{ host: 'model.internal', ports: [8443] }],
  targets: [
    { host: '*.example.com', paths: ['/app/', '/api/'] },
    { cidr: '10.0.0.0/24', ports: [8080] }
  ]
}

/** Evaluate a URL directly against compiled proxy rules (what the proxy does). */
function proxyAllows(cfg: ScopeConfig, url: string): boolean {
  const compiled = compileScope(cfg)
  const req = parseUrl(url)
  if (!req) return false
  return evaluateProxyRules(compiled.proxyRules, req) === 'allow'
}

describe('compileScope', () => {
  it('is deterministic: same config compiles to identical output', () => {
    expect(compileScope(config)).toEqual(compileScope(config))
  })

  it('appends a catch-all deny as the LAST proxy rule', () => {
    const { proxyRules } = compileScope(config)
    const last = proxyRules[proxyRules.length - 1]
    expect(last.action).toBe('deny')
    expect(last.host).toBeUndefined()
    expect(last.cidr).toBeUndefined()
    expect(last.ports).toEqual([]) // empty = any port
    expect(last.pathPrefixes).toEqual([]) // empty = any path
  })

  it('appends a catch-all drop as the LAST nft rule', () => {
    const { nftRules } = compileScope(config)
    const last = nftRules[nftRules.length - 1]
    expect(last.action).toBe('drop')
    expect(last.cidr).toBeUndefined()
  })

  it('compiles the infra model endpoint to an explicit allow before the deny', () => {
    const { proxyRules } = compileScope(config)
    const modelRule = proxyRules.find((r) => r.host === 'model.internal')
    expect(modelRule).toBeDefined()
    expect(modelRule!.action).toBe('allow')
    expect(modelRule!.ports).toEqual([8443])
    expect(proxyRules.indexOf(modelRule!)).toBeLessThan(proxyRules.length - 1)
  })

  it('defaults omitted ports to 80 and 443', () => {
    const { proxyRules } = compileScope(config)
    const wild = proxyRules.find((r) => r.host === '*.example.com')
    expect(wild!.ports).toEqual([...DEFAULT_PORTS])
  })

  it('emits an nft accept only for cidr targets, not host targets', () => {
    const { nftRules } = compileScope(config)
    const accepts = nftRules.filter((r) => r.action === 'accept')
    expect(accepts).toHaveLength(1)
    expect(accepts[0].cidr).toBe('10.0.0.0/24')
    expect(accepts[0].ports).toEqual([8080])
  })
})

describe('deny-by-default', () => {
  it('an empty scope denies everything', () => {
    const checker = makeScopeChecker({ engagementId: 'empty', infra: [], targets: [] })
    expect(checker.isAllowed('https://example.com/')).toBe(false)
    expect(checker.isAllowed('http://10.0.0.1/')).toBe(false)
    expect(checker.isAllowed('https://anything.test/path')).toBe(false)
  })

  it('a malformed URL is denied', () => {
    const checker = makeScopeChecker(config)
    expect(checker.isAllowed('not-a-url')).toBe(false)
    expect(checker.isAllowed('')).toBe(false)
    expect(checker.isAllowed('javascript:alert(1)')).toBe(false)
  })

  it('a non-80/443 scheme with no explicit port is denied', () => {
    const checker = makeScopeChecker(config)
    // ftp has no default in the frozen 80/443 set
    expect(checker.isAllowed('ftp://app.example.com/app/')).toBe(false)
  })
})

describe('proxy rules and ScopeChecker agree', () => {
  const checker = makeScopeChecker(config)
  const urls = [
    'https://app.example.com/app/index.html', // in scope: wildcard + path + 443
    'https://app.example.com/admin', // out: path not allowed
    'http://app.example.com/app/x', // in: wildcard + path + 80
    'https://example.com/app/', // out: apex not matched by *.example.com
    'https://a.b.example.com/api/v1', // in: multi-label wildcard + path
    'https://app.example.com:8081/app/', // out: port 8081 not in defaults
    'http://10.0.0.5:8080/anything', // in: cidr + port 8080
    'http://10.0.0.5/anything', // out: port 80 not in cidr target ports
    'http://10.0.1.5:8080/anything', // out: outside /24
    'https://model.internal:8443/v1/chat', // in: infra model endpoint
    'https://model.internal/v1/chat', // out: wrong port for model
    'https://evil.test/' // out: not listed at all
  ]

  it.each(urls)('checker and compiled proxyRules give the SAME verdict for %s', (url) => {
    expect(checker.isAllowed(url)).toBe(proxyAllows(config, url))
  })

  it('a known in-scope URL passes BOTH the compiled proxyRules and the ScopeChecker', () => {
    const url = 'https://app.example.com/app/index.html'
    expect(proxyAllows(config, url)).toBe(true)
    expect(checker.isAllowed(url)).toBe(true)
  })
})

describe('out-of-scope rejection', () => {
  const checker = makeScopeChecker(config)

  it('rejects an out-of-scope host', () => {
    expect(checker.isAllowed('https://evil.test/')).toBe(false)
    expect(checker.isAllowed('https://example.com.evil.test/app/')).toBe(false)
  })

  it('rejects an out-of-scope port on an in-scope host', () => {
    expect(checker.isAllowed('https://app.example.com:9999/app/')).toBe(false)
    expect(checker.isAllowed('http://10.0.0.5:9090/x')).toBe(false)
  })

  it('rejects an out-of-scope path on an in-scope host', () => {
    expect(checker.isAllowed('https://app.example.com/secret')).toBe(false)
    expect(checker.isAllowed('https://app.example.com/')).toBe(false)
  })

  it('rejects the apex when only a wildcard is listed', () => {
    expect(checker.isAllowed('https://example.com/app/')).toBe(false)
  })

  it('rejects an IP outside the CIDR block', () => {
    expect(checker.isAllowed('http://10.0.1.1:8080/')).toBe(false)
    expect(checker.isAllowed('http://192.168.0.1:8080/')).toBe(false)
  })
})

describe('matching primitives', () => {
  it('matches CIDR boundaries correctly', () => {
    const rule = { action: 'allow' as const, cidr: '10.0.0.0/24', ports: [80], pathPrefixes: [] }
    expect(matchProxyRule(rule, { host: '10.0.0.0', port: 80, path: '/' })).toBe(true)
    expect(matchProxyRule(rule, { host: '10.0.0.255', port: 80, path: '/' })).toBe(true)
    expect(matchProxyRule(rule, { host: '10.0.1.0', port: 80, path: '/' })).toBe(false)
  })

  it('wildcard matches sub-domains but not the apex', () => {
    const rule = { action: 'allow' as const, host: '*.example.com', ports: [443], pathPrefixes: [] }
    expect(matchProxyRule(rule, { host: 'a.example.com', port: 443, path: '/' })).toBe(true)
    expect(matchProxyRule(rule, { host: 'a.b.example.com', port: 443, path: '/' })).toBe(true)
    expect(matchProxyRule(rule, { host: 'example.com', port: 443, path: '/' })).toBe(false)
    expect(matchProxyRule(rule, { host: 'notexample.com', port: 443, path: '/' })).toBe(false)
  })

  it('supports IPv6 CIDR matching', () => {
    const rule = { action: 'allow' as const, cidr: '2001:db8::/32', ports: [443], pathPrefixes: [] }
    expect(matchProxyRule(rule, { host: '2001:db8::1', port: 443, path: '/' })).toBe(true)
    expect(matchProxyRule(rule, { host: '2001:db9::1', port: 443, path: '/' })).toBe(false)
  })
})
