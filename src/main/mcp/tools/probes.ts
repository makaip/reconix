// API.md §3.5 — Active probes / exploit (M/D) and §3.6 — Verify & evidence (R).
// Detection, not weaponization (probe_reflection uses benign markers). run_tool
// (brokered external binaries) is tier D and explicitly POST-MVP (§8.6) — it
// reactivates the untrusted-code question and stays off until the sandbox tier
// exists.
import { defineTool, type Tool } from '../tool'
import { ToolExecError } from '../errors'
import { submitForm } from './submitForm'

function pending(name: string, description: string, tier: 'R' | 'M' | 'D'): Tool {
  return defineTool<Record<string, never>, never>({
    name,
    description,
    riskTier: tier,
    inputSchema: { type: 'object', additionalProperties: true },
    outputSchema: { type: 'object' },
    parse: () => ({}),
    execute: async () => {
      throw new ToolExecError(`${name}: not implemented in Phase 1`)
    }
  }) as Tool
}

export const probeTools: Tool[] = [
  submitForm as Tool,
  pending('probe_reflection', 'Benign-marker reflection probe (detection only).', 'M'),
  pending('vary_parameter', 'Differential over a param set (IDOR/BAC/fuzz). Rate-limited.', 'M'),
  pending('run_tool', 'Brokered external binary (nmap/nuclei/sqlmap). POST-MVP, §8.6.', 'D')
]

export const verifyTools: Tool[] = [
  pending('reproduce', 'Replay a stored interaction; report whether it matches.', 'R'),
  pending('collect_evidence', 'Bundle screenshot + req/resp + trace into one ref.', 'R')
]
