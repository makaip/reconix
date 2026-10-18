// OpenCode tool adapter (bridge).
//
// Turns a `CapabilityTool` (§5.E) into a neutral `ToolDescriptor` the OpenCode
// plugin can register without knowing anything about individual tools. This
// module is intentionally free of any `@opencode/*` import so it stays pure,
// environment-agnostic, and unit-testable alongside the rest of `src/tools`.
//
// The adapter reuses each tool's own `validateInput` as the runtime gate and
// only serializes the handler's output, so the OpenCode-facing schema
// (`inputSchema`) and the enforcement logic can never drift.

import type { CapabilityTool } from '../../shared/tools'
import type { JsonSchema } from '../schema'

/**
 * A tool as the OpenCode runtime consumes it: a description, an input JSON
 * Schema, and an `execute` that returns `{ content }`. Both the pure-capability
 * tools and hand-authored native tools (subprocess/inline) resolve to this.
 */
export type ToolDescriptor = {
  name: string
  description: string
  input: JsonSchema
  /**
   * Optional output schema declared to the host. When set, the host validates
   * `execute`'s returned `output` against it — so `execute` MUST return one.
   */
  output?: JsonSchema
  riskTier?: CapabilityTool<unknown, unknown>['riskTier']
  execute: (input: unknown) => Promise<{ content: string; output?: unknown }>
}

/** JSON-stringify without throwing on cyclic / BigInt-bearing outputs. */
function safeStringify(value: unknown, pretty = false): string {
  try {
    return JSON.stringify(value, null, pretty ? 2 : 0)
  } catch {
    return JSON.stringify({ status: 'error', reason: 'tool output was not JSON-serializable' })
  }
}

/**
 * Adapt a pure-compute `CapabilityTool` to a `ToolDescriptor`.
 *
 * `execute` mirrors §5.C's pipeline step 1: validate hostile input first, and
 * only call `handler` on success. Validation failures and thrown handlers are
 * reported as structured `{ status: 'error', ... }` content rather than
 * rejecting, so a single bad call never aborts the caller.
 */
export function fromCapabilityTool<TInput, TOutput>(
  tool: CapabilityTool<TInput, TOutput>
): ToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    input: tool.inputSchema,
    ...(tool.outputSchema !== undefined ? { output: tool.outputSchema } : {}),
    riskTier: tool.riskTier,
    execute: async (raw: unknown) => {
      const parsed = tool.validateInput(raw)
      if (!parsed.ok) {
        return {
          content: safeStringify({
            status: 'error',
            tool: tool.name,
            errors: parsed.errors
          })
        }
      }
      try {
        const result = tool.handler(parsed.value)
        const content = safeStringify(result, true)
        // If an output schema is declared, the host requires the returned
        // `output` too, and validates it against that schema.
        return tool.outputSchema !== undefined ? { content, output: result } : { content }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return {
          content: safeStringify({ status: 'error', tool: tool.name, reason })
        }
      }
    }
  }
}
