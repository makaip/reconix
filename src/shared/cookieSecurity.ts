// Pure per-cookie security analysis — the single source of truth shared by
//
//   * src/tools/analyzeCookieFlags.ts  (the `analyze_cookie_flags` capability,
//     ARCHITECTURE.MD §5.E) — agent-side, operates on raw Set-Cookie strings
//   * src/renderer/src/lib/cookieSecurity.ts — renderer-side, operates on the
//     already-parsed `CookieInfo` shape
//
// Both scopes (`tsconfig.node.json` and `tsconfig.web.json`) include
// `src/shared/**/*`, so this module is reachable from either side without
// duplicating the rules. Keep this file dependency-free: no Node/Electron/React
// imports, no I/O.

export type CookieSeverity = 'info' | 'low' | 'medium' | 'high'

export type CookieFinding = {
  severity: CookieSeverity
  message: string
}

/**
 * The only attributes the per-cookie analysis inspects. `sameSite` is a loose
 * string because raw Set-Cookie values may carry arbitrary/unrecognized values
 * (the tool must report those); parsed sources narrow it further.
 */
export type CookieAttributes = {
  secure: boolean
  httpOnly: boolean
  sameSite?: string | null
}

/** All severities, most severe first. */
export const COOKIE_SEVERITIES: readonly CookieSeverity[] = ['high', 'medium', 'low', 'info']

/** Sort weight for severities, most severe first. */
export const COOKIE_SEVERITY_ORDER: Record<CookieSeverity, number> = {
  high: 0,
  medium: 1,
  low: 2,
  info: 3
}

/** `info` rows are advisory ("all good") and are not counted as findings. */
export const COOKIE_ACTIONABLE_SEVERITIES: readonly CookieSeverity[] = ['high', 'medium', 'low']

/** True for findings that represent an actual weakness rather than an advisory note. */
export function isActionableSeverity(severity: CookieSeverity): boolean {
  return severity !== 'info'
}

/**
 * Analyze one cookie for weak/missing security attributes (Secure, HttpOnly,
 * SameSite). Pure function — no I/O.
 *
 * Returns every finding for the cookie (a cookie can miss several attributes at
 * once), most severe first. `info` entries are advisory notes, not weaknesses.
 */
export function analyzeCookie(cookie: CookieAttributes): CookieFinding[] {
  const findings: CookieFinding[] = []

  if (!cookie.secure) {
    findings.push({
      severity: 'medium',
      message: 'Missing Secure flag: cookie may be sent over plaintext HTTP.'
    })
  }
  if (!cookie.httpOnly) {
    findings.push({
      severity: 'medium',
      message: 'Missing HttpOnly flag: cookie is readable by client-side JavaScript (XSS theft risk).'
    })
  }

  const sameSite = cookie.sameSite ?? null
  const sameSiteLower = sameSite ? sameSite.toLowerCase() : null

  if (sameSiteLower === null) {
    findings.push({
      severity: 'low',
      message: 'Missing SameSite attribute: cookie defaults are browser-dependent (CSRF exposure).'
    })
  } else if (sameSiteLower === 'none') {
    if (!cookie.secure) {
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

  return findings
}

/**
 * Analyze a list of named cookies, flattening each cookie's findings and tagging
 * them with the owning cookie's name. Pure function — no I/O.
 */
export function analyzeCookieList<T extends CookieAttributes & { name: string }>(
  cookies: readonly T[]
): Array<CookieFinding & { cookie: string }> {
  const findings: Array<CookieFinding & { cookie: string }> = []
  for (const cookie of cookies) {
    for (const finding of analyzeCookie(cookie)) {
      findings.push({ ...finding, cookie: cookie.name })
    }
  }
  return findings
}
