// External-binary wrapper: ffuf content discovery (ARCHITECTURE §8.6 — brokered
// external binaries). Same rules as run_tool: argv-only (no shell), scope-checked
// before spawn, hard wall-clock cap, and no wordlist/URL value is ever
// interpolated into a command line. ffuf is not shipped with Reconix, so a
// missing binary is reported as a clear, actionable error instead of a crash.
//
// The full NDJSON stream is persisted as a `trace` (rawRef) because the agent
// only gets a capped slice of results in the reply — the trace is where the
// complete match list lives.
import { constants as fsConstants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { defineTool, type Tool, type ToolContext } from '../tool'
import { ToolExecError, ToolInputError } from '../errors'
import { str, urlString } from '../validate'
import { MAX_LIST_ITEMS } from '../limits'
import { RunToolSpawnError, runTool, type RunToolResult } from './runTool'

const FFUF_TIMEOUT_MS = 120_000
/** Cap on captured stdout/stderr so a runaway wordlist can't exhaust memory. */
const FFUF_MAX_CAPTURE = 4 * 1024 * 1024
const FFUF_DEFAULT_THREADS = 40
const FFUF_MAX_THREADS = 200

interface FfufInput {
  url: string
  wordlist: string
  matchCodes?: number[]
  filterCodes?: number[]
  threads: number
}

interface FfufRow {
  url: string
  status: number
  length: number
  words: number
}

// ── input helpers ─────────────────────────────────────────────────────────────
/**
 * ffuf needs a FUZZ keyword somewhere in the URL. Callers often pass just the
 * base URL, so append `/FUZZ` to the path (query/hash preserved) when absent.
 */
function withFuzzKeyword(url: string): string {
  if (url.includes('FUZZ')) return url
  const u = new URL(url)
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/FUZZ`
  return u.href
}

/** A non-empty array of integer HTTP status codes, or undefined when omitted. */
function optCodes(raw: unknown, key: string): number[] | undefined {
  const v = (raw as Record<string, unknown> | null | undefined)?.[key]
  if (v === undefined) return undefined
  if (!Array.isArray(v)) throw new ToolInputError(`"${key}" must be an array of HTTP status codes`)
  const codes: number[] = []
  for (const entry of v) {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 100 || entry > 599) {
      throw new ToolInputError(`"${key}" entries must be integer HTTP status codes (100-599)`)
    }
    codes.push(entry)
  }
  if (codes.length === 0) throw new ToolInputError(`"${key}" must contain at least one code when provided`)
  if (codes.length > 100) throw new ToolInputError(`"${key}" max 100 codes per call`)
  return codes
}

// ── ffuf execution ────────────────────────────────────────────────────────────
/** Runs ffuf through the shared runner, keeping ffuf's install hint on ENOENT. */
async function runFfuf(args: string[]): Promise<RunToolResult> {
  try {
    return await runTool('ffuf', args, {
      timeoutMs: FFUF_TIMEOUT_MS,
      maxOutputBytes: FFUF_MAX_CAPTURE
    })
  } catch (err) {
    if (err instanceof RunToolSpawnError && err.spawnCode === 'ENOENT') {
      throw new ToolExecError(
        'ffuf is not installed or not on PATH — install ffuf (https://github.com/ffuf/ffuf) and retry; no requests were sent'
      )
    }
    throw err instanceof RunToolSpawnError
      ? new ToolExecError(`ffuf_fuzz: failed to spawn "ffuf": ${err.message}`)
      : err
  }
}

// ── output parsing ────────────────────────────────────────────────────────────
/**
 * `ffuf -json` emits one JSON object per match (NDJSON). A whole-document
 * `{"results": [...]}` shape is accepted too, since `-of json`/saved output uses
 * it. Lines that aren't match objects (banner noise, progress) are counted
 * rather than thrown — a partly noisy stream should not lose the real hits.
 */
function parseResults(stdout: string): { rows: FfufRow[]; malformed: number } {
  const rows: FfufRow[] = []
  let malformed = 0
  const add = (entry: unknown): boolean => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
    const e = entry as Record<string, unknown>
    if (typeof e.url !== 'string' || e.url.length === 0 || typeof e.status !== 'number') return false
    rows.push({
      url: e.url,
      status: e.status,
      length: typeof e.length === 'number' ? e.length : 0,
      words: typeof e.words === 'number' ? e.words : 0
    })
    return true
  }

  const text = stdout.trim()
  if (text.length === 0) return { rows, malformed }

  // Single JSON document (no newlines separating records).
  if (!text.includes('\n')) {
    try {
      const doc = JSON.parse(text) as unknown
      const results = (doc as { results?: unknown } | null)?.results
      if (Array.isArray(results)) {
        for (const entry of results) if (!add(entry)) malformed++
        return { rows, malformed }
      }
      if (add(doc)) return { rows, malformed }
    } catch {
      // Not a JSON document — fall through to line splitting.
    }
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      if (!add(JSON.parse(trimmed))) malformed++
    } catch {
      malformed++
    }
  }
  return { rows, malformed }
}

function stderrTail(stderr: string, max = 400): string {
  const trimmed = stderr.trim()
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(trimmed.length - max)}`
}

// ── ffuf_fuzz ─────────────────────────────────────────────────────────────────
const ffuf_fuzz = defineTool<FfufInput, unknown>({
  name: 'ffuf_fuzz',
  description:
    'Content discovery with ffuf: fuzz a FUZZ keyword (path/query/body) against a wordlist and return the matching responses (url/status/length/words). Tier D external binary — argv-only, scope-checked before spawn, 120s wall-clock cap (-maxtime). Prefer small targeted wordlists (<=5000 entries) to avoid long runs; the full match list is kept in the returned rawRef trace.',
  riskTier: 'D',
  inputSchema: {
    type: 'object',
    required: ['url', 'wordlist'],
    properties: {
      url: { type: 'string', description: 'Target URL containing FUZZ; /FUZZ is appended when absent.' },
      wordlist: { type: 'string', description: 'Path to a wordlist file.' },
      matchCodes: { type: 'array', items: { type: 'number' }, description: 'ffuf -mc: codes to show (100-599).' },
      filterCodes: { type: 'array', items: { type: 'number' }, description: 'ffuf -fc: codes to hide (100-599).' },
      threads: { type: 'number', minimum: 1, maximum: FFUF_MAX_THREADS, description: `ffuf -t (default ${FFUF_DEFAULT_THREADS}).` }
    },
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      results: { type: 'array', items: { type: 'object' } },
      count: { type: 'number' },
      rawRef: { type: 'string' }
    }
  },
  parse: (raw) => {
    const url = withFuzzKeyword(urlString(raw, 'url'))
    const wordlist = str(raw, 'wordlist', 4096)
    // A leading dash would be parsed by ffuf as a flag, not a file.
    if (wordlist.startsWith('-')) throw new ToolInputError('"wordlist" must be a file path, not an ffuf flag')
    const threadsRaw = (raw as Record<string, unknown>).threads
    let threads = FFUF_DEFAULT_THREADS
    if (threadsRaw !== undefined) {
      if (typeof threadsRaw !== 'number' || !Number.isInteger(threadsRaw)) {
        throw new ToolInputError('"threads" must be an integer')
      }
      if (threadsRaw < 1 || threadsRaw > FFUF_MAX_THREADS) {
        throw new ToolInputError(`"threads" must be between 1 and ${FFUF_MAX_THREADS}`)
      }
      threads = threadsRaw
    }
    return {
      url,
      wordlist,
      matchCodes: optCodes(raw, 'matchCodes'),
      filterCodes: optCodes(raw, 'filterCodes'),
      threads
    }
  },
  target: (i) => i.url,
  execute: async (i, ctx: ToolContext) => {
    // Defense in depth: the pipeline already checked `target`, but the argv is
    // built here and a URL with FUZZ in the host would change the resolved host.
    if (!ctx.scope.isInScope(i.url)) throw new ToolExecError('target out of scope — ffuf not started')

    try {
      await access(i.wordlist, fsConstants.R_OK)
      const info = await stat(i.wordlist)
      if (!info.isFile()) throw new Error('not a file')
    } catch {
      throw new ToolInputError(`"wordlist" is not a readable file: ${i.wordlist}`)
    }

    const args = ['-u', i.url, '-w', i.wordlist, '-json']
    if (i.matchCodes) args.push('-mc', i.matchCodes.join(','))
    if (i.filterCodes) args.push('-fc', i.filterCodes.join(','))
    args.push('-t', String(i.threads))
    args.push('-maxtime', String(Math.ceil(FFUF_TIMEOUT_MS / 1000)))

    const run = await runFfuf(args)
    const { rows, malformed } = parseResults(run.stdout)
    const truncated = run.stdoutTruncated || run.stderrTruncated
    const rawRef = await ctx.traces.save(
      'trace',
      JSON.stringify({
        tool: 'ffuf_fuzz',
        argv: args,
        url: i.url,
        wordlist: i.wordlist,
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        stdoutTruncated: truncated,
        stderr: run.stderr,
        stdout: run.stdout
      })
    )

    // Nothing parsed and a non-zero/timed-out run: the failure is the useful
    // result (bad wordlist, unreachable target), so surface ffuf's own words.
    if (rows.length === 0 && (run.timedOut || run.exitCode !== 0)) {
      const why = run.timedOut
        ? `ffuf hit the ${FFUF_TIMEOUT_MS / 1000}s wall-clock cap before returning a match`
        : `ffuf exited with code ${String(run.exitCode)} and returned no matches`
      const detail = stderrTail(run.stderr)
      throw new ToolExecError(`${why}${detail ? ` — ${detail}` : ''} (raw output: ${rawRef})`)
    }

    const returned = rows.slice(0, MAX_LIST_ITEMS)
    const omitted = rows.length - returned.length
    const note = run.timedOut
      ? `ffuf timed out after ${FFUF_TIMEOUT_MS / 1000}s — ${rows.length} match(es) were collected before the cap; narrow the wordlist or reduce threads/filters before retrying`
      : rows.length === 0
        ? 'ffuf returned no matches — check that the wordlist and FUZZ placement are right, and that -mc/-fc are not filtering everything out'
        : omitted > 0
          ? `showing the first ${returned.length} of ${rows.length} matches; the full list is in rawRef`
          : malformed > 0
            ? `${malformed} unparseable output line(s) were skipped — inspect rawRef if a match seems missing`
            : 'matches are ready to triage — replay interesting hits with replay_request before recording a finding'

    return {
      url: i.url,
      results: returned,
      count: rows.length,
      rawRef,
      returned: returned.length,
      truncated: omitted > 0,
      omitted,
      timedOut: run.timedOut,
      exitCode: run.exitCode,
      malformedLines: malformed,
      note
    }
  }
})

export const ffufTools: Tool[] = [ffuf_fuzz as Tool]
