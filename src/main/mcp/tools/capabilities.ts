// Bridge: expose every pure-compute capability in src/tools to the copilot
// through the Reconix MCP server, without duplicating their logic. Each
// capability is wrapped as an MCP Tool (tier R — pure compute, no sockets).
import { defineTool, type Tool } from '../tool'
import { ToolInputError } from '../errors'
import type { CapabilityTool } from '../../../shared/tools'

import {
  analyzeCookieFlagsTool,
  breakRegexTool,
  decodeJwtTool,
  detectEncodingTool,
  detectSecretsTool,
  diffResponsesTool,
  deobfuscateDynamicTool,
  deobfuscateStaticTool,
  genFuzzPayloadsTool,
  inspectTlsCertTool,
  mineParamsTool
} from '../../../tools'

const CAPABILITY_TOOLS: CapabilityTool<unknown, unknown>[] = [
  analyzeCookieFlagsTool,
  breakRegexTool,
  decodeJwtTool,
  detectEncodingTool,
  detectSecretsTool,
  diffResponsesTool,
  deobfuscateDynamicTool,
  deobfuscateStaticTool,
  genFuzzPayloadsTool,
  inspectTlsCertTool,
  mineParamsTool
] as CapabilityTool<unknown, unknown>[]

function bridge(cap: CapabilityTool<unknown, unknown>): Tool {
  return defineTool<unknown, unknown>({
    name: cap.name,
    description: cap.description,
    riskTier: (cap.riskTier === 'processing' ? 'R' : cap.riskTier) as 'R' | 'P' | 'M' | 'D',
    inputSchema: cap.inputSchema,
    outputSchema: cap.outputSchema ?? { type: 'object' },
    parse: (raw) => {
      const res = cap.validateInput(raw)
      if (!res.ok) throw new ToolInputError(res.errors.join('; '))
      return res.value
    },
    execute: async (input) => cap.handler(input)
  })
}

export const capabilityTools: Tool[] = CAPABILITY_TOOLS.map(bridge)
