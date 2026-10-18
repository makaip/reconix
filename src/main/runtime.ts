import type { ProxyStatus } from '../shared/contracts'

/** The agent's egress proxy address, from RECONIX_PROXY_ADDR. Null when
 *  unconfigured — the container egress proxy (5.D) isn't started or health-
 *  checked by the app, so we report only what's actually configured rather than
 *  a fabricated default. */
export function proxyStatus(env: NodeJS.ProcessEnv = process.env): ProxyStatus {
  const address = env.RECONIX_PROXY_ADDR?.trim()
  return { address: address ? address : null }
}
