import { describe, expect, it, vi } from 'vitest'
import {
  analyze_auth_flow,
  extractIssues,
  parseJwt,
  type AnalyzeAuthFlowOutput,
  type AuthFlowIssue
} from './auth_flow'
import { invokeTool } from '../pipeline'
import { ScopeChecker } from '../scope'
import { ScopeError, ToolInputError } from '../errors'
import type { AuditLogger } from '../audit'
import type { ToolContext } from '../tool'
import type { CapturedRequest } from '../../../shared/tabs'

const audit: AuditLogger = {
  recordIntent: async () => 'call-1',
  recordOutcome: async () => {}
} as unknown as AuditLogger

function req(id: string, extra: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    id,
    tabId: 1,
    method: 'GET',
    url: `https://app.example.com/r/${id}`,
    resourceType: 'xhr',
    startedAt: Number(id) || 1,
    statusCode: 200,
    ...extra
  }
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function find(issues: AuthFlowIssue[], category: AuthFlowIssue['category']): AuthFlowIssue | undefined {
  return issues.find((i) => i.category === category)
}

describe('analyze_auth_flow parse', () => {
  it('rejects a missing flowRequests', () => {
    expect(() => analyze_auth_flow.parse({})).toThrow(ToolInputError)
    expect(() => analyze_auth_flow.parse({})).toThrow(/flowRequests/)
  })

  it('rejects an empty flowRequests', () => {
    expect(() => analyze_auth_flow.parse({ flowRequests: [] })).toThrow(ToolInputError)
    expect(() => analyze_auth_flow.parse({ flowRequests: [] })).toThrow(/at least one/)
  })

  it('rejects a non-array flowRequests', () => {
    expect(() => analyze_auth_flow.parse({ flowRequests: 'nope' })).toThrow(ToolInputError)
    expect(() => analyze_auth_flow.parse({ flowRequests: 7 })).toThrow(/array of strings/)
  })

  it('rejects a non-http(s) loginUrl before it can be a scope target', () => {
    expect(() =>
      analyze_auth_flow.parse({ flowRequests: ['1'], loginUrl: 'file:///etc/passwd' })
    ).toThrow(/http\(s\)/)
  })

  it('targets the login url, and has no target without one', () => {
    const withLogin = analyze_auth_flow.parse({
      flowRequests: ['1'],
      loginUrl: 'https://app.example.com/login'
    })
    expect(analyze_auth_flow.target?.(withLogin)).toBe('https://app.example.com/login')
    expect(analyze_auth_flow.target?.(analyze_auth_flow.parse({ flowRequests: ['1'] }))).toBeUndefined()
  })
})

describe('parseJwt', () => {
  it('decodes the header segment of a well-formed token', () => {
    const token = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub: 'u1' })}.`
    expect(parseJwt(token)).toMatchObject({ alg: 'none', typ: 'JWT' })
  })

  it('rejects values that are not JWTs', () => {
    expect(parseJwt('not-a-jwt')).toBeNull()
    expect(parseJwt('a.b.c')).toBeNull() // header isn't JSON
    expect(parseJwt(`${b64url({ alg: 'HS256' })}.only-two-parts`)).toBeNull()
  })
})

describe('extractIssues', () => {
  it('flags a cleartext http:// request as high', () => {
    const issues = extractIssues([req('1', { url: 'http://app.example.com/login', method: 'POST' })])
    const issue = find(issues, 'cleartext-credentials')
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('high')
    expect(issue?.evidence.requestIds).toEqual(['1'])
  })

  it('flags a credential-like query param as token-in-url (medium)', () => {
    const issues = extractIssues([
      req('1', { url: 'https://app.example.com/cb?access_token=abc123&state=xyz' })
    ])
    const issue = find(issues, 'token-in-url')
    expect(issue?.severity).toBe('medium')
    expect(issue?.evidence.detail).toContain('access_token')
  })

  it('does not flag an innocuous query param', () => {
    const issues = extractIssues([req('1', { url: 'https://app.example.com/search?q=shoes&page=2' })])
    expect(find(issues, 'token-in-url')).toBeUndefined()
  })

  it('flags a Bearer JWT with alg:none as critical', () => {
    const token = `${b64url({ alg: 'none' })}.${b64url({ sub: 'u1' })}.`
    const issues = extractIssues([
      req('1', { requestHeaders: { Authorization: `Bearer ${token}` } })
    ])
    const issue = find(issues, 'weak-jwt-alg')
    expect(issue?.severity).toBe('critical')
    expect(issue?.evidence.detail).toContain('alg=none')
  })

  it('does not flag a JWT with a real algorithm', () => {
    const token = `${b64url({ alg: 'RS256' })}.${b64url({ sub: 'u1' })}.sig`
    const issues = extractIssues([
      req('1', { requestHeaders: { Authorization: `Bearer ${token}` } })
    ])
    expect(find(issues, 'weak-jwt-alg')).toBeUndefined()
  })

  it('flags a session Set-Cookie missing Secure/HttpOnly/SameSite (medium)', () => {
    const issues = extractIssues([
      req('1', { responseHeaders: { 'set-cookie': ['sessionid=abc; Path=/'] } })
    ])
    const issue = find(issues, 'weak-cookie-flags')
    expect(issue?.severity).toBe('medium')
    expect(issue?.evidence.detail).toContain('Secure')
    expect(issue?.evidence.detail).toContain('HttpOnly')
    expect(issue?.evidence.detail).toContain('SameSite')
  })

  it('does not flag a session cookie with all three flags', () => {
    const issues = extractIssues([
      req('1', {
        responseHeaders: {
          'set-cookie': ['sessionid=abc; Path=/; Secure; HttpOnly; SameSite=Lax']
        }
      })
    ])
    expect(find(issues, 'weak-cookie-flags')).toBeUndefined()
  })

  it('ignores non-session cookies for the flag check', () => {
    const issues = extractIssues([
      req('1', { responseHeaders: { 'set-cookie': ['theme=dark; Path=/'] } })
    ])
    expect(find(issues, 'weak-cookie-flags')).toBeUndefined()
  })

  it('flags a missing CSRF header on a POST login', () => {
    const issues = extractIssues([
      req('1', { method: 'POST', url: 'https://app.example.com/login' })
    ])
    expect(find(issues, 'missing-csrf')?.severity).toBe('medium')
  })

  it('does not flag a login that carries an xsrf header', () => {
    const issues = extractIssues([
      req('1', {
        method: 'POST',
        url: 'https://app.example.com/login',
        requestHeaders: { 'X-XSRF-TOKEN': 'abc' }
      })
    ])
    expect(find(issues, 'missing-csrf')).toBeUndefined()
  })

  it('flags an unchanged session id across login as fixation (high)', () => {
    const issues = extractIssues(
      [
        req('1', { requestHeaders: { Cookie: 'sessionid=FIXED123' } }),
        req('2', {
          method: 'POST',
          url: 'https://app.example.com/login',
          requestHeaders: { Cookie: 'sessionid=FIXED123', 'X-CSRF-Token': 't' },
          responseHeaders: {
            'set-cookie': ['sessionid=FIXED123; Path=/; Secure; HttpOnly; SameSite=Lax']
          }
        })
      ],
      { checkSessionFixation: true }
    )
    const issue = find(issues, 'session-fixation')
    expect(issue?.severity).toBe('high')
    expect(issue?.evidence.requestIds).toEqual(['1', '2'])
  })

  it('does not flag fixation when login rotates the session id', () => {
    const issues = extractIssues(
      [
        req('1', { requestHeaders: { Cookie: 'sessionid=OLD' } }),
        req('2', {
          method: 'POST',
          url: 'https://app.example.com/login',
          requestHeaders: { Cookie: 'sessionid=OLD', 'X-CSRF-Token': 't' },
          responseHeaders: {
            'set-cookie': ['sessionid=NEW; Path=/; Secure; HttpOnly; SameSite=Lax']
          }
        })
      ],
      { checkSessionFixation: true }
    )
    expect(find(issues, 'session-fixation')).toBeUndefined()
  })

  it('only runs fixation/logout checks when asked', () => {
    const flow = [
      req('1', { requestHeaders: { Cookie: 'sessionid=SAME' } }),
      req('2', {
        method: 'POST',
        url: 'https://app.example.com/login',
        requestHeaders: { Cookie: 'sessionid=SAME', 'X-CSRF-Token': 't' },
        responseHeaders: { 'set-cookie': ['sessionid=SAME; Secure; HttpOnly; SameSite=Lax'] }
      }),
      req('3', { method: 'POST', url: 'https://app.example.com/logout' }),
      req('4', { requestHeaders: { Cookie: 'sessionid=SAME' } })
    ]
    const issues = extractIssues(flow)
    expect(find(issues, 'session-fixation')).toBeUndefined()
    expect(find(issues, 'logout-not-invalidated')).toBeUndefined()
  })

  it('flags a session cookie still sent after logout (medium)', () => {
    const issues = extractIssues(
      [
        req('1', {
          method: 'POST',
          url: 'https://app.example.com/auth/logout',
          requestHeaders: { Cookie: 'sessionid=OLD' }
        }),
        req('2', {
          url: 'https://app.example.com/api/me',
          requestHeaders: { Cookie: 'sessionid=OLD' }
        })
      ],
      { checkLogoutInvalidation: true }
    )
    const issue = find(issues, 'logout-not-invalidated')
    expect(issue?.severity).toBe('medium')
    expect(issue?.evidence.requestIds).toContain('2')
  })

  it('returns no issues for an empty flow', () => {
    expect(extractIssues([])).toEqual([])
  })

  it('emits one issue per category, listing every offending request', () => {
    const issues = extractIssues([
      req('1', { url: 'http://app.example.com/a' }),
      req('2', { url: 'http://app.example.com/b' })
    ])
    const cleartext = issues.filter((i) => i.category === 'cleartext-credentials')
    expect(cleartext).toHaveLength(1)
    expect(cleartext[0].evidence.requestIds).toEqual(['1', '2'])
    // ids are sequential and stable
    expect(issues.map((i) => i.id)).toEqual(issues.map((_, n) => `auth_flow_${n + 1}`))
  })
})

describe('analyze_auth_flow execute', () => {
  const captured: CapturedRequest[] = [
    req('1', { method: 'POST', url: 'https://app.example.com/login' }),
    req('2', { url: 'http://app.example.com/home' })
  ]

  function execCtx(save = vi.fn(async () => 'trace://trace/analysis-1')): {
    ctx: ToolContext
    get: ReturnType<typeof vi.fn>
    save: typeof save
  } {
    const get = vi.fn((id: string) => captured.find((r) => r.id === id))
    const ctx = {
      engagementId: 'eng-1',
      scope: { config: {}, isInScope: () => true, assertInScope: () => {} },
      network: { list: () => captured, get },
      traces: { save }
    } as unknown as ToolContext
    return { ctx, get, save }
  }

  it('returns issues, a severity summary, and a raw-analysis trace ref', async () => {
    const { ctx, save } = execCtx()
    const res = await invokeTool(
      analyze_auth_flow,
      { flowRequests: ['1', '2', '99'] },
      ctx,
      audit
    )
    expect(res.ok).toBe(true)
    const out = res.output as AnalyzeAuthFlowOutput

    expect(out.summary.total).toBe(out.issues.length)
    expect(out.summary.total).toBe(2) // missing-csrf (1) + cleartext (2)
    expect(out.summary.bySeverity.high).toBe(1)
    expect(out.summary.bySeverity.medium).toBe(1)
    expect(out.summary.bySeverity.critical).toBe(0)

    // the id that aged out is reported, not silently dropped
    expect(out.missingRequestIds).toEqual(['99'])

    expect(out.rawRef).toBe('trace://trace/analysis-1')
    expect(save).toHaveBeenCalledTimes(1)
    const [kind, payload] = save.mock.calls[0] as unknown as [string, string]
    expect(kind).toBe('trace')
    const raw = JSON.parse(payload) as {
      input: { flowRequests: string[] }
      missingRequestIds: string[]
      requests: CapturedRequest[]
      issues: AuthFlowIssue[]
    }
    expect(raw.input.flowRequests).toEqual(['1', '2', '99'])
    expect(raw.missingRequestIds).toEqual(['99'])
    expect(raw.requests.map((r) => r.id)).toEqual(['1', '2'])
    expect(raw.issues).toHaveLength(2)
  })

  it('omits rawRef (without erroring) when the trace store is absent', async () => {
    const get = vi.fn((id: string) => captured.find((r) => r.id === id))
    const ctx = {
      engagementId: 'eng-1',
      scope: { config: {}, isInScope: () => true, assertInScope: () => {} },
      network: { list: () => captured, get }
    } as unknown as ToolContext
    const res = await invokeTool(analyze_auth_flow, { flowRequests: ['1'] }, ctx, audit)
    expect(res.ok).toBe(true)
    expect((res.output as AnalyzeAuthFlowOutput).rawRef).toBeUndefined()
  })

  it('scope-checks loginUrl and never reads requests out of scope', async () => {
    const checker = new ScopeChecker({
      allowed_hosts: ['app.example.com'],
      allowed_cidrs: [],
      denied: [],
      rate_limits: {}
    })
    const get = vi.fn((id: string) => captured.find((r) => r.id === id))
    const ctx = {
      engagementId: 'eng-1',
      scope: checker,
      network: { list: () => captured, get },
      traces: { save: vi.fn(async () => 'trace://x') }
    } as unknown as ToolContext

    expect(() => checker.assertInScope('https://evil.example.net/login')).toThrow(ScopeError)

    const res = await invokeTool(
      analyze_auth_flow,
      { flowRequests: ['1'], loginUrl: 'https://evil.example.net/login' },
      ctx,
      audit
    )
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('OUT_OF_SCOPE')
    expect(get).not.toHaveBeenCalled()
  })
})
