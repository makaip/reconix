// diff_responses — ARCHITECTURE.MD §5.E / Dev 1 task 9.
//
// Pure-compute analyzer: diffs two response-like objects the agent already
// fetched via Dev 3's tools. Status/length/timing diff plus a line-level
// body diff summary. No network, no re-fetching — the bodies are inputs.

import type {
  CapabilityTool,
  DiffResponsesInput,
  DiffResponsesOutput,
  LineDiffEntry,
  ResponseLike,
  ValidationResult
} from '../shared/tools'

const MAX_BODY_LENGTH = 5_000_000 // 5MB of text is already generous for a diff

function isResponseLike(v: unknown): v is ResponseLike {
  if (typeof v !== 'object' || v === null) return false
  const obj = v as Record<string, unknown>
  if (typeof obj.status !== 'number' || !Number.isFinite(obj.status)) return false
  if (obj.status < 0 || obj.status > 999) return false
  if (typeof obj.body !== 'string') return false
  if (obj.body.length > MAX_BODY_LENGTH) return false
  if (obj.timingMs !== undefined && typeof obj.timingMs !== 'number') return false
  if (obj.headers !== undefined) {
    if (typeof obj.headers !== 'object' || obj.headers === null) return false
    for (const val of Object.values(obj.headers as Record<string, unknown>)) {
      if (typeof val !== 'string') return false
    }
  }
  return true
}

function validate(raw: unknown): ValidationResult<DiffResponsesInput> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['input must be an object'] }
  }
  const obj = raw as Record<string, unknown>
  const errors: string[] = []
  if (!isResponseLike(obj.a)) errors.push('a must be a valid response-like object')
  if (!isResponseLike(obj.b)) errors.push('b must be a valid response-like object')
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { a: obj.a as ResponseLike, b: obj.b as ResponseLike } }
}

/** Simple LCS-based line diff. Bounded by input size validation above. */
function lineDiff(bodyA: string, bodyB: string): LineDiffEntry[] {
  const linesA = bodyA.split('\n')
  const linesB = bodyB.split('\n')
  const n = linesA.length
  const m = linesB.length

  // LCS table — guard against pathological sizes to stay pure-compute-cheap.
  const CAP = 2000
  if (n > CAP || m > CAP) {
    // Fall back to a coarse summary diff rather than an O(n*m) table.
    const entries: LineDiffEntry[] = []
    const maxLen = Math.max(n, m)
    for (let i = 0; i < maxLen; i++) {
      const a = linesA[i]
      const b = linesB[i]
      if (a === b && a !== undefined) {
        entries.push({ kind: 'unchanged', line: a })
      } else {
        if (a !== undefined) entries.push({ kind: 'removed', line: a })
        if (b !== undefined) entries.push({ kind: 'added', line: b })
      }
    }
    return entries
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        linesA[i] === linesB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const entries: LineDiffEntry[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (linesA[i] === linesB[j]) {
      entries.push({ kind: 'unchanged', line: linesA[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      entries.push({ kind: 'removed', line: linesA[i] })
      i++
    } else {
      entries.push({ kind: 'added', line: linesB[j] })
      j++
    }
  }
  while (i < n) {
    entries.push({ kind: 'removed', line: linesA[i] })
    i++
  }
  while (j < m) {
    entries.push({ kind: 'added', line: linesB[j] })
    j++
  }
  return entries
}

function diff(input: DiffResponsesInput): DiffResponsesOutput {
  const { a, b } = input
  const diffEntries = lineDiff(a.body, b.body)
  const changedLineCount = diffEntries.filter((e) => e.kind !== 'unchanged').length

  return {
    statusChanged: a.status !== b.status,
    statusA: a.status,
    statusB: b.status,
    lengthA: a.body.length,
    lengthB: b.body.length,
    lengthDelta: b.body.length - a.body.length,
    timingDeltaMs:
      a.timingMs !== undefined && b.timingMs !== undefined ? b.timingMs - a.timingMs : null,
    bodyIdentical: a.body === b.body,
    lineDiff: diffEntries,
    changedLineCount
  }
}

export const diffResponsesTool: CapabilityTool<DiffResponsesInput, DiffResponsesOutput> = {
  name: 'diff_responses',
  description:
    'Diffs two already-fetched response-like objects: status/length/timing deltas plus a line-level body diff summary. Pure compute.',
  riskTier: 'read-only',
  validateInput: validate,
  handler: diff
}
