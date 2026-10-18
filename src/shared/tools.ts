// Shared types for Dev 1's custom capability tools (ARCHITECTURE.MD §5.E).
//
// These tools are pure-compute MCP tools: they generate payload data and
// analyze response data the agent already has; they never egress (§5.E, §2,
// §10). They register into Dev 3's MCP server (§6.2) and inherit its
// `schema-validate → scope-check → audit → tier` pipeline — here we only own
// the schema-validate step (input is treated as hostile, §5.C rule 2) since
// there is no scope to check and nothing to audit-write for pure compute.
//
// RiskTier is frozen in src/shared/agent.ts (Dev 2/owner of that file) and is
// reused here, never redefined — these tools are tier 'read-only' (R) or the
// 'processing' tier (P) per §5.E ("pure-compute (tier R or P)").

import type { RiskTier } from './agent'
import type { JsonSchema } from '../tools/schema'

/** The tier vocabulary §5.E allows for pure-compute tools: R (read-only) or P (processing). */
export type ToolTier = RiskTier | 'processing'

/** Result of validating an untrusted input value against a tool's input schema. */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] }

/**
 * A hand-rolled, dependency-free validator for one tool's input shape.
 * Must treat the raw `unknown` value as hostile: wrong types, missing
 * fields, out-of-range values, and extra/unexpected shapes are all
 * rejected rather than coerced.
 */
export type InputValidator<T> = (raw: unknown) => ValidationResult<T>

/**
 * A single MCP-style tool, matching the §6.2 contract shape
 * `{ name, description, inputSchema, outputSchema, riskTier }`, with the
 * schema fields represented as a runtime validator (no JSON Schema / zod
 * dependency per the task constraints) plus a synchronous pure-compute
 * handler.
 */
export type CapabilityTool<TInput, TOutput> = {
  name: string
  description: string
  riskTier: ToolTier
  /**
   * Declarative input shape (JSON Schema), matching §6.2's `inputSchema`. This
   * drives the OpenCode-facing tool schema and lives next to `validateInput` so
   * the two never drift. It is descriptive only — `validateInput` remains the
   * runtime gate.
   */
  inputSchema: JsonSchema
  /**
   * Optional declarative output shape (JSON Schema), matching §6.2's
   * `outputSchema`. When present, the OpenCode adapter declares it to the host,
   * which validates the handler's return value against it. Omit it for tools
   * whose output is dynamic or externally defined.
   */
  outputSchema?: JsonSchema
  /** Validates raw untrusted input before `handler` ever sees typed data. */
  validateInput: InputValidator<TInput>
  /** Pure compute: no network, filesystem, or process I/O of any kind. */
  handler: (input: TInput) => TOutput
}

/**
 * Mock stand-in for Dev 3's MCP server registration surface (§6.2, §5.C
 * rule 1: "Expose a registration API so Dev 1's 5.E tools slot in under the
 * same enforcement"). The real server would wrap `register` with
 * scope-check + audit write-through; this mock only exercises the
 * schema-validate step that lives in this vertical.
 */
export interface ToolRegistry {
  register<TInput, TOutput>(tool: CapabilityTool<TInput, TOutput>): void
  get(name: string): CapabilityTool<unknown, unknown> | undefined
  list(): Array<Pick<CapabilityTool<unknown, unknown>, 'name' | 'description' | 'riskTier'>>
}

/** Thrown by a tool's handler-invocation wrapper when input fails validation. */
export class ToolInputError extends Error {
  readonly errors: string[]
  constructor(toolName: string, errors: string[]) {
    super(`${toolName}: invalid input: ${errors.join('; ')}`)
    this.errors = errors
  }
}

/**
 * Invokes a tool the way the mock registry does: validate first (input is
 * hostile, §5.C pipeline step 1), only call `handler` on success.
 */
export function invokeTool<TInput, TOutput>(
  tool: CapabilityTool<TInput, TOutput>,
  raw: unknown
): TOutput {
  const result = tool.validateInput(raw)
  if (!result.ok) {
    throw new ToolInputError(tool.name, result.errors)
  }
  return tool.handler(result.value)
}

// ---------------------------------------------------------------------------
// gen_fuzz_payloads
// ---------------------------------------------------------------------------

/** Named corpora gen_fuzz_payloads can emit. */
export type FuzzCorpus = 'xss' | 'sqli' | 'path-traversal' | 'command-injection'

/** Encoding transforms applied to each base payload. */
export type FuzzEncoding = 'url' | 'double-url' | 'html-entity' | 'unicode' | 'base64'

/** Boundary/edge-value categories, independent of corpus/encoding. */
export type FuzzBoundary =
  | 'empty'
  | 'huge'
  | 'null-byte'
  | 'format-string'
  | 'integer-bounds'

export type GenFuzzPayloadsInput = {
  corpus: FuzzCorpus[]
  encodings: FuzzEncoding[]
  boundaries: FuzzBoundary[]
}

export type GenFuzzPayloadsOutput = string[]

// ---------------------------------------------------------------------------
// break_regex
// ---------------------------------------------------------------------------

export type BreakRegexInput = {
  pattern: string
}

export type RedosCandidate = {
  /** The attack string statically constructed to probe the flagged structure. */
  candidate: string
  /** Human-readable reason this structure is suspected catastrophic. */
  reason: string
  /** The suspicious substring of the pattern that triggered this candidate. */
  matchedStructure: string
}

export type BreakRegexOutput = {
  vulnerable: boolean
  redosCandidates: RedosCandidate[]
}

// ---------------------------------------------------------------------------
// diff_responses
// ---------------------------------------------------------------------------

/** A minimal response-like shape — data the agent already fetched via Dev 3's tools. */
export type ResponseLike = {
  status: number
  body: string
  timingMs?: number
  headers?: Record<string, string>
}

export type DiffResponsesInput = {
  a: ResponseLike
  b: ResponseLike
}

export type LineDiffEntry = {
  kind: 'added' | 'removed' | 'unchanged'
  line: string
}

export type DiffResponsesOutput = {
  statusChanged: boolean
  statusA: number
  statusB: number
  lengthA: number
  lengthB: number
  lengthDelta: number
  timingDeltaMs: number | null
  bodyIdentical: boolean
  lineDiff: LineDiffEntry[]
  changedLineCount: number
}

// ---------------------------------------------------------------------------
// detect_encoding
// ---------------------------------------------------------------------------

export type DetectEncodingInput = {
  body: string
}

export type DetectEncodingOutput = {
  entropy: number
  likelyEncodings: Array<'base64' | 'hex' | 'url-encoded' | 'plain-text'>
  highEntropy: boolean
  flags: string[]
}
