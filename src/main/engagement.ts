import { readFileSync } from 'node:fs'
import type { ScopeStatus } from '../shared/contracts'
import type { ScopeChecker, ScopeConfig } from '../shared/scope'
import { makeScopeChecker } from './scope'

/** Deny-by-default checker: used whenever no valid engagement scope is loaded. */
export const DENY_ALL: ScopeChecker = { isAllowed: () => false }

/**
 * Development fallback used before the engagement UI can load a scope.json.
 * It follows the active browser origin, keeping Repeater/Crawler aligned with
 * the Copilot tool scope without turning missing configuration into allow-all.
 */
export function createActiveOriginScopeChecker(getActiveUrl: () => string | null): ScopeChecker {
  return {
    isAllowed(candidate) {
      const activeValue = getActiveUrl()
      if (!activeValue) return false
      try {
        const active = new URL(activeValue)
        const target = new URL(candidate)
        if (!['http:', 'https:'].includes(active.protocol) || target.protocol !== active.protocol) return false
        if (target.port !== active.port) return false
        if (target.hostname === active.hostname) return true
        const loopback = new Set(['localhost', '127.0.0.1'])
        return loopback.has(active.hostname) && loopback.has(target.hostname)
      } catch {
        return false
      }
    }
  }
}

/** Minimal structural check — the config drives egress authorization, treat it as hostile. */
function isScopeConfig(value: unknown): value is ScopeConfig {
  if (typeof value !== 'object' || value === null) return false
  const c = value as Record<string, unknown>
  return (
    typeof c.engagementId === 'string' &&
    Array.isArray(c.targets) &&
    Array.isArray(c.infra)
  )
}

/** Reads the engagement ScopeConfig without building a checker. Returns null on
 *  any failure (no path, missing file, bad JSON, wrong shape) — the same
 *  default-deny posture as loadScopeChecker, for callers that only need the
 *  config to display. */
export function loadScopeConfig(path = process.env.SCOPE_CONFIG_PATH): ScopeConfig | null {
  if (!path) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isScopeConfig(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Projects the config into the renderer's read-only scope view (§6.5). */
export function toScopeStatus(config: ScopeConfig | null): ScopeStatus {
  if (!config) return { hosts: [], summary: 'none' }
  const hosts = config.targets.flatMap((t) => (t.host ? [t.host] : []))
  const rules = config.targets.length
  const hostLabel = `${hosts.length} host${hosts.length === 1 ? '' : 's'}`
  const ruleLabel = `${rules} rule${rules === 1 ? '' : 's'}`
  return { hosts, summary: `${hostLabel} · ${ruleLabel}` }
}

/**
 * Loads the engagement ScopeConfig and builds the per-tool ScopeChecker host-side
 * replay gates every send on. Reads the SAME `scope.json` shape the egress proxy
 * consumes (SCOPE_CONFIG_PATH), so the host path and the container path authorize
 * identically. ANY failure — no path, missing file, bad JSON, wrong shape — yields
 * DENY_ALL: default-deny holds, replay sends nothing until a valid scope is present.
 */
export function loadScopeChecker(path = process.env.SCOPE_CONFIG_PATH): ScopeChecker {
  if (!path) {
    console.warn('No SCOPE_CONFIG_PATH set — replay denies all until a scope is loaded.')
    return DENY_ALL
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isScopeConfig(parsed)) {
      console.error(`Scope config at ${path} is malformed — denying all.`)
      return DENY_ALL
    }
    return makeScopeChecker(parsed)
  } catch (error) {
    console.error(`Could not load scope config from ${path} — denying all:`, error)
    return DENY_ALL
  }
}
