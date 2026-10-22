// analyze_auth_flow — ARCHITECTURE §5.E (auth / session analysis).
//
// Read-only analysis over requests that are ALREADY captured on the target tab:
// it never sends traffic, never touches the network and never records findings.
// The orchestrator takes the suspected issues it wants to keep, has the
// evaluator confirm them, then calls record_finding itself. Because nothing is
// emitted, the whole tool stays tier R.
//
// The analysis is deliberately evidence-shaped: every issue points at the
// captured request ids it came from, so a finding can be traced back to real
// traffic rather than to this tool's opinion.
import { defineTool, type Tool } from '../tool'
import { ToolInputError } from '../errors'
import { MAX_LIST_ITEMS, MAX_FIELD_CHARS, clampString } from '../limits'
import type { CapturedRequest } from '../../../shared/tabs'

// ─── Types ─────────────────────────────────────────────────────────────────

export type AuthFlowCategory =
  | 'cleartext-credentials'
  | 'token-in-url'
  | 'missing-csrf'
  | 'session-fixation'
  | 'logout-not-invalidated'
  | 'weak-jwt-alg'
  | 'weak-cookie-flags'

export type AuthFlowSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export interface AuthFlowIssue {
  id: string // 'auth_flow_<n>'
  category: AuthFlowCategory
  severity: AuthFlowSeverity
  title: string
  description: string
  evidence: { requestIds: string[]; detail: string }
  recommendation: string
}

export interface AnalyzeAuthFlowInput {
  flowRequests: string[]
  loginUrl?: string
  authCookieNames?: string[]
  checkSessionFixation?: boolean
  checkLogoutInvalidation?: boolean
}

export interface AnalyzeAuthFlowOutput {
  issues: AuthFlowIssue[]
  summary: { total: number; bySeverity: Record<AuthFlowSeverity, number> }
  /** Trace ref of the raw analysis JSON (input + requests + issues). Absent
   *  when the surface has no trace store. */
  rawRef?: string
  /** Flow ids that were not in the network log (aged out / wrong tab). Their
   *  absence weakens the analysis, so it is reported rather than hidden. */
  missingRequestIds?: string[]
}

/** Options for extractIssues — the analysis half is network-free so it can be
 *  unit-tested (and reused) without a ToolContext. */
export interface ExtractIssuesOptions {
  authCookieNames?: string[]
  checkSessionFixation?: boolean
  checkLogoutInvalidation?: boolean
}

// ─── Constants ─────────────────────────────────────────────────────────────

/** Session cookie names treated as auth tokens when the caller names none. */
export const DEFAULT_AUTH_COOKIE_NAMES: readonly string[] = [
  'session',
  'sessionid',
  'jsessionid',
  'phpsessid',
  'asp.net sessionid',
  'auth',
  'token',
  'access_token'
]

export const MAX_FLOW_REQUESTS = 50
export const MAX_AUTH_COOKIE_NAMES = 16

// A login-like path: /login, /signin, /auth..., /sso, or anything containing
// "login"/"signin" (covers /login.aspx, /users/login, /login/step2).
const LOGIN_SEGMENT_RE = /(?:^|\/)(?:log-?in|sign-?in|signon|sign-?on|auth|authenticate|sso)(?:\/|$)/i
// A logout-like path: /logout, /signout, /auth/logout (also /logout.aspx).
const LOGOUT_SEGMENT_RE = /(?:^|\/)(?:log-?out|sign-?out|signoff|sign-?off)(?:\/|$)/i
// Any CSRF-ish request header counts — X-CSRF-Token, X-XSRF-TOKEN, X-CSRFToken.
const CSRF_HEADER_RE = /csrf|xsrf/i
// Query parameter names that carry credentials/tokens. The boundary form
// catches `?token=`, `?access_token=`, `?api-key=`; the substring form catches
// camelCase composites (`accessToken`, `sessionId`).
const TOKEN_PARAM_BOUNDARY_RE =
  /(?:^|[^a-z0-9])(?:token|session|password|passwd|pass|secret|key|auth|jwt|credential)(?:$|[^a-z0-9])/i
const TOKEN_PARAM_SUBSTRINGS = [
  'token',
  'session',
  'passw',
  'secret',
  'apikey',
  'api_key',
  'api-key',
  'jwt',
  'credential'
]

// ─── Low-level helpers ─────────────────────────────────────────────────────

function pathOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    // Not an absolute URL — fall back to the raw path-ish prefix.
    return url.split('?')[0].split('#')[0]
  }
}

function isLoginPath(pathname: string): boolean {
  const p = pathname.toLowerCase()
  return p.includes('login') || p.includes('signin') || LOGIN_SEGMENT_RE.test(p)
}

function isLogoutPath(pathname: string): boolean {
  const p = pathname.toLowerCase()
  return p.includes('logout') || LOGOUT_SEGMENT_RE.test(p)
}

function isTokenParamName(name: string): boolean {
  const n = name.toLowerCase()
  return TOKEN_PARAM_BOUNDARY_RE.test(n) || TOKEN_PARAM_SUBSTRINGS.some((h) => n.includes(h))
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v
  }
  return undefined
}

/** All values for a response header name (case-insensitive). Set-Cookie is a
 *  multi-value header, so this must not stop at the first match. */
function responseHeaderValues(
  headers: Record<string, string[]> | undefined,
  name: string
): string[] {
  if (!headers) return []
  const lower = name.toLowerCase()
  const out: string[] = []
  for (const [k, values] of Object.entries(headers)) {
    if (k.toLowerCase() !== lower) continue
    for (const v of values) if (typeof v === 'string') out.push(v)
  }
  return out
}

function hasHeaderMatching(headers: Record<string, string> | undefined, re: RegExp): boolean {
  if (!headers) return false
  return Object.keys(headers).some((k) => re.test(k))
}

function parseCookieHeader(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (name.length > 0) out[name] = value
  }
  return out
}

interface ParsedSetCookie {
  name: string
  value: string
  /** Attribute names lower-cased; a valueless attribute (Secure, HttpOnly) maps
   *  to the empty string, so presence is `'secure' in attrs`. */
  attrs: Record<string, string>
  raw: string
}

function parseSetCookie(raw: string): ParsedSetCookie | null {
  const parts = raw.split(';')
  const first = parts[0] ?? ''
  const eq = first.indexOf('=')
  if (eq <= 0) return null
  const name = first.slice(0, eq).trim()
  const value = first.slice(eq + 1).trim()
  if (name.length === 0) return null
  const attrs: Record<string, string> = {}
  for (const part of parts.slice(1)) {
    const seg = part.trim()
    if (seg.length === 0) continue
    const i = seg.indexOf('=')
    if (i === -1) attrs[seg.toLowerCase()] = ''
    else attrs[seg.slice(0, i).trim().toLowerCase()] = seg.slice(i + 1).trim()
  }
  return { name, value, attrs, raw }
}

/** Cookie names are compared loosely (`ASP.NET_SessionId` == `asp.net sessionid`)
 *  so the defaults match whatever casing/separator a stack chose. */
function normalizeCookieName(name: string): string {
  return name.toLowerCase().replace(/[\s._-]/g, '')
}

function cookieNameSet(names?: readonly string[]): Set<string> {
  const source = names && names.length > 0 ? names : DEFAULT_AUTH_COOKIE_NAMES
  return new Set(source.map(normalizeCookieName))
}

function isAuthCookie(name: string, names: Set<string>): boolean {
  return names.has(normalizeCookieName(name))
}

function sessionFromCookieHeader(r: CapturedRequest, names: Set<string>): string | undefined {
  const raw = headerValue(r.requestHeaders, 'cookie')
  if (!raw) return undefined
  for (const [name, value] of Object.entries(parseCookieHeader(raw))) {
    if (isAuthCookie(name, names)) return value
  }
  return undefined
}

function sessionSetCookies(r: CapturedRequest, names: Set<string>): ParsedSetCookie[] {
  const out: ParsedSetCookie[] = []
  for (const raw of responseHeaderValues(r.responseHeaders, 'set-cookie')) {
    const parsed = parseSetCookie(raw)
    if (parsed && isAuthCookie(parsed.name, names)) out.push(parsed)
  }
  return out
}

// ─── JWT ───────────────────────────────────────────────────────────────────

/** Decode a JWT's header segment, or null when the token isn't shaped like a
 *  JWT (not 3 dot-separated segments, or the header isn't a JSON object).
 *
 *  Decoding only — the signature is never checked, because this is static
 *  inspection of traffic the browser already sent and the tool must not treat
 *  a token as trusted either way. A header without `alg` still parses: that is
 *  exactly the "weak/missing alg" case the caller wants flagged. */
export function parseJwt(token: string): Record<string, unknown> | null {
  const parts = token.trim().split('.')
  if (parts.length !== 3) return null
  if (parts[0].length === 0) return null
  let decoded: string
  try {
    decoded = Buffer.from(parts[0], 'base64url').toString('utf8')
  } catch {
    return null
  }
  let header: unknown
  try {
    header = JSON.parse(decoded)
  } catch {
    return null
  }
  if (typeof header !== 'object' || header === null || Array.isArray(header)) return null
  return header as Record<string, unknown>
}

function isWeakJwtAlg(alg: unknown): boolean {
  if (typeof alg !== 'string') return true // absent, null, or non-string
  const a = alg.trim().toLowerCase()
  return a.length === 0 || a === 'none'
}

function bearerToken(headers: Record<string, string> | undefined): string | undefined {
  const raw = headerValue(headers, 'authorization')
  if (!raw) return undefined
  const m = /^bearer\s+(.+)$/i.exec(raw.trim())
  return m ? m[1].trim() : undefined
}

// ─── Analysis ──────────────────────────────────────────────────────────────

function summarize(issues: AuthFlowIssue[]): AnalyzeAuthFlowOutput['summary'] {
  const bySeverity: Record<AuthFlowSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0
  }
  for (const issue of issues) bySeverity[issue.severity]++
  return { total: issues.length, bySeverity }
}

const TITLES: Record<AuthFlowCategory, string> = {
  'cleartext-credentials': 'Credentials sent over cleartext HTTP',
  'token-in-url': 'Credential/token material in URL query string',
  'missing-csrf': 'Login form submission without a CSRF token',
  'session-fixation': 'Session identifier not rotated at login',
  'logout-not-invalidated': 'Session cookie still sent after logout',
  'weak-jwt-alg': 'JWT signed with a weak/missing algorithm',
  'weak-cookie-flags': 'Session cookie missing security attributes'
}

const RECOMMENDATIONS: Record<AuthFlowCategory, string> = {
  'cleartext-credentials':
    'Serve the whole authentication flow over HTTPS and redirect plain HTTP before any credential is ' +
    'typed. Verify with a proxy that no credential-bearing request leaves over http://.',
  'token-in-url':
    'Move tokens/session identifiers out of the query string into a header or POST body. URLs land in ' +
    'logs, Referer headers, and browser history; check whether the value appears in any third-party ' +
    'request or access log.',
  'missing-csrf':
    'Require and verify a CSRF token (or a SameSite=Strict/Lax session cookie) on state-changing ' +
    'authentication requests. Confirm the server actually rejects a request with no/forged token.',
  'session-fixation':
    'Issue a brand-new session identifier on successful authentication and drop the pre-login one. ' +
    'Re-test by replaying the pre-login cookie against an authenticated endpoint.',
  'logout-not-invalidated':
    'Invalidate the session server-side and expire the cookie (Max-Age=0 / empty value) on logout. ' +
    'Re-test by replaying the captured cookie against an authenticated endpoint after logout.',
  'weak-jwt-alg':
    'Reject unsigned ("none") tokens server-side and pin an asymmetric algorithm (e.g. RS256/ES256). ' +
    'Re-test by resending the accepted token with a stripped signature.',
  'weak-cookie-flags':
    'Set Secure, HttpOnly and SameSite on every session cookie, and scope it with Path/Domain as ' +
    'narrowly as the app allows.'
}

const DESCRIPTIONS: Record<AuthFlowCategory, string> = {
  'cleartext-credentials':
    'Part of the captured auth flow is fetched over plain HTTP, so credentials, session cookies and ' +
    'tokens travel unencrypted and can be read or modified by anyone on the path.',
  'token-in-url':
    'A request in the flow carries credential-like material in its query string, where it is retained ' +
    'in logs, proxy caches and the Referer header.',
  'missing-csrf':
    'A state-changing authentication request (login/registration) has no CSRF token header, so a ' +
    'cross-site form can drive it with the victim\'s ambient cookies.',
  'session-fixation':
    'The session cookie value is identical before and after the login request, so an attacker who ' +
    'planted that cookie keeps the authenticated session.',
  'logout-not-invalidated':
    'A session cookie is still being sent on requests after the logout request, suggesting the logout ' +
    'only cleared client-side state (or did not rotate the identifier).',
  'weak-jwt-alg':
    'A bearer token in the flow declares a JWT algorithm of "none" (or has no usable alg), so its ' +
    'signature is not meaningfully verified and claims can be forged.',
  'weak-cookie-flags':
    'A session cookie is issued without Secure/HttpOnly/SameSite, exposing it to network sniffing, ' +
    'XSS reads, or cross-site request attachment.'
}

interface IssueDraft {
  category: AuthFlowCategory
  severity: AuthFlowSeverity
  requestIds: string[]
  detail: string
}

/**
 * Analyze a captured auth flow for suspected authentication issues.
 * Network-free and deterministic: one issue per distinct finding (all offending
 * requests are listed in that issue's evidence).
 */
export function extractIssues(
  requests: CapturedRequest[],
  opts: ExtractIssuesOptions = {}
): AuthFlowIssue[] {
  if (requests.length === 0) return []
  const names = cookieNameSet(opts.authCookieNames)
  const drafts: IssueDraft[] = []

  // 1. Cleartext credentials — any request in the flow over plain HTTP.
  const cleartext = requests.filter((r) => {
    try {
      return new URL(r.url).protocol === 'http:'
    } catch {
      return false
    }
  })
  if (cleartext.length > 0) {
    drafts.push({
      category: 'cleartext-credentials',
      severity: 'high',
      requestIds: cleartext.map((r) => r.id),
      detail: cleartext.map((r) => `${r.method} ${clampString(r.url, 160)}`).join('; ')
    })
  }

  // 2. Token/credential material in a query string.
  const tokenInUrl: Array<{ r: CapturedRequest; params: string[] }> = []
  for (const r of requests) {
    let params: string[] = []
    try {
      const u = new URL(r.url)
      params = [...u.searchParams.keys()].filter(isTokenParamName)
    } catch {
      // Unparsable URL — nothing to inspect, and past calls already flag it.
    }
    if (params.length > 0) tokenInUrl.push({ r, params })
  }
  if (tokenInUrl.length > 0) {
    drafts.push({
      category: 'token-in-url',
      severity: 'medium',
      requestIds: tokenInUrl.map(({ r }) => r.id),
      detail: tokenInUrl
        .map(({ r, params }) => `${clampString(r.url, 160)} (param: ${params.join(', ')})`)
        .join('; ')
    })
  }

  // 3. Missing CSRF token on a state-changing login-like request.
  const missingCsrf = requests.filter((r) => {
    const method = (r.method || '').toUpperCase()
    if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') return false
    const path = pathOf(r.url)
    // /auth/logout matches the login regex on its segment, but it is not a
    // credential submission — don't report it as a missing CSRF token.
    if (!isLoginPath(path) || isLogoutPath(path)) return false
    return !hasHeaderMatching(r.requestHeaders, CSRF_HEADER_RE)
  })
  if (missingCsrf.length > 0) {
    drafts.push({
      category: 'missing-csrf',
      severity: 'medium',
      requestIds: missingCsrf.map((r) => r.id),
      detail:
        `${missingCsrf
          .map((r) => `${r.method.toUpperCase()} ${clampString(pathOf(r.url), 120)}`)
          .join('; ')} — no csrf/xsrf header present on the request`
    })
  }

  // 4. Session fixation — the session value must CHANGE across the login
  // boundary. Only the last value observed before login is compared against the
  // first one issued at/after it.
  if (opts.checkSessionFixation === true) {
    const loginIdx = requests.findIndex(
      (r) => (r.method || '').toUpperCase() === 'POST' && isLoginPath(pathOf(r.url))
    )
    if (loginIdx >= 0) {
      let before: { value: string; requestId: string; source: string } | undefined
      for (let i = 0; i < loginIdx; i++) {
        const set = sessionSetCookies(requests[i], names)
        if (set.length > 0) {
          before = { value: set[0].value, requestId: requests[i].id, source: 'Set-Cookie' }
          continue
        }
        const fromHeader = sessionFromCookieHeader(requests[i], names)
        if (fromHeader !== undefined) {
          before = { value: fromHeader, requestId: requests[i].id, source: 'Cookie header' }
        }
      }
      let after: { value: string; requestId: string } | undefined
      for (let i = loginIdx; i < requests.length && !after; i++) {
        const set = sessionSetCookies(requests[i], names)
        if (set.length > 0) after = { value: set[0].value, requestId: requests[i].id }
      }
      if (before && after && before.value.length > 0 && before.value === after.value) {
        drafts.push({
          category: 'session-fixation',
          severity: 'high',
          requestIds: [before.requestId, after.requestId],
          detail:
            `session value "${clampString(before.value, 80)}" observed in ${before.source} on ` +
            `${before.requestId} is still the value issued on ${after.requestId} after the login request`
        })
      }
    }
  }

  // 5. Logout invalidation — is a session cookie still in play afterwards?
  if (opts.checkLogoutInvalidation === true) {
    let logoutIdx = -1
    requests.forEach((r, i) => {
      if (isLogoutPath(pathOf(r.url))) logoutIdx = i
    })
    if (logoutIdx >= 0 && logoutIdx < requests.length - 1) {
      const preLogoutValue = sessionFromCookieHeader(requests[logoutIdx], names)
      const staleCarriers: Array<{ r: CapturedRequest; cookieNames: string[] }> = []
      const reissued: Array<{ r: CapturedRequest; name: string }> = []
      for (const r of requests.slice(logoutIdx + 1)) {
        const sent = headerValue(r.requestHeaders, 'cookie')
        if (sent) {
          const carried = Object.keys(parseCookieHeader(sent)).filter((n) => isAuthCookie(n, names))
          if (carried.length > 0) staleCarriers.push({ r, cookieNames: carried })
        }
        for (const sc of sessionSetCookies(r, names)) {
          // A fresh, different session id after logout is normal; re-issuing the
          // SAME id (or refusing to clear it) is the finding.
          if (preLogoutValue === undefined || sc.value === preLogoutValue) {
            reissued.push({ r, name: sc.name })
          }
        }
      }
      if (staleCarriers.length > 0 || reissued.length > 0) {
        const parts: string[] = []
        if (staleCarriers.length > 0) {
          parts.push(
            `session cookie still sent on ${staleCarriers
              .map(({ r, cookieNames }) => `${r.id} (${cookieNames.join(', ')})`)
              .join(', ')}`
          )
        }
        if (reissued.length > 0) {
          parts.push(
            `session cookie still issued on ${reissued
              .map(({ r, name }) => `${r.id} (${name})`)
              .join(', ')}`
          )
        }
        drafts.push({
          category: 'logout-not-invalidated',
          severity: 'medium',
          requestIds: [
            ...new Set([
              requests[logoutIdx].id,
              ...staleCarriers.map(({ r }) => r.id),
              ...reissued.map(({ r }) => r.id)
            ])
          ],
          detail: parts.join('; ')
        })
      }
    }
  }

  // 6. Weak JWT algorithm on a bearer token.
  const weakJwts: Array<{ r: CapturedRequest; alg: unknown }> = []
  for (const r of requests) {
    const token = bearerToken(r.requestHeaders)
    if (!token) continue
    const header = parseJwt(token)
    if (!header) continue
    if (isWeakJwtAlg(header.alg)) weakJwts.push({ r, alg: header.alg })
  }
  if (weakJwts.length > 0) {
    drafts.push({
      category: 'weak-jwt-alg',
      severity: 'critical',
      requestIds: weakJwts.map(({ r }) => r.id),
      detail: weakJwts
        .map(({ r, alg }) => `${r.id}: alg=${typeof alg === 'string' ? clampString(alg, 40) : '<missing>'}`)
        .join('; ')
    })
  }

  // 7. Session cookies issued without Secure / HttpOnly / SameSite.
  const weakCookies: Array<{ r: CapturedRequest; name: string; missing: string[] }> = []
  for (const r of requests) {
    for (const sc of sessionSetCookies(r, names)) {
      const missing: string[] = []
      if (!('secure' in sc.attrs)) missing.push('Secure')
      if (!('httponly' in sc.attrs)) missing.push('HttpOnly')
      if (!('samesite' in sc.attrs)) missing.push('SameSite')
      if (missing.length > 0) weakCookies.push({ r, name: sc.name, missing })
    }
  }
  if (weakCookies.length > 0) {
    drafts.push({
      category: 'weak-cookie-flags',
      severity: 'medium',
      requestIds: [...new Set(weakCookies.map(({ r }) => r.id))],
      detail: weakCookies
        .map(({ r, name, missing }) => `${name} on ${r.id} missing ${missing.join('/')}`)
        .join('; ')
    })
  }

  return drafts.slice(0, MAX_LIST_ITEMS).map((d, idx) => ({
    id: `auth_flow_${idx + 1}`,
    category: d.category,
    severity: d.severity,
    title: TITLES[d.category],
    description: DESCRIPTIONS[d.category],
    evidence: {
      requestIds: [...new Set(d.requestIds)].slice(0, MAX_LIST_ITEMS),
      detail: clampString(d.detail, MAX_FIELD_CHARS)
    },
    recommendation: RECOMMENDATIONS[d.category]
  }))
}

// ─── Input parsing ─────────────────────────────────────────────────────────

function asRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ToolInputError('expected an object of arguments')
  }
  return raw as Record<string, unknown>
}

function stringArray(
  raw: Record<string, unknown>,
  key: string,
  max: number
): string[] | undefined {
  const v = raw[key]
  if (v === undefined) return undefined
  if (!Array.isArray(v)) throw new ToolInputError(`"${key}" must be an array of strings`)
  if (v.some((e) => typeof e !== 'string' || e.length === 0)) {
    throw new ToolInputError(`"${key}" must be an array of non-empty strings`)
  }
  if (v.length > max) throw new ToolInputError(`"${key}" accepts at most ${max} items`)
  return v as string[]
}

function boolOpt(raw: Record<string, unknown>, key: string): boolean | undefined {
  const v = raw[key]
  if (v === undefined) return undefined
  if (typeof v !== 'boolean') throw new ToolInputError(`"${key}" must be a boolean`)
  return v
}

function parseInput(raw: unknown): AnalyzeAuthFlowInput {
  const r = asRecord(raw)

  const flowRequests = stringArray(r, 'flowRequests', MAX_FLOW_REQUESTS)
  if (flowRequests === undefined) {
    throw new ToolInputError(
      '"flowRequests" is required — pass the captured request ids that form the auth flow, oldest first'
    )
  }
  if (flowRequests.length === 0) {
    throw new ToolInputError('"flowRequests" must contain at least one request id')
  }

  let loginUrl: string | undefined
  if (r.loginUrl !== undefined) {
    if (typeof r.loginUrl !== 'string' || r.loginUrl.length === 0) {
      throw new ToolInputError('"loginUrl" must be a non-empty string')
    }
    let parsed: URL
    try {
      parsed = new URL(r.loginUrl)
    } catch {
      throw new ToolInputError('"loginUrl" is not a valid URL')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ToolInputError('"loginUrl" must be http(s)')
    }
    loginUrl = parsed.href
  }

  return {
    // Duplicate ids would double-count evidence; the flow is ordered, so keep
    // the first occurrence.
    flowRequests: [...new Set(flowRequests)],
    loginUrl,
    authCookieNames: stringArray(r, 'authCookieNames', MAX_AUTH_COOKIE_NAMES),
    checkSessionFixation: boolOpt(r, 'checkSessionFixation'),
    checkLogoutInvalidation: boolOpt(r, 'checkLogoutInvalidation')
  }
}

// ─── Tool ──────────────────────────────────────────────────────────────────

export const analyze_auth_flow = defineTool<AnalyzeAuthFlowInput, AnalyzeAuthFlowOutput>({
  name: 'analyze_auth_flow',
  description:
    'Analyze a captured authentication flow for suspected auth/session weaknesses: cleartext ' +
    'credential transport, tokens in URLs, missing CSRF headers, session fixation, logout that does ' +
    'not invalidate the session, unsigned ("none") JWTs, and session cookies missing ' +
    'Secure/HttpOnly/SameSite. Pass the request ids forming the flow (oldest first, from ' +
    'get_network_log) plus optionally the login URL and cookie names. READ-ONLY: it only inspects ' +
    'already-captured traffic, sends nothing, and does NOT record findings — feed the issues the ' +
    'evaluator confirms to record_finding. `loginUrl` is used as the scope target. Missing ids are ' +
    'reported in `missingRequestIds`; the full analysis is saved as a trace (rawRef).',
  riskTier: 'R',
  inputSchema: {
    type: 'object',
    required: ['flowRequests'],
    properties: {
      flowRequests: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: MAX_FLOW_REQUESTS,
        description: 'Captured request IDs forming the auth flow, oldest first.'
      },
      loginUrl: {
        type: 'string',
        description: 'Expected login endpoint — used as the pipeline scope target.'
      },
      authCookieNames: {
        type: 'array',
        items: { type: 'string' },
        maxItems: MAX_AUTH_COOKIE_NAMES,
        description:
          'Cookie names treated as session tokens (default: session, sessionid, jsessionid, phpsessid, ' +
          'asp.net sessionid, auth, token, access_token).'
      },
      checkSessionFixation: {
        type: 'boolean',
        description:
          'Check whether the session cookie value is unchanged across the login boundary.'
      },
      checkLogoutInvalidation: {
        type: 'boolean',
        description: 'Check whether the session cookie is still accepted after a logout request.'
      }
    },
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      issues: { type: 'array' },
      summary: { type: 'object' },
      rawRef: { type: 'string' },
      missingRequestIds: { type: 'array' }
    }
  },
  parse: parseInput,
  // The only network-adjacent thing this tool names is the login endpoint, so
  // that is what the pipeline scope-checks. No loginUrl => nothing to check.
  target: (i) => i.loginUrl,
  execute: async (i, ctx) => {
    const requests: CapturedRequest[] = []
    const missingRequestIds: string[] = []
    for (const id of i.flowRequests) {
      const captured = ctx.network.get(id)
      if (captured) requests.push(captured)
      else missingRequestIds.push(id)
    }

    const issues = extractIssues(requests, {
      authCookieNames: i.authCookieNames,
      checkSessionFixation: i.checkSessionFixation,
      checkLogoutInvalidation: i.checkLogoutInvalidation
    })
    const summary = summarize(issues)

    // Persist the raw analysis so the agent (or a human reviewer) can re-read
    // exactly what was inspected without re-running the flow.
    let rawRef: string | undefined
    if (ctx.traces) {
      try {
        rawRef = await ctx.traces.save(
          'trace',
          JSON.stringify({
            input: {
              flowRequests: i.flowRequests,
              loginUrl: i.loginUrl,
              authCookieNames: i.authCookieNames,
              checkSessionFixation: i.checkSessionFixation,
              checkLogoutInvalidation: i.checkLogoutInvalidation
            },
            missingRequestIds,
            requests,
            issues
          })
        )
      } catch {
        // A trace-store failure must not lose the analysis itself.
        rawRef = undefined
      }
    }

    return {
      issues,
      summary,
      rawRef,
      ...(missingRequestIds.length > 0 ? { missingRequestIds } : {})
    }
  }
})

export const authFlowTools: Tool[] = [analyze_auth_flow as Tool]
