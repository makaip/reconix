import {
  analyzeCookieList,
  isActionableSeverity,
  type CookieFinding
} from '../../../shared/cookieSecurity'
import type { CookieInfo } from '../../../shared/devtools'

// Renderer-side adapter over the shared per-cookie analysis in
// src/shared/cookieSecurity.ts (also used by the `analyze_cookie_flags`
// capability in src/tools/analyzeCookieFlags.ts). The rule logic — messages and
// severities — lives in the shared module so the UI and the agent cannot drift;
// this file only adapts the already-parsed `CookieInfo` shape.
//
// Only per-cookie findings are produced: the tool's response-header findings
// (CSP/CORS/HSTS) need response headers the renderer does not have, so they are
// intentionally omitted to avoid false "missing header" reports.

export {
  COOKIE_SEVERITY_ORDER,
  isActionableSeverity,
  type CookieFinding,
  type CookieSeverity
} from '../../../shared/cookieSecurity'

export type CookieSecurityFinding = CookieFinding & {
  /** Name of the cookie the finding concerns. */
  cookie: string
}

/**
 * Analyze cookies for weak/missing security attributes (Secure, HttpOnly,
 * SameSite). Pure function — no I/O.
 */
export function analyzeCookieSecurity(cookies: CookieInfo[]): CookieSecurityFinding[] {
  return analyzeCookieList(cookies)
}

/** Findings that represent a real weakness (`info` "all good" advisories are excluded). */
export function analyzeActionableCookieSecurity(cookies: CookieInfo[]): CookieSecurityFinding[] {
  return analyzeCookieSecurity(cookies).filter((finding) => isActionableSeverity(finding.severity))
}
