// inspect_tls_cert — ARCHITECTURE.MD §5.E / Dev 1 capability tool.
//
// Pure compute: analyzes a certificate object the agent (Dev 3's TLS-fetching
// tools) already obtained and passed in. It does NOT open a TLS connection and
// performs no network, filesystem, or process I/O. The `cert` shape mirrors
// Node's `tls.TLSSocket#getPeerCertificate()` / what Dev 3 would hand over.

import type { CapabilityTool, ValidationResult } from '../shared/tools'

// --- Inline input/output types (not exported to src/shared/tools.ts) ---------

type CertInput = {
  subject?: Record<string, string>
  issuer?: Record<string, string>
  subjectAltNames?: string[]
  validFrom: string
  validTo: string
  serialNumber?: string
  signatureAlgorithm?: string
  keyType?: string
  keyBits?: number
  selfSigned?: boolean
}

type InspectTlsCertInput = {
  cert: CertInput
  hostname?: string
  nowMs?: number
}

type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical'

type Finding = {
  severity: Severity
  message: string
}

type InspectTlsCertOutput = {
  findings: Finding[]
  expired: boolean
  daysUntilExpiry: number
  hostnameMatches: boolean | null
}

const MS_PER_DAY = 86_400_000
const EXPIRING_SOON_DAYS = 30
const MAX_VALIDITY_DAYS = 398
const MAX_STRING = 10_000
const MAX_SANS = 1_000

// --- Validation (treat raw input as hostile, §5.C rule 2) --------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isStringMap(v: unknown, errors: string[], label: string): v is Record<string, string> {
  if (!isPlainObject(v)) {
    errors.push(`${label} must be an object`)
    return false
  }
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'string') {
      errors.push(`${label}.${k} must be a string`)
      return false
    }
    if (val.length > MAX_STRING) {
      errors.push(`${label}.${k} is too long`)
      return false
    }
  }
  return true
}

function validate(raw: unknown): ValidationResult<InspectTlsCertInput> {
  const errors: string[] = []
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['input must be an object'] }
  }
  if (!isPlainObject(raw.cert)) {
    return { ok: false, errors: ['cert must be an object'] }
  }
  const c = raw.cert

  if (typeof c.validFrom !== 'string' || c.validFrom.length === 0) {
    errors.push('cert.validFrom must be a non-empty string')
  } else if (c.validFrom.length > MAX_STRING || Number.isNaN(Date.parse(c.validFrom))) {
    errors.push('cert.validFrom must be a parseable date string')
  }
  if (typeof c.validTo !== 'string' || c.validTo.length === 0) {
    errors.push('cert.validTo must be a non-empty string')
  } else if (c.validTo.length > MAX_STRING || Number.isNaN(Date.parse(c.validTo))) {
    errors.push('cert.validTo must be a parseable date string')
  }

  const cert: CertInput = {
    validFrom: typeof c.validFrom === 'string' ? c.validFrom : '',
    validTo: typeof c.validTo === 'string' ? c.validTo : ''
  }

  if (c.subject !== undefined) {
    if (isStringMap(c.subject, errors, 'cert.subject')) cert.subject = c.subject
  }
  if (c.issuer !== undefined) {
    if (isStringMap(c.issuer, errors, 'cert.issuer')) cert.issuer = c.issuer
  }
  if (c.subjectAltNames !== undefined) {
    if (!Array.isArray(c.subjectAltNames)) {
      errors.push('cert.subjectAltNames must be an array')
    } else if (c.subjectAltNames.length > MAX_SANS) {
      errors.push('cert.subjectAltNames has too many entries')
    } else if (!c.subjectAltNames.every((s) => typeof s === 'string' && s.length <= MAX_STRING)) {
      errors.push('cert.subjectAltNames must be an array of strings')
    } else {
      cert.subjectAltNames = c.subjectAltNames as string[]
    }
  }
  if (c.serialNumber !== undefined) {
    if (typeof c.serialNumber !== 'string' || c.serialNumber.length > MAX_STRING) {
      errors.push('cert.serialNumber must be a string')
    } else {
      cert.serialNumber = c.serialNumber
    }
  }
  if (c.signatureAlgorithm !== undefined) {
    if (typeof c.signatureAlgorithm !== 'string' || c.signatureAlgorithm.length > MAX_STRING) {
      errors.push('cert.signatureAlgorithm must be a string')
    } else {
      cert.signatureAlgorithm = c.signatureAlgorithm
    }
  }
  if (c.keyType !== undefined) {
    if (typeof c.keyType !== 'string' || c.keyType.length > MAX_STRING) {
      errors.push('cert.keyType must be a string')
    } else {
      cert.keyType = c.keyType
    }
  }
  if (c.keyBits !== undefined) {
    if (typeof c.keyBits !== 'number' || !Number.isFinite(c.keyBits) || c.keyBits < 0) {
      errors.push('cert.keyBits must be a non-negative number')
    } else {
      cert.keyBits = c.keyBits
    }
  }
  if (c.selfSigned !== undefined) {
    if (typeof c.selfSigned !== 'boolean') {
      errors.push('cert.selfSigned must be a boolean')
    } else {
      cert.selfSigned = c.selfSigned
    }
  }

  const out: InspectTlsCertInput = { cert }

  if (raw.hostname !== undefined) {
    if (typeof raw.hostname !== 'string' || raw.hostname.length > MAX_STRING) {
      errors.push('hostname must be a string')
    } else {
      out.hostname = raw.hostname
    }
  }
  if (raw.nowMs !== undefined) {
    if (typeof raw.nowMs !== 'number' || !Number.isFinite(raw.nowMs)) {
      errors.push('nowMs must be a finite number')
    } else {
      out.nowMs = raw.nowMs
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: out }
}

// --- Hostname matching (simple `*.` wildcard, leftmost label only) -----------

function hostMatches(host: string, pattern: string): boolean {
  const h = host.trim().toLowerCase()
  const p = pattern.trim().toLowerCase()
  if (p.length === 0 || h.length === 0) return false
  if (p === h) return true
  if (p.startsWith('*.')) {
    const suffix = p.slice(1) // ".example.com"
    if (!h.endsWith(suffix)) return false
    // Wildcard covers exactly one leftmost label; no further dots allowed.
    const left = h.slice(0, h.length - suffix.length)
    return left.length > 0 && !left.includes('.')
  }
  return false
}

function collectNames(cert: CertInput): string[] {
  const names: string[] = []
  if (cert.subjectAltNames) {
    for (const san of cert.subjectAltNames) {
      // Accept raw names and "DNS:host" forms.
      const m = /^dns:/i.exec(san)
      names.push(m ? san.slice(m[0].length).trim() : san.trim())
    }
  }
  const cn = cert.subject?.CN ?? cert.subject?.cn
  if (cn) names.push(cn.trim())
  return names.filter((n) => n.length > 0)
}

// --- Core compute ------------------------------------------------------------

function inspect(input: InspectTlsCertInput): InspectTlsCertOutput {
  const { cert } = input
  const now = input.nowMs ?? Date.now()
  const findings: Finding[] = []

  const validFromMs = Date.parse(cert.validFrom)
  const validToMs = Date.parse(cert.validTo)

  const expired = now > validToMs
  const notYetValid = now < validFromMs
  const daysUntilExpiry = Math.floor((validToMs - now) / MS_PER_DAY)

  if (expired) {
    findings.push({ severity: 'critical', message: `Certificate expired ${-daysUntilExpiry} day(s) ago (validTo ${cert.validTo}).` })
  } else if (notYetValid) {
    const days = Math.ceil((validFromMs - now) / MS_PER_DAY)
    findings.push({ severity: 'high', message: `Certificate is not yet valid (validFrom ${cert.validFrom}, ${days} day(s) away).` })
  } else if (daysUntilExpiry < EXPIRING_SOON_DAYS) {
    findings.push({ severity: 'medium', message: `Certificate expires soon in ${daysUntilExpiry} day(s) (validTo ${cert.validTo}).` })
  }

  // Validity period length.
  const validityDays = Math.floor((validToMs - validFromMs) / MS_PER_DAY)
  if (validityDays > MAX_VALIDITY_DAYS) {
    findings.push({ severity: 'low', message: `Validity period of ${validityDays} days exceeds the ${MAX_VALIDITY_DAYS}-day maximum (CA/Browser Forum).` })
  }

  // Hostname matching.
  let hostnameMatches: boolean | null = null
  if (input.hostname !== undefined) {
    const names = collectNames(cert)
    hostnameMatches = names.some((n) => hostMatches(input.hostname as string, n))
    if (!hostnameMatches) {
      findings.push({ severity: 'high', message: `Hostname "${input.hostname}" does not match certificate names [${names.join(', ')}].` })
    }
  }

  // Weak signature algorithm.
  if (cert.signatureAlgorithm) {
    const sig = cert.signatureAlgorithm.toLowerCase()
    if (sig.includes('md5')) {
      findings.push({ severity: 'critical', message: `Weak signature algorithm "${cert.signatureAlgorithm}" (MD5 is broken).` })
    } else if (sig.includes('sha1') || sig.includes('sha-1')) {
      findings.push({ severity: 'high', message: `Weak signature algorithm "${cert.signatureAlgorithm}" (SHA-1 is deprecated).` })
    }
  }

  // Weak key.
  const keyType = cert.keyType?.toUpperCase()
  const isRsa = keyType === undefined ? false : keyType.includes('RSA')
  if (cert.keyBits === undefined) {
    findings.push({ severity: 'low', message: 'Certificate key size is unknown; cannot verify key strength.' })
  } else if (isRsa && cert.keyBits < 2048) {
    findings.push({ severity: 'high', message: `Weak RSA key: ${cert.keyBits} bits (minimum 2048).` })
  } else if (keyType === undefined && cert.keyBits < 2048) {
    findings.push({ severity: 'medium', message: `Key size of ${cert.keyBits} bits may be weak (key type unknown).` })
  }

  // Self-signed.
  if (cert.selfSigned === true) {
    findings.push({ severity: 'medium', message: 'Certificate is self-signed; not anchored to a trusted CA.' })
  }

  return { findings, expired, daysUntilExpiry, hostnameMatches }
}

export const inspectTlsCertTool: CapabilityTool<InspectTlsCertInput, InspectTlsCertOutput> = {
  name: 'inspect_tls_cert',
  description:
    'Analyzes a pre-fetched TLS certificate object for expiry, hostname mismatch, weak signature/key, self-signing, and over-long validity. Pure compute; opens no connection.',
  riskTier: 'read-only',
  validateInput: validate,
  handler: inspect
}
