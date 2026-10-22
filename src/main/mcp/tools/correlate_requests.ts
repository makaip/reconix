// Moat tool: cross-request correlation (tier R).
//
// Given a captured request and a set of other captured requests, report the
// relationships a human pentester spots by eyeballing the traffic log:
//   - reflection : a parameter value from the base request shows up verbatim in
//                  another request (URL or header) — the pivot for XSS/SSRF/
//                  header-injection chains;
//   - token-leak : an auth credential from the base request is carried by a
//                  request that should not have it (different origin, or a
//                  header the token does not belong in);
//   - idor       : both URLs address the same path shape with neighbouring
//                  numeric ids (user/5 vs user/6).
//
// It is READ-ONLY analysis of already-captured data — it never sends a request.
// The output is a ranked list of hypotheses for the agent to confirm with
// replay_request, not a set of confirmed findings. That is why target()
// returns nothing: there is no new egress, so there is nothing to scope-check.
import { defineTool, type Tool } from '../tool'
import { ToolInputError } from '../errors'
import { clampString } from '../limits'
import { str, strArray } from '../validate'
import type { CapturedRequest } from '../../../shared/tabs'

export const IMPACT_TYPES = ['reflection', 'token-leak', 'idor'] as const
export type ImpactType = (typeof IMPACT_TYPES)[number]

const PARAMETER_MAX_CHARS = 128
const MAX_CANDIDATES = 50
/** Cap on returned correlations. 50 candidates x 3 checks can produce enough
 *  rows to blow the per-result context budget, and a pile of 100+ hypotheses is
 *  not actionable anyway. The strongest ones survive; the count is reported. */
const MAX_CORRELATIONS = 30

/** Values shorter than this are too generic to correlate on ("1", "en", "GET"):
 *  they match half the traffic and bury the real signal. */
const MIN_TOKEN_CHARS = 8

/** An idor candidate: neighbouring ids in the same path slot. Larger gaps are
 *  usually unrelated resources, not the same object family. */
const IDOR_MAX_DELTA = 3

/** Header names whose value is a credential. Covers the standard auth headers
 *  plus the vendor/session variants that show up in real apps. */
const AUTH_HEADER_RE = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token|x-access-token|x-session-token|x-csrf-token|x-xsrf-token|x-amz-security-token)$/i
const AUTH_HEADER_HINT_RE = /(^|[-_])(auth|token|api[-_]?key|session|cookie)([-_]|$)/i

function isAuthHeader(name: string): boolean {
  return AUTH_HEADER_RE.test(name) || AUTH_HEADER_HINT_RE.test(name)
}

export interface Correlation {
  id: string // 'corr_<n>'
  type: ImpactType
  sourceRequestId: string // base
  targetRequestId: string // candidate
  parameter: string
  confidence: number // 0-1
  description: string
  evidence: { baseValue?: string; candidateValue?: string; urls: [string, string] }
  recommendation: string
}

export interface CorrelateRequestsOutput {
  correlations: Correlation[]
  summary: { total: number; byType: Record<ImpactType, number> }
  rawRef?: string // trace ref of the raw analysis JSON
  /** Correlations dropped to stay within the context budget. */
  omitted?: number
  note?: string
}

export interface CorrelationOptions {
  parameterName: string
  /** Defaults to all three. An empty array is treated as "unspecified". */
  impactTypes?: ImpactType[]
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

function queryValues(url: string, name: string): string[] {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return []
  }
  const out: string[] = []
  for (const [key, value] of parsed.searchParams) {
    if (key === name) out.push(value)
  }
  return out
}

/** Header names are case-insensitive, so every casing of `name` is collected. */
function headerValues(headers: Record<string, string> | undefined, name: string): string[] {
  if (!headers) return []
  const lower = name.toLowerCase()
  const out: string[] = []
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && typeof value === 'string') out.push(value)
  }
  return out
}

/** The base request's values for `parameterName`, from the query string and/or
 *  its request headers (either location is valid; the agent doesn't always know
 *  which one the app uses). */
function collectParameterValues(base: CapturedRequest, name: string): string[] {
  const fromQuery = queryValues(base.url, name)
  const fromHeader = headerValues(base.requestHeaders, name)
  // De-dupe so the same value in both places is correlated once.
  return [...new Set([...fromQuery, ...fromHeader].filter((v) => v.length > 0))]
}

/** True when `value` occurs in any of the candidate's request header values. */
function findHeaderHit(
  headers: Record<string, string> | undefined,
  value: string
): { name: string; value: string } | null {
  if (!headers) return null
  for (const [name, headerValue] of Object.entries(headers)) {
    if (typeof headerValue === 'string' && headerValue.includes(value)) return { name, value: headerValue }
  }
  return null
}

function pathSegments(url: string): string[] | null {
  try {
    return new URL(url).pathname.split('/').filter((s) => s.length > 0)
  } catch {
    return null
  }
}

/** A path segment that is a plain, human-scale object id. Timestamps / hashes
 *  are excluded by the digit budget. */
function numericId(segment: string): number | null {
  if (!/^\d{1,9}$/.test(segment)) return null
  const n = Number(segment)
  return Number.isSafeInteger(n) ? n : null
}

/** Neighbouring ids in the SAME path shape (e.g. /api/users/5 vs /api/users/6).
 *  Any non-numeric segment difference means a different resource family, so the
 *  pair is rejected rather than reported as a weak guess. */
function idorPair(
  baseUrl: string,
  candidateUrl: string
): { baseId: number; candidateId: number; delta: number } | null {
  const a = pathSegments(baseUrl)
  const b = pathSegments(candidateUrl)
  if (!a || !b || a.length !== b.length) return null
  let best: { baseId: number; candidateId: number; delta: number } | null = null
  for (let i = 0; i < a.length; i++) {
    const an = numericId(a[i])
    const bn = numericId(b[i])
    if (an === null && bn === null) {
      if (a[i] !== b[i]) return null
      continue
    }
    // One side numeric, the other not → different shape.
    if (an === null || bn === null) return null
    const delta = Math.abs(an - bn)
    if (delta >= 1 && delta <= IDOR_MAX_DELTA && (!best || delta < best.delta)) {
      best = { baseId: an, candidateId: bn, delta }
    }
  }
  return best
}

function normalizeImpactTypes(raw: ImpactType[] | undefined): ImpactType[] {
  if (!raw || raw.length === 0) return [...IMPACT_TYPES]
  return [...new Set(raw)]
}

/**
 * Pure correlation engine — no ctx, no I/O, so it is unit-testable directly.
 * Returns hypotheses in a deterministic order (candidate order, then
 * reflection → token-leak → idor).
 *
 * Throws ToolInputError when `parameterName` is absent from the base request:
 * that is a malformed call, not "no correlations found".
 */
export function extractCorrelations(
  base: CapturedRequest,
  candidates: CapturedRequest[],
  opts: CorrelationOptions
): Correlation[] {
  const parameter = opts.parameterName
  const types = new Set(normalizeImpactTypes(opts.impactTypes))
  const found = collectParameterValues(base, parameter)
  if (found.length === 0) {
    throw new ToolInputError(
      `parameter "${parameter}" not found in base request ${base.id} (checked the URL query string and request headers) — ` +
        'check the spelling/casing against get_request, or correlate a different parameter'
    )
  }

  const correlations: Correlation[] = []
  const push = (c: Omit<Correlation, 'id'>): void => {
    correlations.push({ id: `corr_${correlations.length + 1}`, ...c })
  }
  const urls = (candidate: CapturedRequest): [string, string] => [base.url, candidate.url]

  for (const candidate of candidates) {
    // Correlating a request with itself is meaningless.
    if (!candidate || candidate.id === base.id) continue

    // 1. reflection — the base parameter value echoed by another request.
    if (types.has('reflection')) {
      let reported = false
      for (const value of found) {
        if (reported) break
        if (candidate.url.includes(value)) {
          push({
            type: 'reflection',
            sourceRequestId: base.id,
            targetRequestId: candidate.id,
            parameter,
            confidence: 0.8,
            description: `Parameter "${parameter}" value appears verbatim in the URL of request ${candidate.id} — the value propagates across requests (XSS/SSRF/open-redirect chain candidate).`,
            evidence: { baseValue: clampString(value), candidateValue: clampString(candidate.url), urls: urls(candidate) },
            recommendation: `Replay ${candidate.id} with the parameter value replaced by a benign marker (probe_reflection) and then an encoding-specific payload to see where it lands.`
          })
          reported = true
          break
        }
        const hit = findHeaderHit(candidate.requestHeaders, value)
        if (hit) {
          push({
            type: 'reflection',
            sourceRequestId: base.id,
            targetRequestId: candidate.id,
            parameter,
            confidence: 0.5,
            description: `Parameter "${parameter}" value appears in header "${hit.name}" of request ${candidate.id} (not in its URL).`,
            evidence: {
              baseValue: clampString(value),
              candidateValue: clampString(`${hit.name}: ${hit.value}`),
              urls: urls(candidate)
            },
            recommendation: `Replay ${candidate.id} with a canary value in "${parameter}" and confirm the canary reaches header "${hit.name}"; CR/LF-bearing payloads then test header injection.`
          })
          reported = true
          break
        }
      }
    }

    // 2. token-leak — a base credential carried by a request that shouldn't.
    if (types.has('token-leak')) {
      const baseAuth = Object.entries(base.requestHeaders ?? {}).filter(
        ([name, value]) => isAuthHeader(name) && typeof value === 'string' && value.length >= MIN_TOKEN_CHARS
      )
      let reported = false
      for (const [authName, authValue] of baseAuth) {
        if (reported) break
        for (const [candName, candValue] of Object.entries(candidate.requestHeaders ?? {})) {
          if (typeof candValue !== 'string' || !candValue.includes(authValue)) continue
          // The same credential in the same header on the same origin is just
          // normal session propagation (cookie/bearer reuse), not a leak — it
          // would otherwise flag every request on the site.
          const sameHeader = candName.toLowerCase() === authName.toLowerCase()
          if (sameHeader && sameOrigin(base.url, candidate.url)) continue
          const why = sameHeader
            ? `cross-origin: request ${candidate.id} replays the base "${authName}" credential to a different origin`
            : `request ${candidate.id} carries the base "${authName}" credential in header "${candName}"`
          push({
            type: 'token-leak',
            sourceRequestId: base.id,
            targetRequestId: candidate.id,
            parameter,
            confidence: 0.9,
            description: `Auth value from "${authName}" of request ${base.id} appears in ${why}.`,
            evidence: {
              baseValue: clampString(authValue),
              candidateValue: clampString(`${candName}: ${candValue}`),
              urls: urls(candidate)
            },
            recommendation: `Replay ${candidate.id} with "${candName}" stripped (overrides.headers: { "${candName}": null }) — if the response changes, the credential is load-bearing there; check whether that endpoint belongs to a different trust boundary.`
          })
          reported = true
          break
        }
      }
    }

    // 3. idor — neighbouring numeric ids in the same path shape.
    if (types.has('idor')) {
      const pair = idorPair(base.url, candidate.url)
      if (pair) {
        push({
          type: 'idor',
          sourceRequestId: base.id,
          targetRequestId: candidate.id,
          parameter,
          confidence: 0.6,
          description: `Sequential object ids in the path: base uses ${pair.baseId}, request ${candidate.id} uses ${pair.candidateId} (delta ${pair.delta}).`,
          evidence: {
            baseValue: String(pair.baseId),
            candidateValue: String(pair.candidateId),
            urls: urls(candidate)
          },
          recommendation: `Replay the candidate URL with the base session (replay_request) and, if it returns data, cross-check with the base response — a 200 carrying another owner's object confirms IDOR.`
        })
      }
    }
  }

  return correlations
}

function parseImpactTypes(raw: unknown): ImpactType[] | undefined {
  const value = (raw as { impactTypes?: unknown })?.impactTypes
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new ToolInputError('"impactTypes" must be an array of: reflection, token-leak, idor')
  }
  if (value.length > IMPACT_TYPES.length) {
    throw new ToolInputError(`"impactTypes" accepts at most ${IMPACT_TYPES.length} entries`)
  }
  const out: ImpactType[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !(IMPACT_TYPES as readonly string[]).includes(item)) {
      throw new ToolInputError(`"impactTypes" entries must be one of: ${IMPACT_TYPES.join(', ')}`)
    }
    out.push(item as ImpactType)
  }
  return out
}

function parseCandidates(raw: unknown): string[] {
  const ids = strArray(raw, 'candidateRequestIds')
  if (ids.length === 0) {
    throw new ToolInputError('"candidateRequestIds" must contain at least 1 request id')
  }
  if (ids.length > MAX_CANDIDATES) {
    throw new ToolInputError(
      `"candidateRequestIds" has ${ids.length} ids; max ${MAX_CANDIDATES} per call — narrow the set or call twice`
    )
  }
  for (const id of ids) {
    if (id.length === 0) throw new ToolInputError('"candidateRequestIds" entries must be non-empty request ids')
  }
  return ids
}

const correlate_requests = defineTool<
  { baseRequestId: string; parameterName: string; candidateRequestIds: string[]; impactTypes?: ImpactType[] },
  CorrelateRequestsOutput
>({
  name: 'correlate_requests',
  description:
    'Cross-request correlation over ALREADY-CAPTURED traffic (no new requests are sent). Takes a base ' +
    'request plus other captured request ids and reports hypotheses: reflection (the base parameter value ' +
    'reappears in another request URL/header), token-leak (an auth credential from the base is carried ' +
    'by a request/header it does not belong in), and idor (neighbouring numeric ids in the same path ' +
    'shape). Each correlation carries id, confidence (0-1), evidence values/URLs and a recommendation. ' +
    'These are leads, not findings — confirm each one with replay_request before reporting it. ' +
    'Missing candidate ids are skipped (reported in `note`); the raw analysis JSON is saved as rawRef.',
  riskTier: 'R',
  inputSchema: {
    type: 'object',
    required: ['baseRequestId', 'parameterName', 'candidateRequestIds'],
    properties: {
      baseRequestId: {
        type: 'string',
        description: 'Captured request ID whose parameter value is tracked across other requests.'
      },
      parameterName: {
        type: 'string',
        minLength: 1,
        maxLength: PARAMETER_MAX_CHARS,
        description: 'Parameter name to correlate (URL query param or header name).'
      },
      candidateRequestIds: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: MAX_CANDIDATES,
        description: 'Captured request IDs to check for impact from the base parameter.'
      },
      impactTypes: {
        type: 'array',
        items: { type: 'string', enum: [...IMPACT_TYPES] },
        maxItems: IMPACT_TYPES.length,
        description: 'Correlation types to check (default: all three).'
      }
    },
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      correlations: { type: 'array' },
      summary: { type: 'object' },
      rawRef: { type: 'string' },
      omitted: { type: 'number' },
      note: { type: 'string' }
    }
  },
  parse: (raw) => {
    const baseRequestId = str(raw, 'baseRequestId')
    const parameterName = str(raw, 'parameterName', PARAMETER_MAX_CHARS)
    const candidateRequestIds = parseCandidates(raw)
    return { baseRequestId, parameterName, candidateRequestIds, impactTypes: parseImpactTypes(raw) }
  },
  // Definitionally no new egress: everything analyzed is already-captured data,
  // so there is no live target for the pipeline to scope-check.
  execute: async (i, ctx) => {
    const base = ctx.network.get(i.baseRequestId)
    if (!base) {
      throw new ToolInputError(
        `unknown base request "${i.baseRequestId}" — captured requests age out; list current ids with get_network_log`
      )
    }

    const candidates: CapturedRequest[] = []
    const missing: string[] = []
    for (const id of i.candidateRequestIds) {
      const candidate = ctx.network.get(id)
      if (candidate) candidates.push(candidate)
      else missing.push(id)
    }
    if (candidates.length === 0) {
      throw new ToolInputError(
        `none of the candidate request ids exist (${missing.join(', ')}) — list current ids with get_network_log`
      )
    }

    const correlations = extractCorrelations(base, candidates, {
      parameterName: i.parameterName,
      impactTypes: i.impactTypes
    })

    const byType: Record<ImpactType, number> = { reflection: 0, 'token-leak': 0, idor: 0 }
    for (const c of correlations) byType[c.type]++

    // Rank before capping so a truncated response keeps the strongest leads.
    const ranked = [...correlations].sort((a, b) => b.confidence - a.confidence)
    const kept = ranked.slice(0, MAX_CORRELATIONS)
    const omitted = correlations.length - kept.length

    const raw = {
      baseRequestId: base.id,
      baseUrl: base.url,
      parameterName: i.parameterName,
      impactTypes: i.impactTypes ?? [...IMPACT_TYPES],
      checked: candidates.map((c) => c.id),
      missing,
      correlations
    }
    const rawRef = ctx.traces
      ? await ctx.traces.save('trace', JSON.stringify(raw, null, 2))
      : undefined

    const notes: string[] = []
    if (missing.length > 0) {
      notes.push(`skipped ${missing.length} unknown request id(s): ${missing.join(', ')}`)
    }
    if (omitted > 0) {
      notes.push(`showing the ${kept.length} highest-confidence of ${correlations.length} correlations; narrow candidateRequestIds for the rest`)
    }
    if (correlations.length === 0) {
      notes.push(
        `no correlation found across ${candidates.length} request(s) for "${i.parameterName}" — the parameter may not propagate; try a different parameter or compare more candidates`
      )
    }

    return {
      correlations: kept,
      summary: { total: correlations.length, byType },
      rawRef,
      omitted: omitted > 0 ? omitted : undefined,
      note: notes.length > 0 ? notes.join('; ') : undefined
    }
  }
})

export const correlateTools: Tool[] = [correlate_requests as Tool]
export { correlate_requests }
