// detect_secrets — ARCHITECTURE.MD §5.E / Dev 1 capability tool.
//
// Pure string analysis: regex-scans a response body the agent already has for
// common secret/token shapes (API keys, tokens, JWTs, private keys, auth
// headers, credential assignments). Operates only on the `body` string passed
// in — no network, no filesystem, no process I/O. Every emitted hit is
// REDACTED to its first/last 4 chars so the full secret never leaves this
// tool (§5.E, §10).

import type { CapabilityTool, ValidationResult } from '../shared/tools'

const MAX_BODY_LENGTH = 5_000_000

// --- Input / Output types (inlined; only generic helpers imported) ----------

export type DetectSecretsInput = {
  body: string
}

export type SecretHit = {
  /** Shape label, e.g. 'aws-access-key-id', 'jwt', 'private-key'. */
  type: string
  /** Matched secret REDACTED to first/last 4 chars — never the full value. */
  redacted: string
  /** Byte-ish offset of the secret within `body`. */
  offset: number
  /** How strongly the shape implies a real secret. */
  confidence: 'low' | 'medium' | 'high'
}

export type DetectSecretsOutput = {
  hits: SecretHit[]
  count: number
}

// --- Validation (input is hostile, §5.C rule 2) -----------------------------

function validate(raw: unknown): ValidationResult<DetectSecretsInput> {
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

// --- Redaction --------------------------------------------------------------

/**
 * Reduce a secret to first/last 4 chars. Short secrets (<= 8 chars) are fully
 * masked, since keeping both ends would otherwise reveal the whole value. The
 * full secret is guaranteed never to appear in the output.
 */
function redact(secret: string): string {
  if (secret.length <= 8) {
    return '*'.repeat(secret.length)
  }
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`
}

/** Shannon entropy in bits/char — used to gate high-entropy-shaped matches. */
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

// --- Pattern table ----------------------------------------------------------

type Matcher = {
  type: string
  re: RegExp
  confidence: SecretHit['confidence']
  /**
   * Returns the secret substring and its offset for a match, or null to skip
   * (e.g. entropy gate failed). Defaults to the whole match at `m.index`; when
   * capture group 1 is present it is used and the offset is located within the
   * match so the credential value — not its label — is what gets redacted.
   */
  extract?: (m: RegExpExecArray) => { secret: string; offset: number } | null
}

function groupExtract(m: RegExpExecArray): { secret: string; offset: number } | null {
  const value = m[1]
  if (value === undefined) return { secret: m[0], offset: m.index }
  const rel = m[0].indexOf(value)
  return { secret: value, offset: m.index + (rel < 0 ? 0 : rel) }
}

const MATCHERS: Matcher[] = [
  {
    type: 'aws-access-key-id',
    re: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g,
    confidence: 'high',
    extract: groupExtract
  },
  {
    type: 'aws-secret-access-key',
    re: /(?<![A-Za-z0-9/+=])([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/g,
    confidence: 'medium',
    // 40-char high-entropy string; gate on entropy to curb false positives.
    extract: (m) => {
      const secret = m[1]
      if (shannonEntropy(secret) < 3.5) return null
      return { secret, offset: m.index }
    }
  },
  {
    type: 'google-api-key',
    re: /\b(AIza[0-9A-Za-z\-_]{35})\b/g,
    confidence: 'high',
    extract: groupExtract
  },
  {
    type: 'slack-token',
    re: /\b(xox[baprs]-[0-9A-Za-z-]{10,})\b/g,
    confidence: 'high',
    extract: groupExtract
  },
  {
    type: 'github-token',
    re: /\b((?:ghp|gho|ghs|ghu|ghr)_[0-9A-Za-z]{36}|github_pat_[0-9A-Za-z_]{22,})\b/g,
    confidence: 'high',
    extract: groupExtract
  },
  {
    type: 'jwt',
    re: /\b(eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,})\b/g,
    confidence: 'high',
    extract: groupExtract
  },
  {
    type: 'private-key',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    confidence: 'high'
  },
  {
    type: 'bearer-token',
    re: /[Bb]earer\s+([A-Za-z0-9\-._~+/]{8,}=*)/g,
    confidence: 'medium',
    extract: groupExtract
  },
  {
    type: 'basic-auth',
    re: /[Bb]asic\s+([A-Za-z0-9+/]{8,}={0,2})/g,
    confidence: 'medium',
    extract: groupExtract
  },
  {
    type: 'credential-assignment',
    re: /\b(?:api[_-]?key|secret|password|passwd|pwd|access[_-]?token|token)\b\s*[:=]\s*['"]?([^\s'"]{6,})['"]?/gi,
    confidence: 'low',
    extract: groupExtract
  }
]

// --- Scan -------------------------------------------------------------------

function detect(input: DetectSecretsInput): DetectSecretsOutput {
  const { body } = input
  const hits: SecretHit[] = []
  const seen = new Set<string>()

  for (const matcher of MATCHERS) {
    // Fresh lastIndex each run; `re` carries the global flag.
    matcher.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = matcher.re.exec(body)) !== null) {
      // Guard against zero-width matches causing an infinite loop.
      if (m[0].length === 0) {
        matcher.re.lastIndex += 1
        continue
      }
      const extracted = matcher.extract ? matcher.extract(m) : { secret: m[0], offset: m.index }
      if (extracted === null) continue
      const redacted = redact(extracted.secret)
      const key = `${matcher.type}|${extracted.offset}|${redacted}`
      if (seen.has(key)) continue
      seen.add(key)
      hits.push({
        type: matcher.type,
        redacted,
        offset: extracted.offset,
        confidence: matcher.confidence
      })
    }
  }

  hits.sort((a, b) => a.offset - b.offset || a.type.localeCompare(b.type))

  return { hits, count: hits.length }
}

export const detectSecretsTool: CapabilityTool<DetectSecretsInput, DetectSecretsOutput> = {
  name: 'detect_secrets',
  description:
    'Regex-scans a response body string for common secret/token shapes (AWS/Google/Slack/GitHub keys, JWTs, private keys, bearer/basic auth, credential assignments). Returns redacted hits with offsets and confidence. Pure string analysis.',
  riskTier: 'read-only',
  validateInput: validate,
  handler: detect
}
