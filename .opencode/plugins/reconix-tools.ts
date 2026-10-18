import { Plugin } from "@opencode/plugin"

import { capabilityLoaders } from "../../src/tools/opencode/catalog"
import {
  fromCapabilityTool,
  type ToolDescriptor,
} from "../../src/tools/opencode/descriptor"
import { createNativeDescriptors } from "../../src/tools/opencode/native"

/**
 * Reconix custom tools (OpenCode V2).
 *
 * V2 does not discover `.opencode/tools/*.ts` (that was the V1 layout). Custom
 * tools are registered by a plugin under `.opencode/plugins/` through
 * `ctx.tool.transform(...)`.
 *
 * This plugin is a thin shell. All tool definitions come from the descriptor
 * bridge in `src/tools/opencode`:
 *   * `capabilityLoaders` — the pure-compute §5.E tools, each lazily imported
 *     from `src/tools` and adapted via `fromCapabilityTool`, and
 *   * `createNativeDescriptors` — the two non-`CapabilityTool` tools
 *     (`z3_string_solver`, `dom_evaluator`).
 *
 * Each descriptor is registered twice so both call paths work:
 *   1. direct tool call      -> `z3_string_solver`              (options.codemode: false)
 *   2. Code Mode runtime     -> `tools.reconix.z3_string_solver` (options.codemode: true)
 *
 * The two registrations have different effective names (`z3_string_solver` vs
 * `reconix_z3_string_solver`), so neither overrides the other.
 */

const CODEMODE_NAMESPACE = "reconix"

/**
 * Resolve every capability tool lazily and adapt it. A module that fails to
 * load only disables its own tool — the rest still register.
 */
async function collectCapabilityDescriptors(): Promise<ToolDescriptor[]> {
  const descriptors: ToolDescriptor[] = []
  const failures: string[] = []

  for (const load of capabilityLoaders) {
    try {
      descriptors.push(fromCapabilityTool(await load()))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      failures.push(detail)
    }
  }

  if (failures.length > 0) {
    // Non-fatal: surface which tools were skipped so the surface is debuggable.
    console.error(
      `[reconix.tools] ${failures.length} capability tool(s) failed to load: ${failures.join("; ")}`,
    )
  }

  return descriptors
}

export default Plugin.define({
  id: "reconix.tools",
  async setup(ctx) {
    const directory = ctx.location?.directory ?? process.cwd()

    const descriptors: ToolDescriptor[] = [
      ...(await collectCapabilityDescriptors()),
      ...createNativeDescriptors(directory),
    ]

    await ctx.tool.transform((editor) => {
      // Code Mode namespace so the runtime exposes `tools.reconix.<tool>`.
      editor.namespace({
        name: CODEMODE_NAMESPACE,
        description: "Reconix penetration-testing helpers",
      })

      for (const descriptor of descriptors) {
        // Path 1: direct tool call.
        editor.add({
          name: descriptor.name,
          description: descriptor.description,
          input: descriptor.input,
          ...(descriptor.output !== undefined ? { output: descriptor.output } : {}),
          options: { codemode: false },
          execute: descriptor.execute,
        } as never)

        // Path 2: Code Mode runtime, namespaced as `tools.reconix.<name>`.
        editor.add({
          name: descriptor.name,
          description: descriptor.description,
          input: descriptor.input,
          ...(descriptor.output !== undefined ? { output: descriptor.output } : {}),
          options: { codemode: true, namespace: CODEMODE_NAMESPACE },
          execute: descriptor.execute,
        } as never)
      }
    })
  },
})
