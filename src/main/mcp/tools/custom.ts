// API.md §3.8 — Custom capability tools (component 5.E, Owner: Dev 1).
// PURE-COMPUTE, tier R: they generate payloads and analyze bodies the agent
// already holds. They NEVER open a socket. To actually send, the agent feeds
// these outputs into §3.4 replay_request / §3.2 navigate, which carry the scope
// check, audit line, tier, and (via D) the rate limit.
import { defineTool, type Tool } from '../tool'
import { enumOf, optStr, str, strArray } from '../validate'

// ── gen_fuzz_payloads ─────────────────────────────────────────────────────────
const BASE_CORPUS = [
  "' OR '1'='1",
  '"><script>x</script>',
  '../../../../etc/passwd',
  '${7*7}',
  '{{7*7}}',
  '`id`',
  '\u0000',
  '%00',
  '-1',
  '2147483648'
]

function encode(value: string, how: string): string {
  switch (how) {
    case 'url':
      return encodeURIComponent(value)
    case 'double-url':
      return encodeURIComponent(encodeURIComponent(value))
    case 'html':
      return value.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`)
    case 'base64':
      return Buffer.from(value, 'utf8').toString('base64')
    default:
      return value
  }
}

const gen_fuzz_payloads = defineTool<
  { corpus?: string[]; encodings?: string[]; boundaries?: boolean },
  { payloads: string[] }
>({
  name: 'gen_fuzz_payloads',
  description: 'Generate a payload set (seeds × encodings + boundary values) as data.',
  riskTier: 'R',
  inputSchema: {
    type: 'object',
    properties: {
      corpus: { type: 'array', items: { type: 'string' } },
      encodings: { type: 'array', items: { enum: ['url', 'double-url', 'html', 'base64'] } },
      boundaries: { type: 'boolean' }
    },
    additionalProperties: false
  },
  outputSchema: { type: 'object', properties: { payloads: { type: 'array' } } },
  parse: (raw) => {
    const r = raw as Record<string, unknown>
    return {
      corpus: Array.isArray(r.corpus) ? strArray(raw, 'corpus') : undefined,
      encodings: Array.isArray(r.encodings) ? strArray(raw, 'encodings') : undefined,
      boundaries: r.boundaries === true
    }
  },
  execute: async (i) => {
    const seeds = i.corpus?.length ? i.corpus : BASE_CORPUS
    const encs = i.encodings?.length ? i.encodings : ['url']
    const out = new Set<string>()
    for (const seed of seeds) {
      out.add(seed)
      for (const e of encs) out.add(encode(seed, e))
    }
    if (i.boundaries) ['', ' ', 'A'.repeat(1024), '0', '-0', 'null', 'undefined'].forEach((b) => out.add(b))
    return { payloads: [...out] }
  }
})

// ── break_regex ───────────────────────────────────────────────────────────────
// Heuristic ReDoS candidate generator: nested/adjacent quantifiers on an
// overlapping class ((a+)+, (a|a)*, (.*)* …) are the classic catastrophic-
// backtracking shapes. We emit escalating attack strings with a failing tail.
const break_regex = defineTool<
  { pattern: string },
  { redosCandidates: string[]; notes: string }
>({
  name: 'break_regex',
  description: 'Given a regex, emit catastrophic-backtracking candidate strings (data only).',
  riskTier: 'R',
  inputSchema: {
    type: 'object',
    required: ['pattern'],
    properties: { pattern: { type: 'string' } },
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: { redosCandidates: { type: 'array' }, notes: { type: 'string' } }
  },
  parse: (raw) => ({ pattern: str(raw, 'pattern') }),
  execute: async (i) => {
    const risky =
      /(\([^)]*[+*][^)]*\)[+*])|([+*]\s*[+*])|(\.\*\)[+*])|(\((\w)\|\5\))/.test(i.pattern)
    const seedChar = (i.pattern.match(/[A-Za-z0-9]/)?.[0] ?? 'a')
    const candidates: string[] = []
    for (const n of [10, 20, 30, 40]) {
      candidates.push(seedChar.repeat(n * 1000) + '!') // long match prefix + non-matching tail
    }
    return {
      redosCandidates: candidates,
      notes: risky
        ? 'Pattern contains nested/adjacent quantifiers — likely catastrophic backtracking.'
        : 'No obvious nested-quantifier ReDoS shape found; candidates are generic stress strings.'
    }
  }
})

// ── mutate_payload ──────────────────────────────────────────────────────────────
const mutate_payload = defineTool<
  { seed: string; strategy: 'case' | 'insert' | 'truncate' | 'repeat' },
  { variants: string[] }
>({
  name: 'mutate_payload',
  description: 'Produce mutations of a seed string (data only).',
  riskTier: 'R',
  inputSchema: {
    type: 'object',
    required: ['seed', 'strategy'],
    properties: { seed: { type: 'string' }, strategy: { enum: ['case', 'insert', 'truncate', 'repeat'] } },
    additionalProperties: false
  },
  outputSchema: { type: 'object', properties: { variants: { type: 'array' } } },
  parse: (raw) => ({
    seed: str(raw, 'seed'),
    strategy: enumOf(raw, 'strategy', ['case', 'insert', 'truncate', 'repeat'] as const)
  }),
  execute: async (i) => {
    const s = i.seed
    switch (i.strategy) {
      case 'case':
        return { variants: [s.toUpperCase(), s.toLowerCase(), [...s].map((c, n) => (n % 2 ? c.toUpperCase() : c.toLowerCase())).join('')] }
      case 'insert':
        return { variants: ['\u0000' + s, s + '\u0000', s.slice(0, 1) + '/*x*/' + s.slice(1)] }
      case 'truncate':
        return { variants: [s.slice(0, Math.ceil(s.length / 2)), s.slice(0, 1), ''] }
      case 'repeat':
        return { variants: [s + s, s.repeat(8), s.repeat(64)] }
    }
  }
})

// ── detect_encoding ─────────────────────────────────────────────────────────────
function shannon(input: string): number {
  if (!input) return 0
  const freq = new Map<string, number>()
  for (const ch of input) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let h = 0
  for (const c of freq.values()) {
    const p = c / input.length
    h -= p * Math.log2(p)
  }
  return Number(h.toFixed(3))
}

const detect_encoding = defineTool<
  { body: string },
  { encodings: string[]; entropy: number }
>({
  name: 'detect_encoding',
  description: 'Classify likely encodings of a body string and compute its entropy (data only).',
  riskTier: 'R',
  // Skeleton takes an inline body; the production tool resolves a bodyRef via the
  // trace store (read-only) instead of receiving the bytes inline.
  inputSchema: {
    type: 'object',
    required: ['body'],
    properties: { body: { type: 'string' } },
    additionalProperties: false
  },
  outputSchema: { type: 'object', properties: { encodings: { type: 'array' }, entropy: {} } },
  parse: (raw) => ({ body: str(raw, 'body') }),
  execute: async (i) => {
    const b = i.body
    const enc: string[] = []
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(b) && b.length % 4 === 0) enc.push('base64')
    if (/^[0-9a-fA-F]+$/.test(b) && b.length % 2 === 0) enc.push('hex')
    if (/%[0-9a-fA-F]{2}/.test(b)) enc.push('url')
    if (/&#?\w+;/.test(b)) enc.push('html-entities')
    return { encodings: enc.length ? enc : ['plain'], entropy: shannon(b) }
  }
})

// diff_responses kept as a schema-complete definition; delta impl is small but
// left for Dev 1 to align with the response-shape contract (open-decision 2).
const diff_responses = defineTool<{ a: string; b: string }, unknown>({
  name: 'diff_responses',
  description: 'Compare two response bodies; return a compact delta (data only).',
  riskTier: 'R',
  inputSchema: {
    type: 'object',
    required: ['a', 'b'],
    properties: { a: { type: 'string' }, b: { type: 'string' } },
    additionalProperties: false
  },
  outputSchema: { type: 'object' },
  parse: (raw) => ({ a: str(raw, 'a'), b: str(raw, 'b') }),
  execute: async (i) => ({
    lengthDelta: i.b.length - i.a.length,
    identical: i.a === i.b,
    entropyDelta: shannon(i.b) - shannon(i.a)
  })
})

// Suppress unused-import lint if optStr ends up unreferenced across edits.
void optStr

export const customTools: Tool[] = [
  gen_fuzz_payloads as Tool,
  break_regex as Tool,
  mutate_payload as Tool,
  detect_encoding as Tool,
  diff_responses as Tool
]
