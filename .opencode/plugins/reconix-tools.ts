import { Plugin } from "@opencode/plugin"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"

/**
 * Reconix custom tools (OpenCode V2).
 *
 * V2 does not discover `.opencode/tools/*.ts` (that was the V1 layout). Custom
 * tools are registered by a plugin under `.opencode/plugins/` through
 * `ctx.tool.transform(...)`.
 *
 * Each tool is registered twice so both call paths work:
 *   1. direct tool call      -> `z3_string_solver`            (options.codemode: false)
 *   2. Code Mode runtime     -> `tools.reconix.z3_string_solver` (options.codemode: true)
 *
 * The two registrations have different effective names (`z3_string_solver` vs
 * `reconix_z3_string_solver`), so neither overrides the other.
 */

const CODEMODE_NAMESPACE = "reconix"

const Z3_SCRIPT = [".opencode", "tools", "z3_string_solver.py"]

function resolvePython(directory: string): string {
  const candidates = [
    process.env.RECONIX_PYTHON,
    path.join(directory, ".venv", "bin", "python"),
    path.join(directory, ".venv", "bin", "python3"),
    "python3",
  ].filter((value): value is string => typeof value === "string" && value.length > 0)

  for (const candidate of candidates) {
    if (candidate === "python3" || existsSync(candidate)) return candidate
  }
  return "python3"
}

function runScript(
  interpreter: string,
  script: string,
  args: string[],
  cwd: string,
): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      interpreter,
      [script, ...args],
      { cwd, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || error.message || error).trim()
          resolve(JSON.stringify({ status: "error", reason: detail || "solver execution failed" }))
          return
        }
        resolve(String(stdout).trim())
      },
    )
  })
}

export default Plugin.define({
  id: "reconix.tools",
  async setup(ctx) {
    const directory = ctx.location?.directory ?? process.cwd()

    const z3Solver = {
      description:
        "Bypass strict input validation, length limits, or regex rules by mathematically solving constraints using Z3.",
      input: {
        type: "object",
        properties: {
          maxLength: {
            type: "number",
            description: "Maximum allowed character length for the input field.",
          },
          mustContain: {
            type: "string",
            description: "A mandatory substring or payload fragment that must be included.",
          },
          pattern: {
            type: "string",
            description: "An optional regex pattern the input must satisfy.",
          },
        },
        required: ["maxLength"],
        additionalProperties: false,
      },
      execute: async (input: unknown) => {
        const args = input as {
          maxLength: number
          mustContain?: string
          pattern?: string
        }

        const script = path.join(directory, ...Z3_SCRIPT)
        if (!existsSync(script)) {
          return {
            content: JSON.stringify({ status: "error", reason: `solver script not found: ${script}` }),
          }
        }

        const cmdArgs = ["--max-len", String(args.maxLength)]
        if (args.mustContain) cmdArgs.push("--contain", args.mustContain)
        if (args.pattern) cmdArgs.push("--pattern", args.pattern)

        const output = await runScript(resolvePython(directory), script, cmdArgs, directory)
        return { content: output }
      },
    }

    const domEvaluator = {
      description:
        "Evaluate the impact of a browser action by comparing DOM states, checking for new error messages, alerts, and URL changes.",
      input: {
        type: "object",
        properties: {
          baselineHtml: {
            type: "string",
            description: "The HTML snapshot taken before the action was executed.",
          },
          currentHtml: {
            type: "string",
            description: "The current HTML snapshot after the action was executed.",
          },
          currentUrl: {
            type: "string",
            description: "The current page URL to check for unexpected redirects.",
          },
        },
        required: ["currentHtml"],
        additionalProperties: false,
      },
      execute: async (input: unknown) => {
        const args = input as {
          baselineHtml?: string
          currentHtml: string
          currentUrl?: string
        }

        const indicators = [
          "success",
          "error",
          "invalid",
          "unauthorized",
          "welcome",
          "flag",
          "token",
          "admin",
          "dashboard",
          "alert",
          "xss",
          "payload",
          "injection",
          "critical",
          "warning",
        ]

        const currentLower = (args.currentHtml ?? "").toLowerCase()
        const baselineLower = (args.baselineHtml ?? "").toLowerCase()

        const detectedKeywords = indicators.filter((keyword) => {
          if (!currentLower.includes(keyword)) return false
          if (!args.baselineHtml) {
            return ["flag", "token", "admin", "xss", "injection"].includes(keyword)
          }
          return !baselineLower.includes(keyword)
        })

        const payload = {
          status: "evaluated",
          url: args.currentUrl ?? "unknown",
          newlyAppearedKeywords: detectedKeywords,
          summary:
            detectedKeywords.length > 0
              ? `Action triggered state changes containing key terms: ${detectedKeywords.join(", ")}`
              : "No significant state change or indicator keywords detected in the DOM.",
          analysis: {
            baselineProvided: !!args.baselineHtml,
            keywordCount: detectedKeywords.length,
          },
        }

        return { content: JSON.stringify(payload, null, 2) }
      },
    }

    await ctx.tool.transform((editor) => {
      // Code Mode namespace so the runtime exposes `tools.reconix.<tool>`.
      editor.namespace({
        name: CODEMODE_NAMESPACE,
        description: "Reconix penetration-testing helpers",
      })

      const register = (
        name: string,
        definition: { description: string; input: unknown; execute: (input: unknown) => Promise<{ content: string }> },
      ) => {
        // Path 1: direct tool call.
        editor.add({
          name,
          description: definition.description,
          input: definition.input,
          options: { codemode: false },
          execute: definition.execute,
        } as never)

        // Path 2: Code Mode runtime, namespaced as `tools.reconix.<name>`.
        editor.add({
          name,
          description: definition.description,
          input: definition.input,
          options: { codemode: true, namespace: CODEMODE_NAMESPACE },
          execute: definition.execute,
        } as never)
      }

      register("z3_string_solver", z3Solver)
      register("dom_evaluator", domEvaluator)
    })
  },
})
