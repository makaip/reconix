// Per-action semantic scope check (ARCHITECTURE §6.5, enforced by C's handlers).
// This is the smart layer; D's egress proxy + nftables are the dumb floor behind
// it. Both read the same ScopeConfig object — they must never diverge.

import type { ScopeConfig } from '../../shared/contracts'
import { ScopeError } from './errors'

// Host-only matching: a pattern never carries a port, and URL.hostname drops
// any `:port`, so `https://app.example.com:8443` is in scope whenever
// `app.example.com` is. Known limitation — a port-restricted scope needs a
// separate check (the same granularity D's network floor can enforce).
function hostMatches(host: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1) // ".example.com"
    return host === pattern.slice(2) || host.endsWith(suffix)
  }
  return host === pattern
}

// Extracted so a ToolContext can carry a scope that isn't fixed at
// construction time — e.g. copilot.ts's ActiveTabScope, which re-derives
// allowed_hosts from whichever tab is active on every check instead of a
// single ScopeConfig baked in at startup (there's no "start engagement" UI
// flow wiring a real scope yet).
export interface ScopeEnforcer {
  readonly config: ScopeConfig
  isInScope(target: string | undefined): boolean
  assertInScope(target: string | undefined): void
}

export class ScopeChecker implements ScopeEnforcer {
  constructor(private readonly cfg: ScopeConfig) {}

  /** The underlying config (what get_scope returns to the agent). */
  get config(): ScopeConfig {
    return this.cfg
  }

  /** A target string is typically a URL; we scope-check its hostname. */
  isInScope(target: string | undefined): boolean {
    if (!target) return true // tool declared no target (pure-compute / session read)
    let host: string
    try {
      host = new URL(target).hostname
    } catch {
      // not a URL — treat the raw string as the host
      host = target
    }
    if (this.cfg.denied.some((p) => hostMatches(host, p))) return false
    // NOTE: allowed_cidrs requires DNS→IP resolution; that check lives at D's
    // network floor. Here we match host patterns only. See open-decision 5.
    return this.cfg.allowed_hosts.some((p) => hostMatches(host, p))
  }

  assertInScope(target: string | undefined): void {
    if (!this.isInScope(target)) throw new ScopeError(target ?? '<unknown>')
  }
}
