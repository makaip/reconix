// Registers all Dev 1 5.E custom capability tools into a ToolRegistry.
// In production this registry is Dev 3's MCP server (§6.2); here it's the
// mock in registry.ts for standalone exercise/testing.

import type { ToolRegistry } from '../shared/tools'
import { breakRegexTool } from './breakRegex'
import { detectEncodingTool } from './detectEncoding'
import { diffResponsesTool } from './diffResponses'
import { genFuzzPayloadsTool } from './fuzzPayloads'

export { createMockToolRegistry } from './registry'
export { breakRegexTool } from './breakRegex'
export { detectEncodingTool } from './detectEncoding'
export { diffResponsesTool } from './diffResponses'
export { genFuzzPayloadsTool } from './fuzzPayloads'

export function registerCustomTools(registry: ToolRegistry): void {
  registry.register(genFuzzPayloadsTool)
  registry.register(breakRegexTool)
  registry.register(diffResponsesTool)
  registry.register(detectEncodingTool)
}
