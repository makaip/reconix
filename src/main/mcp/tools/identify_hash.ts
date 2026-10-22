// `identify_hash` — hash-type identification and crack-strategy advisory.
// Tier R: pure analysis. The tool never runs a cracker, never reads a wordlist
// file, and never touches a target: it shells out to the Python sidecar
// (.opencode/tools/identify_hash.py), which pattern-matches the value and maps
// the most likely type to the hashcat mode / John format an operator would use
// *if* they are authorized to crack it. No `target` hook for the same reason —
// there is no scope-relevant host.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ToolExecError, ToolInputError } from '../errors'
import { defineTool, type Tool } from '../tool'
import { str } from '../validate'

/** Hash identification is O(length); anything near this is a hung interpreter. */
const PY_TIMEOUT_MS = 10_000
/** Sidecar output is one small JSON object; cap hostile output hard. */
const MAX_OUTPUT_BYTES = 1_000_000
/** At most this many candidates are trusted from the sidecar. */
const MAX_CANDIDATES = 16
const MAX_HASH_LENGTH = 512

const SCRIPT_NAME = 'identify_hash.py'
const SCRIPT_REL = join('.opencode', 'tools', SCRIPT_NAME)

export interface IdentifyHashInput {
  hash: string
}

export interface IdentifyHashCandidate {
  type: string
  confidence: number
  pattern?: string
}

export interface IdentifyHashCrackStrategy {
  tool: string
  mode?: number
  johnFormat?: string
  wordlist?: string
  estimatedTime?: string
  notes?: string
}

export interface IdentifyHashOutput {
  hash: string
  length: number
  candidates: IdentifyHashCandidate[]
  primaryType?: string
  crackStrategy?: IdentifyHashCrackStrategy
  advisory: string
  /** Trace ref of the raw Python stdout, when a trace store is wired. */
  rawRef?: string
}

/**
 * The module directory without assuming a module system. The Electron main
 * bundle is CJS (`__dirname` present); Vitest runs these files as ESM, where
 * `__dirname` is undeclared — `typeof` is safe there and process.cwd() (the
 * repo root under `npm test`) yields the same path.
 */
function moduleDir(): string {
  if (typeof __dirname === 'string' && __dirname.length > 0) return __dirname
  return process.cwd()
}

/** Repo-root candidates, newest-layout first. */
function repoRootCandidates(): string[] {
  const here = moduleDir()
  return [
    // src/main/mcp/tools -> repo root (dev / Vitest).
    join(here, '..', '..', '..', '..'),
    process.cwd(),
    // Bundled out/main -> repo root.
    join(here, '..', '..')
  ]
}

/**
 * Resolves the sidecar path. The first existing candidate wins; when none
 * exists the primary candidate is returned anyway so the spawn failure (or
 * Python's "can't open file") carries a concrete path to report. Exported so a
 * test can assert the real checkout resolves it.
 */
export function resolveScriptPath(): string {
  const candidates = repoRootCandidates().map((root) => join(root, SCRIPT_REL))
  return candidates.find((p) => existsSync(p)) ?? candidates[0]
}

/**
 * Interpreter preference: explicit override, then the repo virtualenv, then
 * PATH. The venv is derived from the script path so a relocated checkout still
 * resolves its own `.venv`.
 */
export function resolvePython(scriptPath: string): string {
  const override = process.env.RECONIX_PYTHON?.trim()
  if (override) return override

  // <root>/.opencode/tools/identify_hash.py -> <root>
  const root = dirname(dirname(dirname(scriptPath)))
  const venv =
    process.platform === 'win32'
      ? join(root, '.venv', 'Scripts', 'python.exe')
      : join(root, '.venv', 'bin', 'python')
  if (existsSync(venv)) return venv

  return process.platform === 'win32' ? 'python' : 'python3'
}

interface PythonFailure extends Error {
  code?: string
  killed?: boolean
  stdout?: string
  stderr?: string
}

/** Promise wrapper around execFile (argv-only: no shell, no interpolation). */
function runPython(
  binary: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      binary,
      args,
      { timeout: PY_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const failure = new Error(err.message) as PythonFailure
          failure.code = (err as NodeJS.ErrnoException).code
          failure.killed = (err as { killed?: boolean }).killed
          failure.stdout = stdout
          failure.stderr = stderr
          reject(failure)
          return
        }
        resolvePromise({ stdout, stderr })
      }
    )
  })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function toCandidate(value: unknown): IdentifyHashCandidate | null {
  const rec = asRecord(value)
  if (!rec) return null
  if (typeof rec.type !== 'string' || rec.type.length === 0) return null
  if (typeof rec.confidence !== 'number' || !Number.isFinite(rec.confidence)) return null
  return {
    type: rec.type,
    confidence: rec.confidence,
    ...(typeof rec.pattern === 'string' ? { pattern: rec.pattern } : {})
  }
}

function toCrackStrategy(value: unknown): IdentifyHashCrackStrategy | undefined {
  const rec = asRecord(value)
  if (!rec || typeof rec.tool !== 'string' || rec.tool.length === 0) return undefined
  const strategy: IdentifyHashCrackStrategy = { tool: rec.tool }
  if (typeof rec.mode === 'number' && Number.isFinite(rec.mode)) strategy.mode = rec.mode
  if (typeof rec.johnFormat === 'string') strategy.johnFormat = rec.johnFormat
  if (typeof rec.wordlist === 'string') strategy.wordlist = rec.wordlist
  if (typeof rec.estimatedTime === 'string') strategy.estimatedTime = rec.estimatedTime
  if (typeof rec.notes === 'string') strategy.notes = rec.notes
  return strategy
}

/**
 * Parses and shape-checks the sidecar's single JSON object. A non-JSON or
 * structurally wrong payload is an execution failure, not "unknown hash" —
 * silently treating a broken sidecar as "no candidates" would report a false
 * negative about a hash the operator asked about.
 */
export function parseSidecarOutput(stdout: string, fallbackHash: string): IdentifyHashOutput {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new ToolExecError(
      `identify_hash: the Python sidecar (${SCRIPT_NAME}) returned output that is not valid JSON — ` +
        'the script may be corrupt or an interpreter banner was written to stdout. ' +
        `Re-run it manually: python ${SCRIPT_REL} --hash <hash>. Received: ${stdout.slice(0, 200)}`
    )
  }

  const rec = asRecord(parsed)
  if (!rec) {
    throw new ToolExecError(
      `identify_hash: the Python sidecar (${SCRIPT_NAME}) returned ${Array.isArray(parsed) ? 'a JSON array' : typeof parsed} ` +
        'instead of a JSON object — expected { hash, candidates, crackStrategy, advisory }.'
    )
  }
  if (!Array.isArray(rec.candidates)) {
    throw new ToolExecError(
      `identify_hash: the Python sidecar (${SCRIPT_NAME}) output is missing a "candidates" array — ` +
        'the script is out of date with the MCP wrapper; reinstall or re-run it manually.'
    )
  }
  if (typeof rec.advisory !== 'string' || rec.advisory.length === 0) {
    throw new ToolExecError(
      `identify_hash: the Python sidecar (${SCRIPT_NAME}) output is missing the required "advisory" field.`
    )
  }

  const candidates = rec.candidates
    .slice(0, MAX_CANDIDATES)
    .map(toCandidate)
    .filter((c): c is IdentifyHashCandidate => c !== null)

  // Prefer the sidecar's primaryType, but never trust it over the data: if it
  // is absent or does not name a listed candidate, derive it by confidence.
  const primaryType =
    typeof rec.primaryType === 'string' && candidates.some((c) => c.type === rec.primaryType)
      ? rec.primaryType
      : candidates.reduce<IdentifyHashCandidate | undefined>(
          (best, c) => (best === undefined || c.confidence > best.confidence ? c : best),
          undefined
        )?.type

  const crackStrategy = toCrackStrategy(rec.crackStrategy)

  return {
    hash: typeof rec.hash === 'string' && rec.hash.length > 0 ? rec.hash : fallbackHash,
    length: typeof rec.length === 'number' && Number.isFinite(rec.length) ? rec.length : fallbackHash.length,
    candidates,
    ...(primaryType ? { primaryType } : {}),
    ...(crackStrategy ? { crackStrategy } : {}),
    advisory: rec.advisory
  }
}

const identify_hash = defineTool<IdentifyHashInput, IdentifyHashOutput>({
  name: 'identify_hash',
  description:
    'Identify a hash type from its shape (bcrypt, argon2id/argon2i, SHA-512/384/256/224/1, MD5, NTLM, MySQL 4.1+) and return ranked candidates plus a crack strategy (hashcat mode / John format / wordlist) for the most likely type. Advisory only — it never cracks anything, reads no wordlist, and contacts no target. Use the returned mode with an authorized cracking tool. Unknown shapes return an empty candidate list, not an error.',
  riskTier: 'R',
  inputSchema: {
    type: 'object',
    required: ['hash'],
    properties: {
      hash: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_HASH_LENGTH,
        description: 'The hash value to identify (e.g. the contents of a leaked users table column).'
      }
    },
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      hash: { type: 'string' },
      length: { type: 'number' },
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            confidence: { type: 'number' },
            pattern: { type: 'string' }
          }
        }
      },
      primaryType: { type: 'string' },
      crackStrategy: {
        type: 'object',
        properties: {
          tool: { type: 'string' },
          mode: { type: 'number' },
          johnFormat: { type: 'string' },
          wordlist: { type: 'string' },
          estimatedTime: { type: 'string' },
          notes: { type: 'string' }
        }
      },
      advisory: { type: 'string' },
      rawRef: { type: 'string' }
    }
  },
  // No scope target: this is local string analysis, never a request.
  target: () => undefined,
  parse: (raw) => {
    const hash = str(raw, 'hash', MAX_HASH_LENGTH)
    if (hash.trim().length === 0) {
      throw new ToolInputError('"hash" must be a non-empty string')
    }
    if (/\s/.test(hash)) {
      throw new ToolInputError(
        '"hash" must not contain whitespace — paste the raw hash value only (no field labels, spaces, or line breaks)'
      )
    }
    return { hash }
  },
  execute: async (i, ctx) => {
    const scriptPath = resolveScriptPath()
    const python = resolvePython(scriptPath)

    let stdout: string
    try {
      const run = await runPython(python, [scriptPath, '--hash', i.hash])
      stdout = run.stdout
    } catch (err) {
      const failure = err as PythonFailure
      if (failure.code === 'ENOENT') {
        throw new ToolExecError(
          `identify_hash: could not start the Python interpreter "${python}" (binary not found) — no analysis was run. ` +
            'Install Python 3 or point RECONIX_PYTHON at an interpreter; the sidecar is ' +
            `${SCRIPT_REL}.`
        )
      }
      if (failure.killed === true) {
        throw new ToolExecError(
          `identify_hash: the Python sidecar did not finish within ${PY_TIMEOUT_MS / 1000}s and was killed — ` +
            'the interpreter may be hanging on startup; verify it works by running ' +
            `"${python}" ${SCRIPT_REL} --hash <hash> manually.`,
          true
        )
      }
      const stderr = (failure.stderr ?? '').trim()
      if (/can't open file|No such file or directory/i.test(stderr)) {
        throw new ToolExecError(
          `identify_hash: the Python sidecar script was not found at ${scriptPath} — ` +
            'the .opencode/tools directory is missing or the app was launched from the wrong working directory. ' +
            `Re-run from the repo root, or run the sidecar manually: "${python}" ${SCRIPT_REL} --hash <hash>.`
        )
      }
      throw new ToolExecError(
        `identify_hash: the Python sidecar failed (exit ${failure.code ?? 'non-zero'})` +
          (stderr ? ` — ${stderr.slice(-1000)}` : ' with no stderr output') +
          `. Verify it runs: "${python}" ${SCRIPT_REL} --hash <hash>.`
      )
    }

    if (stdout.trim().length === 0) {
      throw new ToolExecError(
        `identify_hash: the Python sidecar (${SCRIPT_NAME}) wrote nothing to stdout — ` +
          'it prints exactly one JSON object on success, so this indicates a broken interpreter/script.'
      )
    }

    const result = parseSidecarOutput(stdout, i.hash)
    const rawRef = await ctx.traces?.save('trace', stdout)

    return rawRef ? { ...result, rawRef } : result
  }
})

export const identifyHashTools: Tool[] = [identify_hash as Tool]
