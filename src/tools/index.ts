// Registers all Dev 1 5.E custom capability tools into a ToolRegistry.
// In production this registry is Dev 3's MCP server (§6.2); here it's the
// mock in registry.ts for standalone exercise/testing.

import type { ToolRegistry } from '../shared/tools'
import { breakRegexTool } from './breakRegex'
import { detectEncodingTool } from './detectEncoding'
import { diffResponsesTool } from './diffResponses'
import { genFuzzPayloadsTool } from './fuzzPayloads'
import { decodeJwtTool } from './decodeJwt'
import { analyzeCookieFlagsTool } from './analyzeCookieFlags'
import { detectSecretsTool } from './detectSecrets'
import { mineParamsTool } from './mineParams'
import { inspectTlsCertTool } from './inspectTlsCert'
import { deobfuscateStaticTool } from './deobfuscateStatic'
import { deobfuscateDynamicTool } from './deobfuscateDynamic'

export { createMockToolRegistry } from './registry'
export { breakRegexTool } from './breakRegex'
export { detectEncodingTool } from './detectEncoding'
export { diffResponsesTool } from './diffResponses'
export { genFuzzPayloadsTool } from './fuzzPayloads'
export { decodeJwtTool } from './decodeJwt'
export { analyzeCookieFlagsTool } from './analyzeCookieFlags'
export { detectSecretsTool } from './detectSecrets'
export { mineParamsTool } from './mineParams'
export { inspectTlsCertTool } from './inspectTlsCert'
export { deobfuscateStaticTool } from './deobfuscateStatic'
export { deobfuscateDynamicTool } from './deobfuscateDynamic'
export {
  normalizeHarnessDump,
  validateDynamicTrace,
  classifyRecord,
  TRACE_SCHEMA_VERSION,
  DYNAMIC_HOOK_KINDS
} from './deobfuscateTrace'
export type {
  DynamicTrace,
  DynamicTraceRecord,
  DynamicHookKind,
  DynamicRecordClass
} from './deobfuscateTrace'

export function registerCustomTools(registry: ToolRegistry): void {
  registry.register(genFuzzPayloadsTool)
  registry.register(breakRegexTool)
  registry.register(diffResponsesTool)
  registry.register(detectEncodingTool)
  registry.register(decodeJwtTool)
  registry.register(analyzeCookieFlagsTool)
  registry.register(detectSecretsTool)
  registry.register(mineParamsTool)
  registry.register(inspectTlsCertTool)
  registry.register(deobfuscateStaticTool)
  registry.register(deobfuscateDynamicTool)
}
