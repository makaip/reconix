// FROZEN CONTRACT (6.5) — the scope seam shared by Dev 3 (scope-check) and Dev 4
// (egress proxy + nftables). Do not change shape without updating every consumer.
//
// Authoring format: what a human writes to define an engagement's authorized scope.
// Compiled format: the deterministic artifacts the compiler emits from a ScopeConfig —
// proxy allowlist rules and nftables rules. The runtime loads the compiled artifacts;
// the proxy and the per-tool scope-check both derive their decision from the SAME
// ScopeConfig so a URL allowed by one is allowed by the other.

/** A single authorized destination. CIDR covers IP ranges; host covers DNS names. */
export type ScopeTarget = {
  /** DNS host (exact or wildcard like `*.example.com`) OR a literal IP. Mutually exclusive with `cidr`. */
  host?: string
  /** IPv4/IPv6 CIDR block, e.g. `10.0.0.0/24`. Mutually exclusive with `host`. */
  cidr?: string
  /** Allowed ports. Empty/omitted means 80 and 443 only. */
  ports?: number[]
  /** Allowed URL path prefixes for this target. Omitted/empty means all paths. */
  paths?: string[]
}

export type ScopeConfig = {
  /** Stable id of the engagement this scope authorizes. */
  engagementId: string
  /** Everything the agent may reach. Nothing outside this set is reachable — default deny. */
  targets: ScopeTarget[]
  /** Internal destinations always allowed (model endpoint). Never target traffic. */
  infra: ScopeTarget[]
}

/** One compiled egress-proxy rule. Deterministic output of the compiler. */
export type ProxyRule = {
  action: 'allow' | 'deny'
  host?: string
  cidr?: string
  ports: number[]
  pathPrefixes: string[] // empty = all paths
}

/** One compiled nftables rule (blunt L3/L4 floor). */
export type NftRule = {
  action: 'accept' | 'drop'
  cidr?: string
  ports?: number[]
}

export type CompiledScope = {
  engagementId: string
  proxyRules: ProxyRule[] // last rule is the catch-all deny
  nftRules: NftRule[] // last rule is the catch-all drop
}

/**
 * The per-tool scope-check API Dev 3's handlers call before acting (6.5 seam).
 * Pure, synchronous, deny-by-default. Same ScopeConfig the proxy compiled from.
 */
export type ScopeChecker = {
  /** True iff this URL+method is inside authorized scope. Handlers reject on false. */
  isAllowed: (url: string, method?: string) => boolean
}
