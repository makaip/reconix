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
import { arrOf, bool, num, obj, str } from "../schema"

const Z3_SCRIPT = [".opencode", "tools", "z3_string_solver.py"]

/** True when a bare command (e.g. `python`) is resolvable on `PATH`. */
function commandOnPath(command: string): boolean {
  const searchPath = process.env.PATH ?? process.env.Path ?? ""
  const extensions =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""]

  return searchPath
    .split(path.delimiter)
    .some(
      (dir) =>
        dir.length > 0 &&
        extensions.some((ext) => existsSync(path.join(dir, `${command}${ext}`))),
    )
}

function resolvePython(directory: string): string {
  // Explicit override always wins.
  const override = process.env.RECONIX_PYTHON
  if (typeof override === "string" && override.length > 0) return override

  // Project-local virtualenvs, Unix first then Windows, so `.venv/bin/python`
  // keeps precedence on POSIX hosts.
  const candidates = [
    path.join(directory, ".venv", "bin", "python"),
    path.join(directory, ".venv", "bin", "python3"),
    path.join(directory, ".venv", "Scripts", "python.exe"),
    path.join(directory, ".venv", "Scripts", "python"),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  // Interpreter names on `PATH`; `python`/`py` cover Windows launchers.
  for (const command of ["python", "py", "python3"]) {
    if (commandOnPath(command)) return command
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

/** Input shape of `z3_string_solver`, mirroring `.opencode/tools/z3_string_solver.py`. */
type Z3SolverInput = {
  maxLength?: unknown
  minLength?: unknown
  mustContain?: unknown
  mustNotContain?: unknown
  pattern?: unknown
  patterns?: unknown
  charset?: unknown
  forbiddenChars?: unknown
  numeric?: unknown
  intMin?: unknown
  intMax?: unknown
  intMod?: unknown
  intModRemainder?: unknown
  intDivisibleBy?: unknown
  intMustEqual?: unknown
  count?: unknown
  timeoutMs?: unknown
}

/** A finite JSON number, the only shape forwarded to a numeric CLI flag. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** A non-empty string, the only shape forwarded to a string CLI flag. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** Normalise `string | string[]` (or anything else) into a list of strings. */
function stringList(value: unknown): string[] {
  if (typeof value === "string") return value.length > 0 ? [value] : []
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.length > 0)
}

/** Stable de-duplication, so repeated patterns are not passed to the CLI twice. */
function unique(values: string[]): string[] {
  return [...new Set(values)]
}

/** `z3_string_solver` — subprocess-backed, so it needs the resolved directory. */
function z3SolverDescriptor(directory: string): ToolDescriptor {
  return {
    name: "z3_string_solver",
    description:
      "Bypass strict input validation, length limits, regex rules, or numeric constraints by " +
      "mathematically solving them with Z3. Supports min/max length, required and forbidden " +
      "substrings, single or multiple (ANDed) regex patterns, an allowed charset and forbidden " +
      "characters, batch generation of distinct candidates, and an integer mode with bounds, " +
      "modulus, divisibility, and exact-value constraints.",
    input: obj(
      {
        maxLength: num(
          "Maximum allowed character length for the input field (in numeric mode: the digit budget).",
        ),
        minLength: num("Minimum allowed character length for the input field."),
        mustContain: str("A mandatory substring or payload fragment that must be included."),
        mustNotContain: {
          description: "A substring, or list of substrings, that must NOT appear in the input.",
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
        pattern: str("An optional regex pattern the input must satisfy."),
        patterns: arrOf({ type: "string" }, "Additional regex patterns; every one must match (ANDed)."),
        charset: str("Allowed characters; restricts the candidate to this alphabet."),
        forbiddenChars: str("Characters that must never appear in the candidate."),
        numeric: bool("Solve for an integer instead of a string."),
        intMin: num("Numeric mode lower bound (defaults to 0)."),
        intMax: num("Numeric mode upper bound (defaults to 10**maxLength - 1)."),
        intMod: num("Require the integer n to satisfy n % intMod == intModRemainder."),
        intModRemainder: num("Remainder used with intMod (defaults to 0)."),
        intDivisibleBy: num("Require the integer to be divisible by this value."),
        intMustEqual: num("Require the integer to equal this exact value."),
        count: num("Number of distinct candidates to generate (defaults to 1)."),
        timeoutMs: num("Solver timeout in milliseconds."),
      },
      ["maxLength"],
    ),
    execute: async (input: unknown) => {
      const args = (input ?? {}) as Z3SolverInput

      const maxLength = finiteNumber(args.maxLength)
      if (maxLength === undefined) {
        return {
          content: JSON.stringify({
            status: "error",
            reason: "maxLength is required and must be a number",
          }),
        }
      }

      const count = finiteNumber(args.count)
      if (count !== undefined && (!Number.isInteger(count) || count < 1)) {
        return {
          content: JSON.stringify({
            status: "error",
            reason: "count must be an integer >= 1",
          }),
        }
      }

      const timeoutMs = finiteNumber(args.timeoutMs)
      if (timeoutMs !== undefined && timeoutMs <= 0) {
        return {
          content: JSON.stringify({
            status: "error",
            reason: "timeoutMs must be a positive number",
          }),
        }
      }

      const script = path.join(directory, ...Z3_SCRIPT)
      if (!existsSync(script)) {
        return {
          content: JSON.stringify({ status: "error", reason: `solver script not found: ${script}` }),
        }
      }

      // Ordered numeric/boolean flags: [input key, CLI flag].
      const numericFlags: Array<[keyof Z3SolverInput, string]> = [
        ["minLength", "--min-len"],
        ["intMin", "--int-min"],
        ["intMax", "--int-max"],
        ["intMod", "--int-mod"],
        ["intModRemainder", "--int-mod-remainder"],
        ["intDivisibleBy", "--int-divisible-by"],
        ["intMustEqual", "--int-must-equal"],
        ["count", "--count"],
        ["timeoutMs", "--timeout-ms"],
      ]

      const cmdArgs = ["--max-len", String(maxLength)]

      for (const [key, flag] of numericFlags) {
        const value = finiteNumber(args[key])
        if (value !== undefined) cmdArgs.push(flag, String(value))
      }

      const mustContain = nonEmptyString(args.mustContain)
      if (mustContain !== undefined) cmdArgs.push("--contain", mustContain)

      for (const forbidden of unique(stringList(args.mustNotContain))) {
        cmdArgs.push("--must-not-contain", forbidden)
      }

      // `pattern` and `patterns` are both emitted as repeatable `--pattern`.
      const patterns = unique([
        ...stringList(args.pattern),
        ...stringList(args.patterns),
      ])
      for (const pattern of patterns) cmdArgs.push("--pattern", pattern)

      const charset = nonEmptyString(args.charset)
      if (charset !== undefined) cmdArgs.push("--charset", charset)

      const forbiddenChars = nonEmptyString(args.forbiddenChars)
      if (forbiddenChars !== undefined) cmdArgs.push("--forbidden-chars", forbiddenChars)

      if (args.numeric === true) cmdArgs.push("--numeric")

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
