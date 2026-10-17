// break_regex — ARCHITECTURE.MD §5.E / Dev 1 task 8.
//
// Static analysis only. This tool NEVER executes the untrusted pattern as a
// RegExp against any candidate string — that is exactly the hang vector
// ReDoS exploits. It only:
//   1) parses the pattern as a flat character stream to spot catastrophic
//      structures (nested/adjacent quantified groups, overlapping
//      alternations) using bounded string scanning — O(len(pattern)), and
//   2) constructs candidate attack strings by simple repetition/concatenation
//      (also bounded, capped length) as DATA to return to the caller.
// If the caller later runs these candidates against the pattern themselves,
// that is their choice and happens outside this tool, outside this process
// boundary's responsibility, and is not something this tool ever does.

import type {
  BreakRegexInput,
  BreakRegexOutput,
  CapabilityTool,
  RedosCandidate,
  ValidationResult
} from '../shared/tools'

/** Hard cap on pattern length we will even look at — bounds every scan below. */
const MAX_PATTERN_LENGTH = 2000

/** Hard cap on how long a generated candidate string may be. */
const MAX_CANDIDATE_REPEAT = 50000

function validate(raw: unknown): ValidationResult<BreakRegexInput> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['input must be an object'] }
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.pattern !== 'string') {
    return { ok: false, errors: ['pattern must be a string'] }
  }
  if (obj.pattern.length === 0) {
    return { ok: false, errors: ['pattern must not be empty'] }
  }
  if (obj.pattern.length > MAX_PATTERN_LENGTH) {
    return { ok: false, errors: [`pattern must be <= ${MAX_PATTERN_LENGTH} chars`] }
  }
  return { ok: true, value: { pattern: obj.pattern } }
}

type Finding = {
  matchedStructure: string
  reason: string
  /** The repeated character/class this structure quantifies, used to build a candidate. */
  repeatUnit: string
}

/**
 * Finds `(X+)+`, `(X*)*`, `(X+)*`, `(X*)+`-shaped nested quantifiers — the
 * canonical catastrophic-backtracking shape — via plain substring scanning.
 * No RegExp engine is run against `pattern`; we walk it character by
 * character ourselves, bounded by MAX_PATTERN_LENGTH.
 */
function findNestedQuantifiers(pattern: string): Finding[] {
  const findings: Finding[] = []
  const n = pattern.length

  for (let i = 0; i < n; i++) {
    if (pattern[i] !== '(') continue

    // Find this group's matching close paren by simple depth counting
    // (bounded by remaining pattern length — no backtracking, no catch-up).
    let depth = 1
    let j = i + 1
    while (j < n && depth > 0) {
      if (pattern[j] === '\\') {
        j += 2
        continue
      }
      if (pattern[j] === '(') depth++
      else if (pattern[j] === ')') depth--
      j++
    }
    if (depth !== 0) continue // unbalanced; skip rather than guess
    const closeIdx = j - 1
    const inner = pattern.slice(i + 1, closeIdx)

    // Does the inner group itself end in a quantified atom (X+ or X*)?
    const innerQuantified = /[+*]$/.test(inner)
    if (!innerQuantified) continue

    // Is the group itself quantified (X+)+/(X*)* etc, or unbounded {n,}?
    const after = pattern.slice(closeIdx + 1)
    const groupQuantMatch = after.match(/^[+*]|^\{\d+,\}/)
    if (!groupQuantMatch) continue

    const matchedStructure = pattern.slice(i, closeIdx + 1 + groupQuantMatch[0].length)

    // Pick a plausible repeat unit for the candidate string: strip the
    // trailing quantifier off inner, take the last atom (char or class).
    const innerBody = inner.replace(/[+*]$/, '')
    const classMatch = innerBody.match(/\[[^\]]*\]$/)
    const repeatUnit = classMatch ? 'a' : innerBody.slice(-1) || 'a'

    findings.push({
      matchedStructure,
      reason: 'nested quantifier (group with internal +/* that is itself quantified) — classic catastrophic backtracking shape',
      repeatUnit
    })
  }

  return findings
}

/**
 * Finds alternations with overlapping branches inside a quantified group,
 * e.g. `(a|a)+`, `(a|ab)+` — another catastrophic shape. Bounded substring
 * scan only.
 */
function findOverlappingAlternation(pattern: string): Finding[] {
  const findings: Finding[] = []
  const groupRe = /\(([^()]*\|[^()]*)\)([+*]|\{\d+,\})/g
  let match: RegExpExecArray | null
  // groupRe runs against the PATTERN TEXT only, to find alternation syntax,
  // never against candidate input, and only ever advances forward (global
  // flag with lastIndex monotonically increasing) — no catastrophic case
  // is reachable because the regex used here contains no nested/adjacent
  // quantifiers itself.
  while ((match = groupRe.exec(pattern)) !== null) {
    const branches = match[1].split('|')
    const overlaps =
      branches.length !== new Set(branches).size ||
      branches.some((b, idx) => branches.some((b2, idx2) => idx !== idx2 && b2.startsWith(b)))
    if (overlaps) {
      findings.push({
        matchedStructure: match[0],
        reason: 'quantified alternation with overlapping branches — ambiguous matches multiply backtracking',
        repeatUnit: branches[0] || 'a'
      })
    }
  }
  return findings
}

function buildCandidate(repeatUnit: string): string {
  // A simple non-matching tail forces the engine to exhaust backtracking
  // before failing — the standard ReDoS probe shape. Length is capped.
  const safeUnit = repeatUnit.length === 1 ? repeatUnit : 'a'
  return safeUnit.repeat(MAX_CANDIDATE_REPEAT) + '!'
}

function analyze(input: BreakRegexInput): BreakRegexOutput {
  const findings = [
    ...findNestedQuantifiers(input.pattern),
    ...findOverlappingAlternation(input.pattern)
  ]

  const redosCandidates: RedosCandidate[] = findings.map((f) => ({
    candidate: buildCandidate(f.repeatUnit),
    reason: f.reason,
    matchedStructure: f.matchedStructure
  }))

  return {
    vulnerable: redosCandidates.length > 0,
    redosCandidates
  }
}

export const breakRegexTool: CapabilityTool<BreakRegexInput, BreakRegexOutput> = {
  name: 'break_regex',
  description:
    'Statically analyzes a regex pattern string for catastrophic-backtracking (ReDoS) structures and emits candidate attack strings. Never executes the pattern itself.',
  riskTier: 'read-only',
  validateInput: validate,
  handler: analyze
}
