import { readFileSync } from 'node:fs'
import type { ScopeChecker, ScopeConfig } from '../shared/scope'
import { makeScopeChecker } from './scope'

/** Deny-by-default checker: used whenever no valid engagement scope is loaded. */
export const DENY_ALL: ScopeChecker = { isAllowed: () => false }

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
