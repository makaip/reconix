import type { CookieInfo } from '../../../shared/devtools'

// Renderer-side mirror of the pure cookie analysis in
// src/tools/analyzeCookieFlags.ts (the `analyze_cookie_flags` capability,
// ARCHITECTURE.MD §5.E). The renderer has no capability-registry / tool IPC
// surface (capabilities are agent-side only), and `tsconfig.web.json` does not
// include `src/tools/**`, so the analysis is replicated here over the
// already-parsed `CookieInfo` shape rather than reconstructed into raw
// Set-Cookie strings and fed through the tool handler.
//
// Messages and severities are kept identical to the tool so findings match the
// agent's. Only per-cookie findings are produced: the tool's response-header
// findings (CSP/CORS/HSTS) need response headers the renderer does not have, so
// they are intentionally omitted to avoid false "missing header" reports.

export type CookieSeverity = 'info' | 'low' | 'medium' | 'high'

export type CookieSecurityFinding = {
  severity: CookieSeverity
  message: string
  /** Name of the cookie the finding concerns. */
  cookie: string
}

/** Sort weight for severities, most severe first. */
export const COOKIE_SEVERITY_ORDER: Record<CookieSeverity, number> = {
  high: 0,
  medium: 1,
  low: 2,
  info: 3
}

/**
 * Analyze cookies for weak/missing security attributes (Secure, HttpOnly,
 * SameSite). Pure function — no I/O.
 */
export function analyzeCookieSecurity(cookies: CookieInfo[]): CookieSecurityFinding[] {
  const findings: CookieSecurityFinding[] = []

  for (const cookie of cookies) {
    const add = (severity: CookieSeverity, message: string): void => {
      findings.push({ severity, message, cookie: cookie.name })
    }

    if (!cookie.secure) {
      add('medium', 'Missing Secure flag: cookie may be sent over plaintext HTTP.')
    }
    if (!cookie.httpOnly) {
      add(
        'medium',
        'Missing HttpOnly flag: cookie is readable by client-side JavaScript (XSS theft risk).'
      )
    }

    const sameSite = cookie.sameSite ?? null
    const sameSiteLower = sameSite ? sameSite.toLowerCase() : null

    if (sameSiteLower === null) {
      add('low', 'Missing SameSite attribute: cookie defaults are browser-dependent (CSRF exposure).')
    } else if (sameSiteLower === 'none') {
      if (!cookie.secure) {
        add(
          'high',
          'SameSite=None without Secure: browsers reject this and it weakens CSRF protection.'
        )
      } else {
        add('info', 'SameSite=None: cookie is sent cross-site; ensure this is intentional.')
      }
    } else if (sameSiteLower === 'lax') {
      add('info', 'SameSite=Lax: reasonable default for most cookies.')
    } else if (sameSiteLower === 'strict') {
      add('info', 'SameSite=Strict: strongest CSRF protection.')
    } else {
      add('low', `Unrecognized SameSite value "${sameSite}".`)
    }
  }

  return findings
}
