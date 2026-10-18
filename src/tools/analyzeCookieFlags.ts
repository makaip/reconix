// analyze_cookie_flags — ARCHITECTURE.MD §5.E.
//
// Pure compute: inspects `Set-Cookie` header values and other response headers
// the agent already fetched via Dev 3's tools. Flags weak/missing cookie
// security attributes (Secure, HttpOnly, SameSite) and obvious response-header
// weaknesses (CSP, CORS, HSTS). No network, filesystem, or process I/O.

import type { CapabilityTool, ValidationResult } from '../shared/tools'
import { arrOf, bool, enumOf, nullable, obj, objOf, str } from './schema'

// --- Inline input/output types (§5.E: declared in-tool, not in shared/tools) ---

export type AnalyzeCookieFlagsInput = {
  setCookieHeaders: string[]
  responseHeaders?: Record<string, string>
}

export type Severity = 'info' | 'low' | 'medium' | 'high'

export type CookieFinding = {
  severity: Severity
  message: string
}

export type CookieResult = {
  name: string
  secure: boolean
  httpOnly: boolean
  sameSite: string | null
  findings: CookieFinding[]
}

export type HeaderFinding = {
  severity: Severity
  message: string
  header: string
}

export type AnalyzeCookieFlagsOutput = {
  cookies: CookieResult[]
  headerFindings: HeaderFinding[]
}

const MAX_HEADERS = 1_000
const MAX_HEADER_LENGTH = 100_000

function validate(raw: unknown): ValidationResult<AnalyzeCookieFlagsInput> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['input must be an object'] }
  }
  const obj = raw as Record<string, unknown>

  if (!Array.isArray(obj.setCookieHeaders)) {
    return { ok: false, errors: ['setCookieHeaders must be an array'] }
  }
  if (obj.setCookieHeaders.length > MAX_HEADERS) {
    return { ok: false, errors: [`setCookieHeaders must have <= ${MAX_HEADERS} entries`] }
  }
  for (const h of obj.setCookieHeaders) {
    if (typeof h !== 'string') {
      return { ok: false, errors: ['every setCookieHeaders entry must be a string'] }
    }
    if (h.length > MAX_HEADER_LENGTH) {
      return { ok: false, errors: [`each Set-Cookie value must be <= ${MAX_HEADER_LENGTH} chars`] }
    }
  }

  let responseHeaders: Record<string, string> | undefined
  if (obj.responseHeaders !== undefined) {
    if (
      typeof obj.responseHeaders !== 'object' ||
      obj.responseHeaders === null ||
      Array.isArray(obj.responseHeaders)
    ) {
      return { ok: false, errors: ['responseHeaders must be an object'] }
    }
    const rh = obj.responseHeaders as Record<string, unknown>
    const keys = Object.keys(rh)
    if (keys.length > MAX_HEADERS) {
      return { ok: false, errors: [`responseHeaders must have <= ${MAX_HEADERS} keys`] }
    }
    for (const k of keys) {
      const v = rh[k]
      if (typeof v !== 'string') {
        return { ok: false, errors: ['every responseHeaders value must be a string'] }
      }
      if (v.length > MAX_HEADER_LENGTH) {
        return { ok: false, errors: [`each response header value must be <= ${MAX_HEADER_LENGTH} chars`] }
      }
    }
    responseHeaders = rh as Record<string, string>
  }

  return {
    ok: true,
    value: {
      setCookieHeaders: obj.setCookieHeaders as string[],
      ...(responseHeaders ? { responseHeaders } : {})
    }
  }
}

type ParsedCookie = {
  name: string
  attributes: Map<string, string | true>
}

/** Parse one raw Set-Cookie value into its name and attribute map. */
function parseSetCookie(raw: string): ParsedCookie {
  const parts = raw.split(';')
  const first = (parts.shift() ?? '').trim()
  const eq = first.indexOf('=')
  const name = eq >= 0 ? first.slice(0, eq).trim() : first

  const attributes = new Map<string, string | true>()
  for (const part of parts) {
    const trimmed = part.trim()
    if (trimmed.length === 0) continue
    const i = trimmed.indexOf('=')
    if (i >= 0) {
      attributes.set(trimmed.slice(0, i).trim().toLowerCase(), trimmed.slice(i + 1).trim())
    } else {
      attributes.set(trimmed.toLowerCase(), true)
    }
  }
  return { name, attributes }
}

/** Case-insensitive lookup over a response-headers record. */
function getHeader(headers: Record<string, string> | undefined, name: string): string | null {
  if (!headers) return null
  const target = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) return headers[key]
  }
  return null
}

function analyzeCookie(raw: string): CookieResult {
  const parsed = parseSetCookie(raw)
  const secure = parsed.attributes.has('secure')
  const httpOnly = parsed.attributes.has('httponly')

  const sameSiteRaw = parsed.attributes.get('samesite')
  const sameSite = typeof sameSiteRaw === 'string' ? sameSiteRaw : null
  const sameSiteLower = sameSite ? sameSite.toLowerCase() : null

  const findings: CookieFinding[] = []

  if (!secure) {
    findings.push({
      severity: 'medium',
      message: 'Missing Secure flag: cookie may be sent over plaintext HTTP.'
    })
  }
  if (!httpOnly) {
    findings.push({
      severity: 'medium',
      message: 'Missing HttpOnly flag: cookie is readable by client-side JavaScript (XSS theft risk).'
    })
  }

  if (sameSiteLower === null) {
    findings.push({
      severity: 'low',
      message: 'Missing SameSite attribute: cookie defaults are browser-dependent (CSRF exposure).'
    })
  } else if (sameSiteLower === 'none') {
    if (!secure) {
      findings.push({
        severity: 'high',
        message: 'SameSite=None without Secure: browsers reject this and it weakens CSRF protection.'
      })
    } else {
      findings.push({
        severity: 'info',
        message: 'SameSite=None: cookie is sent cross-site; ensure this is intentional.'
      })
    }
  } else if (sameSiteLower === 'lax') {
    findings.push({
      severity: 'info',
      message: 'SameSite=Lax: reasonable default for most cookies.'
    })
  } else if (sameSiteLower === 'strict') {
    findings.push({
      severity: 'info',
      message: 'SameSite=Strict: strongest CSRF protection.'
    })
  } else {
    findings.push({
      severity: 'low',
      message: `Unrecognized SameSite value "${sameSite}".`
    })
  }

  return { name: parsed.name, secure, httpOnly, sameSite, findings }
}

function analyzeHeaders(headers: Record<string, string> | undefined): HeaderFinding[] {
  const findings: HeaderFinding[] = []

  // Content-Security-Policy
  const csp = getHeader(headers, 'content-security-policy')
  if (csp === null) {
    findings.push({
      severity: 'medium',
      message: 'No Content-Security-Policy header: no browser-side mitigation against injection.',
      header: 'Content-Security-Policy'
    })
  } else {
    const cspLower = csp.toLowerCase()
    if (cspLower.includes('unsafe-inline')) {
      findings.push({
        severity: 'high',
        message: "CSP allows 'unsafe-inline': inline scripts/styles are permitted, defeating XSS protection.",
        header: 'Content-Security-Policy'
      })
    }
    if (cspLower.includes('unsafe-eval')) {
      findings.push({
        severity: 'high',
        message: "CSP allows 'unsafe-eval': eval()-style execution is permitted.",
        header: 'Content-Security-Policy'
      })
    }
    if (/(^|[\s;])\*([\s;]|$)/.test(csp) || cspLower.includes(' * ') || /:\s*\*/.test(csp)) {
      findings.push({
        severity: 'medium',
        message: 'CSP uses a wildcard (*) source: broad origins are allowed.',
        header: 'Content-Security-Policy'
      })
    }
    if (!cspLower.includes('default-src')) {
      findings.push({
        severity: 'low',
        message: 'CSP is missing default-src: directives not explicitly set fall back to allowing all.',
        header: 'Content-Security-Policy'
      })
    }
  }

  // CORS
  const acao = getHeader(headers, 'access-control-allow-origin')
  if (acao !== null && acao.trim() === '*') {
    const acac = getHeader(headers, 'access-control-allow-credentials')
    if (acac !== null && acac.trim().toLowerCase() === 'true') {
      findings.push({
        severity: 'high',
        message:
          'Access-Control-Allow-Origin: * with Access-Control-Allow-Credentials: true exposes credentialed data to any origin.',
        header: 'Access-Control-Allow-Origin'
      })
    } else {
      findings.push({
        severity: 'low',
        message: 'Access-Control-Allow-Origin: * allows any origin to read responses.',
        header: 'Access-Control-Allow-Origin'
      })
    }
  }

  // HSTS
  const hsts = getHeader(headers, 'strict-transport-security')
  if (hsts === null) {
    findings.push({
      severity: 'low',
      message: 'No Strict-Transport-Security header: connections are not pinned to HTTPS.',
      header: 'Strict-Transport-Security'
    })
  }

  return findings
}

function analyze(input: AnalyzeCookieFlagsInput): AnalyzeCookieFlagsOutput {
  const cookies = input.setCookieHeaders.map(analyzeCookie)
  const headerFindings = analyzeHeaders(input.responseHeaders)
  return { cookies, headerFindings }
}

export const analyzeCookieFlagsTool: CapabilityTool<AnalyzeCookieFlagsInput, AnalyzeCookieFlagsOutput> = {
  name: 'analyze_cookie_flags',
  description:
    'Analyzes Set-Cookie header values and response headers for weak/missing cookie security attributes (Secure, HttpOnly, SameSite) and obvious CSP/CORS/HSTS weaknesses. Pure compute.',
  riskTier: 'read-only',
  inputSchema: obj(
    {
      setCookieHeaders: arrOf(str('A raw Set-Cookie header value.'), 'Set-Cookie header values from the response.'),
      responseHeaders: objOf('Other response headers as a string map.', {
        additionalProperties: { type: 'string' }
      })
    },
    ['setCookieHeaders']
  ),
  outputSchema: obj(
    {
      cookies: arrOf(
        obj(
          {
            name: str('Cookie name.'),
            secure: bool('Whether the Secure flag is set.'),
            httpOnly: bool('Whether the HttpOnly flag is set.'),
            sameSite: nullable(str('SameSite attribute value, or null if absent.')),
            findings: arrOf(
              obj(
                {
                  severity: enumOf(['info', 'low', 'medium', 'high'], 'Finding severity.'),
                  message: str('Human-readable finding.')
                },
                ['severity', 'message']
              ),
              'Per-cookie findings.'
            )
          },
          ['name', 'secure', 'httpOnly', 'sameSite', 'findings']
        ),
        'One entry per Set-Cookie header.'
      ),
      headerFindings: arrOf(
        obj(
          {
            severity: enumOf(['info', 'low', 'medium', 'high'], 'Finding severity.'),
            message: str('Human-readable finding.'),
            header: str('The response header the finding concerns.')
          },
          ['severity', 'message', 'header']
        ),
        'Response-header weaknesses (CSP/CORS/HSTS).'
      )
    },
    ['cookies', 'headerFindings']
  ),
  validateInput: validate,
  handler: analyze
}
