// Native OpenCode tool descriptors that are NOT pure-compute `CapabilityTool`s:
//
//   * `z3_string_solver` shells out to a Python helper (async subprocess), so it
//     does not fit the sync, pure-compute `handler` contract.
//   * `dom_evaluator` is a small inline analyzer with no `src/tools` home.
//
// They resolve to the same neutral `ToolDescriptor` as everything else, so the
// plugin registers all tools through one loop.

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"

import type { ToolDescriptor } from "./descriptor"
import { num, obj, str } from "../schema"

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

/** `z3_string_solver` — subprocess-backed, so it needs the resolved directory. */
function z3SolverDescriptor(directory: string): ToolDescriptor {
  return {
    name: "z3_string_solver",
    description:
      "Bypass strict input validation, length limits, or regex rules by mathematically solving constraints using Z3.",
    input: obj(
      {
        maxLength: num("Maximum allowed character length for the input field."),
        mustContain: str("A mandatory substring or payload fragment that must be included."),
        pattern: str("An optional regex pattern the input must satisfy."),
      },
      ["maxLength"],
    ),
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
}

/** `dom_evaluator` — inline pure analyzer. */
function domEvaluatorDescriptor(): ToolDescriptor {
  return {
    name: "dom_evaluator",
    description:
      "Evaluate the impact of a browser action by comparing DOM states, checking for new error messages, alerts, and URL changes.",
    input: obj(
      {
        baselineHtml: str("The HTML snapshot taken before the action was executed."),
        currentHtml: str("The current HTML snapshot after the action was executed."),
        currentUrl: str("The current page URL to check for unexpected redirects."),
      },
      ["currentHtml"],
    ),
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
}

/** All native (non-`CapabilityTool`) descriptors for this plugin. */
export function createNativeDescriptors(directory: string): ToolDescriptor[] {
  return [z3SolverDescriptor(directory), domEvaluatorDescriptor()]
}
