// detect_encoding — ARCHITECTURE.MD §5.E / Dev 1 task 9.
//
// Pure string analysis: Shannon entropy estimate, charset/encoding guesses
// (base64/hex/url-encoded/plain), and a high-entropy flag. Operates only on
// the `body` string passed in — no network, no filesystem.

import type {
  CapabilityTool,
  DetectEncodingInput,
  DetectEncodingOutput,
  ValidationResult
} from '../shared/tools'

const MAX_BODY_LENGTH = 5_000_000

function validate(raw: unknown): ValidationResult<DetectEncodingInput> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['input must be an object'] }
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.body !== 'string') {
    return { ok: false, errors: ['body must be a string'] }
  }
  if (obj.body.length > MAX_BODY_LENGTH) {
    return { ok: false, errors: [`body must be <= ${MAX_BODY_LENGTH} chars`] }
  }
  return { ok: true, value: { body: obj.body } }
}

/** Shannon entropy in bits/char over the byte-ish frequency distribution. */
function shannonEntropy(s: string): number {
  if (s.length === 0) return 0
  const freq = new Map<string, number>()
  for (const ch of s) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1)
  }
  let entropy = 0
  for (const count of freq.values()) {
    const p = count / s.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/
const HEX_RE = /^(0x)?[0-9a-fA-F]+$/
const URL_ENCODED_RE = /%[0-9a-fA-F]{2}/

function looksLikeBase64(s: string): boolean {
  const trimmed = s.trim()
  if (trimmed.length < 8 || trimmed.length % 4 !== 0) return false
  return BASE64_RE.test(trimmed)
}

function looksLikeHex(s: string): boolean {
  const trimmed = s.trim()
  if (trimmed.length < 4) return false
  return HEX_RE.test(trimmed) && trimmed.replace(/^0x/, '').length % 2 === 0
}

function looksUrlEncoded(s: string): boolean {
  return URL_ENCODED_RE.test(s)
}

function detect(input: DetectEncodingInput): DetectEncodingOutput {
  const { body } = input
  const entropy = shannonEntropy(body)
  const flags: string[] = []
  const likelyEncodings: DetectEncodingOutput['likelyEncodings'] = []

  if (looksLikeBase64(body)) likelyEncodings.push('base64')
  if (looksLikeHex(body)) likelyEncodings.push('hex')
  if (looksUrlEncoded(body)) likelyEncodings.push('url-encoded')
  if (likelyEncodings.length === 0) likelyEncodings.push('plain-text')

  // Max entropy for printable-ish text is well under 8 bits/char; real
  // compressed/encrypted binary tends toward entropy > ~7.5 bits/char when
  // sampled as raw bytes. Over a JS string of arbitrary chars this is an
  // estimate, not a certainty — flagged accordingly.
  const highEntropy = entropy > 4.5 && body.length > 32

  if (highEntropy) {
    flags.push('high-entropy: possibly encrypted or compressed data')
  }
  if (likelyEncodings.includes('base64') && highEntropy) {
    flags.push('base64-shaped and high-entropy: likely encoded binary payload')
  }
  if (body.length === 0) {
    flags.push('empty body')
  }

  return {
    entropy,
    likelyEncodings,
    highEntropy,
    flags
  }
}

export const detectEncodingTool: CapabilityTool<DetectEncodingInput, DetectEncodingOutput> = {
  name: 'detect_encoding',
  description:
    'Analyzes a response body string for entropy, likely encoding (base64/hex/url-encoded), and high-entropy flags. Pure string analysis.',
  riskTier: 'read-only',
  validateInput: validate,
  handler: detect
}
