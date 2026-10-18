// Catalog of capability tools exposed to OpenCode.
//
// Each entry is a LAZY loader so the plugin never eagerly imports every engine
// at startup. This preserves the defensive posture the plugin already had: if a
// single module fails to resolve at runtime, only that tool is skipped — the
// rest keep working.
//
// Adding a tool to the OpenCode surface is now: implement it in `src/tools`,
// add it to `src/tools/index.ts#registerCustomTools`, and add one loader here.
// The descriptor bridge handles schema, validation, and serialization.

import type { CapabilityTool } from '../../shared/tools'

/** A tool erased to its loose contract; handlers are contravariant in their input. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ErasedCapabilityTool = CapabilityTool<any, any>

export type CapabilityToolLoader = () => Promise<ErasedCapabilityTool>

/** All pure-compute capability tools, loaded lazily. */
export const capabilityLoaders: readonly CapabilityToolLoader[] = [
  () => import('../fuzzPayloads').then((m) => m.genFuzzPayloadsTool),
  () => import('../breakRegex').then((m) => m.breakRegexTool),
  () => import('../diffResponses').then((m) => m.diffResponsesTool),
  () => import('../detectEncoding').then((m) => m.detectEncodingTool),
  () => import('../decodeJwt').then((m) => m.decodeJwtTool),
  () => import('../analyzeCookieFlags').then((m) => m.analyzeCookieFlagsTool),
  () => import('../detectSecrets').then((m) => m.detectSecretsTool),
  () => import('../mineParams').then((m) => m.mineParamsTool),
  () => import('../inspectTlsCert').then((m) => m.inspectTlsCertTool),
  () => import('../deobfuscateStatic').then((m) => m.deobfuscateStaticTool),
  () => import('../deobfuscateDynamic').then((m) => m.deobfuscateDynamicTool)
]
