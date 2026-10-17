import type { Tool } from '../tool'
import { sessionTools } from './session'
import { navigationTools } from './navigation'
import { interactionTools } from './interaction'
import { networkTools } from './network'
import { probeTools, verifyTools } from './probes'
import { findingTools } from './findings'
import { customTools } from './custom'

// Full catalog (API.md §3). Dev 1's customTools (§3.8) sit in the same list and
// go through the same pipeline as Dev 3's own tools.
export const allTools: Tool[] = [
  ...sessionTools,
  ...navigationTools,
  ...interactionTools,
  ...networkTools,
  ...probeTools,
  ...verifyTools,
  ...findingTools,
  ...customTools
]

// The MVP subset the doc's Appendix names — what the spine turns on first.
const MVP_NAMES = new Set([
  'get_scope',
  'get_engagement_state',
  'navigate',
  'get_page_info',
  'get_cookies',
  'screenshot',
  'eval_in_page',
  'click',
  'fill',
  'query_log',
  'record_finding',
  'probe_reflection',
  ...customTools.map((t) => t.name)
])

export const mvpTools: Tool[] = allTools.filter((t) => MVP_NAMES.has(t.name))
