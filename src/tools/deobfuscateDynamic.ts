// deobfuscate_dynamic — ARCHITECTURE.MD §5.E / Dev 1 capability tool (P3).
//
// Consumes a *trace* of runtime hook activity captured from the target page
// (see src/tools/deobfuscateTrace.ts and .opencode/tools/deobfuscate_harness.js)
// and turns each captured payload into structured, deobfuscated findings.
//
// Safety posture (mirrors deobfuscate_static):
//   1. The trace is attacker-authored data. NOTHING in it is ever executed.
//      Payloads are strings; code-bearing ones are handed to the static engine's
//      confined AST interpreter, which has no DOM/network/filesystem.
//   2. Every loop is bounded (record count, per-string length, output budget) so
//      a hostile trace cannot hang or flood the caller.
//   3. This tool is pure-compute: no network, filesystem, or process I/O.
//
// The actual capture (CDP `Page.addScriptToEvaluateOnNewDocument`, reading the
// trace out of the page) belongs to the dynamic-instrumentation layer (Dev 3);
// this tool only analyzes the trace it is handed.

import type { CapabilityTool, ValidationResult } from '../shared/tools'
import {
  deobfuscateStaticTool,
  type DeobfuscateStaticOutput
} from './deobfuscateStatic'
import {
  DYNAMIC_HOOK_KINDS,
  DYNAMIC_RECORD_CLASSES,
  classifyRecord,
  normalizeHarnessDump,
  validateDynamicTrace,
  type DynamicHookKind,
  type DynamicRecordClass,
  type DynamicTrace,
  type DynamicTracePhase,
  type DynamicTraceRecord
} from './deobfuscateTrace'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeobfuscateDynamicInput = {
  trace: DynamicTrace
  /** Run the static engine over code-bearing payloads. Default true. */
  recurse?: boolean
  /** Cap on distinct findings analyzed. Default 200. */
  maxRecords?: number
  /** Cumulative cap on bytes of deobfuscated output. Default 256 KB. */
  maxOutputBytes?: number
  /** Only analyze these hook kinds (default: all). */
  kinds?: DynamicHookKind[]
  /** Only analyze these record classes (default: all). */
  classes?: DynamicRecordClass[]
  /** Skip payloads shorter than this many chars. Default 1. */
  minLength?: number
  /** Static passes chained per payload until it stabilizes. Default 2 (max 5). */
  maxDepth?: number
}

export type DynamicFinding = {
  index: number
  t: number
  kind: DynamicHookKind
  class: DynamicRecordClass
  payload: string
  truncated: boolean
  phase?: DynamicTracePhase
  sourceUrl?: string
  stack?: string
  static?: {
    status: 'ok' | 'partial' | 'error'
    family: string
    transformed: string
    truncated: boolean
    /** Number of static passes actually applied (>= 1). */
    depth: number
    indicators: DeobfuscateStaticOutput['indicators']
  }
  indicators: { urls: string[]; domains: string[] }
}

export type DeobfuscateDynamicOutput = {
  status: 'ok' | 'partial' | 'error'
  recordCount: number
  byKind: Record<string, number>
  findings: DynamicFinding[]
  indicators: { urls: string[]; domains: string[]; stringLiterals: string[] }
  notes: string[]
}

// ---------------------------------------------------------------------------
// Caps / constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RECORDS = 200
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024
const DEFAULT_MAX_DEPTH = 2
const MAX_DEPTH_LIMIT = 5
const MAX_INDICATORS = 200
const TRUNCATION_MARK = '\u2026'

const URL_RE = /https?:\/\/[^\s'"`<>()\\]+/g
const LITERAL_RE = /'([^'\n\\]{4,200})'|"([^"\n\\]{4,200})"|`([^`\n\\]{4,200})`/g

// ---------------------------------------------------------------------------
// Validation (input is hostile, §5.C rule 2)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validate(raw: unknown): ValidationResult<DeobfuscateDynamicInput> {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['input must be an object'] }
  }

  const hasTrace = raw.trace !== undefined
  const hasDump = raw.dump !== undefined
  if (hasTrace === hasDump) {
    return { ok: false, errors: ['provide exactly one of `trace` or `dump`'] }
  }

  const candidate = hasTrace ? raw.trace : normalizeHarnessDump(raw.dump)
  const traced = validateDynamicTrace(candidate)
  if (!traced.ok) {
    const prefix = hasTrace ? 'trace' : 'dump'
    return { ok: false, errors: traced.errors.map((e) => `${prefix}.${e}`) }
  }

  let recurse: boolean | undefined
  if (raw.recurse !== undefined) {
    if (typeof raw.recurse !== 'boolean') {
      return { ok: false, errors: ['recurse must be a boolean'] }
    }
    recurse = raw.recurse
  }

  let maxRecords: number | undefined
  if (raw.maxRecords !== undefined) {
    if (
      typeof raw.maxRecords !== 'number' ||
      !Number.isFinite(raw.maxRecords) ||
      raw.maxRecords <= 0
    ) {
      return { ok: false, errors: ['maxRecords must be a positive finite number'] }
    }
    maxRecords = Math.floor(raw.maxRecords)
  }

  let maxOutputBytes: number | undefined
  if (raw.maxOutputBytes !== undefined) {
    if (
      typeof raw.maxOutputBytes !== 'number' ||
      !Number.isFinite(raw.maxOutputBytes) ||
      raw.maxOutputBytes <= 0
    ) {
      return { ok: false, errors: ['maxOutputBytes must be a positive finite number'] }
    }
    maxOutputBytes = Math.floor(raw.maxOutputBytes)
  }

  const kinds = readEnumArray<DynamicHookKind>(
    raw.kinds,
    DYNAMIC_HOOK_KINDS as readonly string[]
  )
  if (kinds === null) return { ok: false, errors: ['kinds contains an unknown hook kind'] }

  const classes = readEnumArray<DynamicRecordClass>(
    raw.classes,
    DYNAMIC_RECORD_CLASSES as readonly string[]
  )
  if (classes === null) return { ok: false, errors: ['classes contains an unknown record class'] }

  let minLength: number | undefined
  if (raw.minLength !== undefined) {
    if (
      typeof raw.minLength !== 'number' ||
      !Number.isFinite(raw.minLength) ||
      raw.minLength < 0
    ) {
      return { ok: false, errors: ['minLength must be a non-negative finite number'] }
    }
    minLength = Math.floor(raw.minLength)
  }

  let maxDepth: number | undefined
  if (raw.maxDepth !== undefined) {
    if (
      typeof raw.maxDepth !== 'number' ||
      !Number.isFinite(raw.maxDepth) ||
      raw.maxDepth < 1
    ) {
      return { ok: false, errors: ['maxDepth must be a positive finite number'] }
    }
    maxDepth = Math.floor(raw.maxDepth)
  }

  return {
    ok: true,
    value: {
      trace: traced.value,
      recurse,
      maxRecords,
      maxOutputBytes,
      kinds,
      classes,
      minLength,
      maxDepth
    }
  }
}

/** Reads an optional array of enum-ish strings; returns null on any invalid entry. */
function readEnumArray<T extends string>(
  value: unknown,
  allowed: readonly string[]
): T[] | undefined | null {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return null
  const out: T[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !allowed.includes(entry)) return null
    out.push(entry as T)
  }
  return out
}

// ---------------------------------------------------------------------------
// Payload selection / classification
// ---------------------------------------------------------------------------

/** Reconstruct a string from a char-code list without touching the page. */
function codesToString(kind: DynamicHookKind, codes: number[]): string {
  const bounded = codes.slice(0, 4096).map((n) => Math.trunc(n) & 0xffff)
  let out = ''
  try {
    if (kind === 'String.fromCodePoint') {
      for (const code of bounded) {
        try {
          out += String.fromCodePoint(code)
        } catch {
          out += '\ufffd'
        }
      }
      return out
    }
    for (let i = 0; i < bounded.length; i += 4096) {
      out += String.fromCharCode.apply(null, bounded.slice(i, i + 4096))
    }
  } catch {
    // fall through with whatever was decoded
  }
  return out
}

function pickPayload(record: DynamicTraceRecord, cls: DynamicRecordClass): string {
  if (cls !== 'decode') return record.code ?? ''
  if (record.result !== undefined && record.result !== '') return record.result
  if (record.input !== undefined) return record.input
  if (record.codes && record.codes.length > 0) {
    return codesToString(record.kind, record.codes)
  }
  return ''
}

function looksLikeJavaScript(text: string): boolean {
  if (text.length < 8) return false
  return /function\s*\(|=>|\beval\s*\(|\bvar\s+[$A-Za-z_]|\breturn\b|document\.|window\./.test(
    text
  )
}

// ---------------------------------------------------------------------------
// Indicator extraction
// ---------------------------------------------------------------------------

type Indicators = { urls: string[]; domains: string[]; stringLiterals: string[] }

function extractIndicators(text: string): Indicators {
  const urls: string[] = []
  URL_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = URL_RE.exec(text)) !== null && urls.length < MAX_INDICATORS) {
    urls.push(match[0])
  }

  const domains: string[] = []
  for (const url of urls) {
    try {
      const host = new URL(url).hostname
      if (host && !domains.includes(host)) domains.push(host)
    } catch {
      // ignore malformed URLs
    }
  }

  const stringLiterals: string[] = []
  LITERAL_RE.lastIndex = 0
  while (
    (match = LITERAL_RE.exec(text)) !== null &&
    stringLiterals.length < MAX_INDICATORS
  ) {
    const literal = match[1] ?? match[2] ?? match[3]
    if (literal && !stringLiterals.includes(literal)) stringLiterals.push(literal)
  }

  return { urls, domains, stringLiterals }
}

// ---------------------------------------------------------------------------
// Handler (pure compute)
// ---------------------------------------------------------------------------

function deobfuscate(input: DeobfuscateDynamicInput): DeobfuscateDynamicOutput {
  const recurse = input.recurse ?? true
  const maxRecords = input.maxRecords ?? DEFAULT_MAX_RECORDS
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const minLength = input.minLength ?? 1
  const maxDepth = Math.min(input.maxDepth ?? DEFAULT_MAX_DEPTH, MAX_DEPTH_LIMIT)
  const kindFilter = input.kinds ? new Set(input.kinds) : null
  const classFilter = input.classes ? new Set(input.classes) : null

  const notes: string[] = [...(input.trace.notes ?? [])]
  const byKind: Record<string, number> = {}
  for (const record of input.trace.records) {
    byKind[record.kind] = (byKind[record.kind] ?? 0) + 1
  }

  if (kindFilter) notes.push(`filtered to kinds: ${[...kindFilter].sort().join(', ')}`)
  if (classFilter) notes.push(`filtered to classes: ${[...classFilter].sort().join(', ')}`)
  if (minLength > 1) notes.push(`minimum payload length: ${minLength}`)

  const urls = new Set<string>()
  const domains = new Set<string>()
  const stringLiterals = new Set<string>()

  if (input.trace.records.length === 0) {
    return {
      status: 'error',
      recordCount: 0,
      byKind,
      findings: [],
      indicators: { urls: [], domains: [], stringLiterals: [] },
      notes: [...notes, 'trace has no records']
    }
  }

  const findings: DynamicFinding[] = []
  const seen = new Set<string>()
  let outputBudget = maxOutputBytes
  let cappedRecords = false
  let cappedBytes = false
  let truncatedAny = false
  let filteredOut = 0

  for (const record of input.trace.records) {
    if (findings.length >= maxRecords) {
      cappedRecords = true
      break
    }
    if (kindFilter && !kindFilter.has(record.kind)) {
      filteredOut += 1
      continue
    }

    const cls = classifyRecord(record)
    if (classFilter && !classFilter.has(cls)) {
      filteredOut += 1
      continue
    }

    const payload = pickPayload(record, cls)
    if (payload.length < minLength) {
      filteredOut += 1
      continue
    }

    const key = `${record.kind}\u0000${payload}`
    if (seen.has(key)) continue
    seen.add(key)

    const truncated =
      record.truncated === true || payload.endsWith(TRUNCATION_MARK)
    if (truncated) truncatedAny = true

    const found = extractIndicators(payload)
    for (const url of found.urls) urls.add(url)
    for (const domain of found.domains) domains.add(domain)
    for (const literal of found.stringLiterals) stringLiterals.add(literal)

    let staticResult: DynamicFinding['static']
    if (recurse && (cls !== 'decode' || looksLikeJavaScript(payload))) {
      let current = payload
      let depth = 0
      let last: DeobfuscateStaticOutput | undefined
      while (depth < maxDepth) {
        if (outputBudget <= 0) {
          cappedBytes = true
          break
        }
        const result = deobfuscateStaticTool.handler({
          source: current,
          maxOutputBytes: Math.max(1, outputBudget)
        })
        outputBudget -= Buffer.byteLength(result.transformed, 'utf8')
        if (result.truncated) truncatedAny = true
        depth += 1
        last = result
        for (const url of result.indicators.urls) urls.add(url)
        for (const domain of result.indicators.domains) domains.add(domain)
        for (const literal of result.indicators.stringLiterals) stringLiterals.add(literal)

        // Stop once a pass stops changing the source: further passes are a no-op.
        const progressed =
          result.status !== 'error' &&
          result.transformed !== current &&
          result.passes.some((pass) => pass.changed)
        if (!progressed) break
        current = result.transformed
      }
      if (last) {
        staticResult = {
          status: last.status,
          family: last.family.name,
          transformed: last.transformed,
          truncated: last.truncated,
          depth,
          indicators: last.indicators
        }
      }
    }

    findings.push({
      index: findings.length,
      t: record.t,
      kind: record.kind,
      class: cls,
      payload,
      truncated,
      ...(record.phase !== undefined ? { phase: record.phase } : {}),
      ...(record.sourceUrl !== undefined ? { sourceUrl: record.sourceUrl } : {}),
      ...(record.stack !== undefined ? { stack: record.stack } : {}),
      ...(staticResult ? { static: staticResult } : {}),
      indicators: { urls: found.urls, domains: found.domains }
    })
  }

  if (cappedRecords) {
    notes.push(`analysis capped at maxRecords=${maxRecords}; further records skipped`)
  }
  if (cappedBytes) {
    notes.push(`deobfuscated output capped at maxOutputBytes=${maxOutputBytes}`)
  }
  if (filteredOut > 0) {
    notes.push(`filtered out ${filteredOut} record(s)`)
  }

  return {
    status: cappedRecords || cappedBytes || truncatedAny ? 'partial' : 'ok',
    recordCount: input.trace.records.length,
    byKind,
    findings,
    indicators: {
      urls: [...urls].slice(0, MAX_INDICATORS),
      domains: [...domains].slice(0, MAX_INDICATORS),
      stringLiterals: [...stringLiterals].slice(0, MAX_INDICATORS)
    },
    notes
  }
}

export const deobfuscateDynamicTool: CapabilityTool<
  DeobfuscateDynamicInput,
  DeobfuscateDynamicOutput
> = {
  name: 'deobfuscate_dynamic',
  description:
    'Analyze a captured runtime hook trace (eval/Function/document.write/timers/decoders) from an obfuscated page, deobfuscating each code-bearing payload with the static engine and extracting indicators. Pure string analysis; never executes trace content.',
  riskTier: 'processing',
  validateInput: validate,
  handler: deobfuscate
}
