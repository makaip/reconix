// deobfuscate_trace — shared schema for the dynamic deobfuscation trace (P3).
//
// This module is the seam between the CDP dynamic-instrumentation layer (Dev 3)
// and the pure-compute deobfuscation tools (Dev 1). It owns:
//   * the normalized shape of a runtime hook trace (`DynamicTrace`),
//   * a hostile-input validator (`validateDynamicTrace`), and
//   * a normalizer that turns the in-page harness's raw JSON dump
//     (`.opencode/tools/deobfuscate_harness.js`) into that shape
//     (`normalizeHarnessDump`).
//
// It has NO runtime dependencies (only the shared ValidationResult type) so the
// CDP layer can import it without pulling in the AST engine, and so it stays
// trivially unit-testable.

import type { ValidationResult } from '../shared/tools'

/** Bump when the normalized record shape changes in an incompatible way. */
export const TRACE_SCHEMA_VERSION = 1

/** Every hook the harness can install, plus a catch-all for forward-compat. */
export const DYNAMIC_HOOK_KINDS = [
  'eval',
  'function',
  'document.write',
  'document.writeln',
  'setTimeout',
  'setInterval',
  'atob',
  'btoa',
  'unescape',
  'escape',
  'decodeURIComponent',
  'encodeURIComponent',
  'String.fromCharCode',
  'String.fromCodePoint',
  'custom'
] as const

export type DynamicHookKind = (typeof DYNAMIC_HOOK_KINDS)[number]

const HOOK_KIND_SET = new Set<string>(DYNAMIC_HOOK_KINDS)

/** Where a record was captured. `pre-document` is only reachable via Dev 3. */
export type DynamicTracePhase = 'pre-document' | 'post-load' | 'unknown'

const TRACE_PHASES = new Set<string>(['pre-document', 'post-load', 'unknown'])

export type DynamicTraceRecord = {
  /** Page clock reading. Attacker-controlled; treat as an opaque ordinal. */
  t: number
  kind: DynamicHookKind
  /** Generated code: eval arg, Function body, timer handler, document.write html. */
  code?: string
  /** Codec input (e.g. base64 handed to `atob`). */
  input?: string
  /** char-code arg list for `String.fromCharCode`/`String.fromCodePoint`. */
  codes?: number[]
  /** What the hook produced (decoded string, eval result summary, ...). */
  result?: string
  delay?: number
  phase?: DynamicTracePhase
  sourceUrl?: string
  /** Trimmed call-site frames captured at record time (best-effort). */
  stack?: string
  truncated?: boolean
}

export type DynamicTrace = {
  schemaVersion: number
  targetId?: string
  pageUrl?: string
  installedAt?: number
  dumpedAt?: number
  caps?: { maxEntries: number; maxStringBytes: number }
  records: DynamicTraceRecord[]
  /** Non-fatal normalizer/validator observations (e.g. unknown hook kinds). */
  notes?: string[]
}

/** Coarse grouping used to decide how a record is analyzed. */
export const DYNAMIC_RECORD_CLASSES = [
  'eval',
  'function-body',
  'document-write',
  'deferred-code',
  'decode'
] as const

export type DynamicRecordClass = (typeof DYNAMIC_RECORD_CLASSES)[number]

const MAX_RECORDS = 5000
const MAX_STRING_LENGTH = 8192
const MAX_CODES = 4096
const MAX_NOTES = 200
const TRUNCATION_MARK = '\u2026'

export function classifyRecord(record: DynamicTraceRecord): DynamicRecordClass {
  switch (record.kind) {
    case 'eval':
      return 'eval'
    case 'function':
      return 'function-body'
    case 'document.write':
    case 'document.writeln':
      return 'document-write'
    case 'setTimeout':
    case 'setInterval':
      return 'deferred-code'
    default:
      return 'decode'
  }
}

// ---------------------------------------------------------------------------
// Validation (input is hostile, §5.C rule 2)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(
  value: unknown,
  label: string,
  errors: string[]
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    errors.push(`${label} must be a string`)
    return undefined
  }
  if (value.length > MAX_STRING_LENGTH) {
    errors.push(`${label} must be <= ${MAX_STRING_LENGTH} chars`)
    return undefined
  }
  return value
}

function optionalNumber(
  value: unknown,
  label: string,
  errors: string[]
): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${label} must be a finite number`)
    return undefined
  }
  return value
}

function optionalCodes(
  value: unknown,
  label: string,
  errors: string[]
): number[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array of numbers`)
    return undefined
  }
  if (value.length > MAX_CODES) {
    errors.push(`${label} must be <= ${MAX_CODES} entries`)
    return undefined
  }
  const out: number[] = []
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      errors.push(`${label} entries must be finite numbers`)
      return undefined
    }
    out.push(entry)
  }
  return out
}

/**
 * Strict, no-coercion validation of a normalized trace. Rejects unknown schema
 * versions, unknown hook kinds, out-of-range arrays, and non-object records.
 */
export function validateDynamicTrace(raw: unknown): ValidationResult<DynamicTrace> {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['trace must be an object'] }
  }
  if (raw.schemaVersion !== TRACE_SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [`unsupported trace schemaVersion (expected ${TRACE_SCHEMA_VERSION})`]
    }
  }
  if (!Array.isArray(raw.records)) {
    return { ok: false, errors: ['trace.records must be an array'] }
  }
  if (raw.records.length > MAX_RECORDS) {
    return { ok: false, errors: [`trace.records must be <= ${MAX_RECORDS} entries`] }
  }

  const errors: string[] = []
  const records: DynamicTraceRecord[] = []

  for (let i = 0; i < raw.records.length; i++) {
    const record = raw.records[i]
    if (!isPlainObject(record)) {
      errors.push(`records[${i}] must be an object`)
      continue
    }
    if (typeof record.t !== 'number' || !Number.isFinite(record.t)) {
      errors.push(`records[${i}].t must be a finite number`)
      continue
    }
    if (typeof record.kind !== 'string' || !HOOK_KIND_SET.has(record.kind)) {
      errors.push(`records[${i}].kind unknown: ${String(record.kind)}`)
      continue
    }

    const kind = record.kind as DynamicHookKind
    const code = optionalString(record.code, `records[${i}].code`, errors)
    const input = optionalString(record.input, `records[${i}].input`, errors)
    const result = optionalString(record.result, `records[${i}].result`, errors)
    const sourceUrl = optionalString(record.sourceUrl, `records[${i}].sourceUrl`, errors)
    const stack = optionalString(record.stack, `records[${i}].stack`, errors)
    const codes = optionalCodes(record.codes, `records[${i}].codes`, errors)
    const delay = optionalNumber(record.delay, `records[${i}].delay`, errors)

    let phase: DynamicTracePhase | undefined
    if (record.phase !== undefined) {
      if (typeof record.phase !== 'string' || !TRACE_PHASES.has(record.phase)) {
        errors.push(`records[${i}].phase unknown: ${String(record.phase)}`)
        continue
      }
      phase = record.phase as DynamicTracePhase
    }

    if (
      record.truncated !== undefined &&
      typeof record.truncated !== 'boolean'
    ) {
      errors.push(`records[${i}].truncated must be a boolean`)
      continue
    }

    records.push({
      t: record.t,
      kind,
      ...(code !== undefined ? { code } : {}),
      ...(input !== undefined ? { input } : {}),
      ...(codes !== undefined ? { codes } : {}),
      ...(result !== undefined ? { result } : {}),
      ...(delay !== undefined ? { delay } : {}),
      ...(phase !== undefined ? { phase } : {}),
      ...(sourceUrl !== undefined ? { sourceUrl } : {}),
      ...(stack !== undefined ? { stack } : {}),
      ...(record.truncated === true ? { truncated: true } : {})
    })
  }

  if (errors.length > 0) return { ok: false, errors }

  const notes = validateNotes(raw.notes, errors)
  if (errors.length > 0) return { ok: false, errors }

  const caps =
    raw.caps === undefined ? undefined : validateCaps(raw.caps, errors)
  if (errors.length > 0) return { ok: false, errors }

  const trace: DynamicTrace = {
    schemaVersion: TRACE_SCHEMA_VERSION,
    records,
    ...(optionalString(raw.targetId, 'targetId', errors) !== undefined
      ? { targetId: raw.targetId as string }
      : {}),
    ...(optionalString(raw.pageUrl, 'pageUrl', errors) !== undefined
      ? { pageUrl: raw.pageUrl as string }
      : {}),
    ...(optionalNumber(raw.installedAt, 'installedAt', errors) !== undefined
      ? { installedAt: raw.installedAt as number }
      : {}),
    ...(optionalNumber(raw.dumpedAt, 'dumpedAt', errors) !== undefined
      ? { dumpedAt: raw.dumpedAt as number }
      : {}),
    ...(caps !== undefined ? { caps } : {}),
    ...(notes !== undefined ? { notes } : {})
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: trace }
}

function validateNotes(value: unknown, errors: string[]): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    errors.push('notes must be an array of strings')
    return undefined
  }
  if (value.length > MAX_NOTES) {
    errors.push(`notes must be <= ${MAX_NOTES} entries`)
    return undefined
  }
  const out: string[] = []
  for (const note of value) {
    if (typeof note !== 'string') {
      errors.push('notes entries must be strings')
      return undefined
    }
    out.push(note.length > MAX_STRING_LENGTH ? note.slice(0, MAX_STRING_LENGTH) : note)
  }
  return out
}

function validateCaps(
  value: unknown,
  errors: string[]
): { maxEntries: number; maxStringBytes: number } | undefined {
  if (!isPlainObject(value)) {
    errors.push('caps must be an object')
    return undefined
  }
  if (
    typeof value.maxEntries !== 'number' ||
    !Number.isFinite(value.maxEntries) ||
    typeof value.maxStringBytes !== 'number' ||
    !Number.isFinite(value.maxStringBytes)
  ) {
    errors.push('caps.maxEntries and caps.maxStringBytes must be finite numbers')
    return undefined
  }
  return { maxEntries: value.maxEntries, maxStringBytes: value.maxStringBytes }
}

// ---------------------------------------------------------------------------
// Harness normalizer
// ---------------------------------------------------------------------------

function normalizeKind(value: unknown, notes: string[]): DynamicHookKind {
  if (typeof value === 'string' && HOOK_KIND_SET.has(value)) {
    return value as DynamicHookKind
  }
  notes.push(`unknown hook kind mapped to 'custom': ${String(value)}`)
  return 'custom'
}

function isCharCodeKind(kind: DynamicHookKind): boolean {
  return kind === 'String.fromCharCode' || kind === 'String.fromCodePoint'
}

function normalizeRecord(
  raw: unknown,
  index: number,
  notes: string[],
  defaultPhase?: DynamicTracePhase
): DynamicTraceRecord | null {
  if (!isPlainObject(raw)) {
    notes.push(`entry[${index}] is not an object; skipped`)
    return null
  }
  const kind = normalizeKind(raw.kind, notes)
  const t = typeof raw.t === 'number' && Number.isFinite(raw.t) ? raw.t : 0
  const record: DynamicTraceRecord = { t, kind }

  let truncated = raw.truncated === true

  const takeString = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined
    if (value.endsWith(TRUNCATION_MARK)) truncated = true
    return value
  }

  // Code-bodied hooks: eval/function use `code`/`body`; document.write uses `html`.
  const code =
    takeString(raw.code) ?? takeString(raw.body) ?? takeString(raw.html)
  if (code !== undefined) record.code = code

  const input = takeString(raw.input)
  const result = takeString(raw.result)
  if (result !== undefined) record.result = result

  if (isCharCodeKind(kind)) {
    // The harness records the numeric arg list as `codes` (older dumps used `input`).
    const rawCodes = Array.isArray(raw.codes)
      ? raw.codes
      : Array.isArray(raw.input)
        ? raw.input
        : null
    if (rawCodes) {
      const codes = rawCodes.filter(
        (n): n is number => typeof n === 'number' && Number.isFinite(n)
      )
      if (codes.length > 0) record.codes = codes
    } else if (input !== undefined) {
      record.input = input
    }
  } else if (input !== undefined) {
    record.input = input
  }

  if (typeof raw.delay === 'number' && Number.isFinite(raw.delay)) {
    record.delay = raw.delay
  }
  if (typeof raw.phase === 'string' && TRACE_PHASES.has(raw.phase)) {
    record.phase = raw.phase as DynamicTracePhase
  } else if (defaultPhase !== undefined) {
    record.phase = defaultPhase
  }
  if (typeof raw.sourceUrl === 'string') {
    record.sourceUrl = raw.sourceUrl
  }
  const stack = takeString(raw.stack)
  if (stack !== undefined) record.stack = stack
  if (truncated) record.truncated = true

  return record
}

/**
 * Turn the in-page harness's raw JSON dump into a normalized `DynamicTrace`.
 * Accepts either the already-parsed object or the raw JSON string the harness
 * returned. Never throws: malformed shape yields an empty trace plus notes.
 */
export function normalizeHarnessDump(raw: unknown): DynamicTrace {
  const notes: string[] = []
  let parsed: unknown = raw

  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
  }

  if (!isPlainObject(parsed)) {
    return { schemaVersion: TRACE_SCHEMA_VERSION, records: [], notes: ['dump is not an object'] }
  }

  // Already-normalized traces pass through unchanged.
  if (Array.isArray(parsed.records) && parsed.schemaVersion === TRACE_SCHEMA_VERSION) {
    return parsed as unknown as DynamicTrace
  }

  const entries = parsed.entries
  if (entries !== undefined && !Array.isArray(entries)) {
    notes.push('dump.entries is not an array; treated as empty')
  }

  const defaultPhase =
    typeof parsed.phase === 'string' && TRACE_PHASES.has(parsed.phase)
      ? (parsed.phase as DynamicTracePhase)
      : undefined
  if (typeof parsed.dropped === 'number' && parsed.dropped > 0) {
    notes.push(`harness dropped ${parsed.dropped} records at its entry cap`)
  }

  const records: DynamicTraceRecord[] = []
  if (Array.isArray(entries)) {
    for (let i = 0; i < entries.length; i++) {
      const record = normalizeRecord(entries[i], i, notes, defaultPhase)
      if (record) records.push(record)
    }
  } else if (parsed.status === 'installed') {
    notes.push('dump is an install acknowledgement; no records')
  }

  const trace: DynamicTrace = {
    schemaVersion: TRACE_SCHEMA_VERSION,
    records,
    ...(typeof parsed.pageUrl === 'string' ? { pageUrl: parsed.pageUrl } : {}),
    ...(typeof parsed.targetId === 'string' ? { targetId: parsed.targetId } : {}),
    ...(typeof parsed.installedAt === 'number' ? { installedAt: parsed.installedAt } : {}),
    ...(typeof parsed.dumpedAt === 'number' ? { dumpedAt: parsed.dumpedAt } : {}),
    ...(notes.length > 0 ? { notes } : {})
  }
  return trace
}
