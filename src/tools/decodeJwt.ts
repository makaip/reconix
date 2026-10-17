// decode_jwt — ARCHITECTURE.MD §5.E / Dev 1 capability tool.
//
// Pure compute: base64url-decode a JWT's three segments into header + payload
// JSON (plus the raw signature), optionally shallow-merge edits into the
// decoded parts, and optionally re-sign. HS* signatures use Node's built-in
// `crypto` HMAC (pure compute, no sockets); 'none' yields an empty signature
// (the alg:none downgrade probe, for authorized testing). No network, no
// filesystem, no process I/O.

import { createHmac } from 'node:crypto'
import type { CapabilityTool, ValidationResult } from '../shared/tools'

// --- Input/Output types (declared inline, per task constraints) ------------

type ResignAlg = 'HS256' | 'HS384' | 'HS512' | 'none'

export type DecodeJwtInput = {
  token: string
  edit?: {
    header?: Record<string, unknown>
    payload?: Record<string, unknown>
  }
  resign?: {
    alg: ResignAlg
    secret?: string
  }
}

export type DecodeJwtOutput = {
  header: Record<string, unknown>
  payload: Record<string, unknown>
  signature: string
  notes: string[]
  resignedToken?: string
}

const MAX_TOKEN_LENGTH = 1_000_000
const RESIGN_ALGS: readonly ResignAlg[] = ['HS256', 'HS384', 'HS512', 'none']

// --- Validation (input is hostile, §5.C rule 2) ----------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function validate(raw: unknown): ValidationResult<DecodeJwtInput> {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['input must be an object'] }
  }
  const errors: string[] = []
  const allowedTop = new Set(['token', 'edit', 'resign'])
  for (const key of Object.keys(raw)) {
    if (!allowedTop.has(key)) errors.push(`unexpected field: ${key}`)
  }

  if (typeof raw.token !== 'string') {
    errors.push('token must be a string')
  } else {
    if (raw.token.length > MAX_TOKEN_LENGTH) {
      errors.push(`token must be <= ${MAX_TOKEN_LENGTH} chars`)
    }
    if (raw.token.split('.').length !== 3) {
      errors.push('token must have 3 dot-separated segments')
    }
  }

  const out: DecodeJwtInput = { token: raw.token as string }

  if (raw.edit !== undefined) {
    if (!isPlainObject(raw.edit)) {
      errors.push('edit must be an object')
    } else {
      const allowedEdit = new Set(['header', 'payload'])
      for (const key of Object.keys(raw.edit)) {
        if (!allowedEdit.has(key)) errors.push(`edit has unexpected field: ${key}`)
      }
      if (raw.edit.header !== undefined && !isPlainObject(raw.edit.header)) {
        errors.push('edit.header must be an object')
      }
      if (raw.edit.payload !== undefined && !isPlainObject(raw.edit.payload)) {
        errors.push('edit.payload must be an object')
      }
      if (errors.length === 0) {
        out.edit = {}
        if (raw.edit.header !== undefined) {
          out.edit.header = raw.edit.header as Record<string, unknown>
        }
        if (raw.edit.payload !== undefined) {
          out.edit.payload = raw.edit.payload as Record<string, unknown>
        }
      }
    }
  }

  if (raw.resign !== undefined) {
    if (!isPlainObject(raw.resign)) {
      errors.push('resign must be an object')
    } else {
      const allowedResign = new Set(['alg', 'secret'])
      for (const key of Object.keys(raw.resign)) {
        if (!allowedResign.has(key)) errors.push(`resign has unexpected field: ${key}`)
      }
      if (!RESIGN_ALGS.includes(raw.resign.alg as ResignAlg)) {
        errors.push(`resign.alg must be one of: ${RESIGN_ALGS.join(', ')}`)
      }
      if (raw.resign.secret !== undefined && typeof raw.resign.secret !== 'string') {
        errors.push('resign.secret must be a string')
      }
      if (errors.length === 0) {
        out.resign = { alg: raw.resign.alg as ResignAlg }
        if (raw.resign.secret !== undefined) {
          out.resign.secret = raw.resign.secret as string
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: out }
}

// --- base64url helpers (pure compute) --------------------------------------

function base64urlDecode(segment: string): Buffer {
  // Buffer's base64 decoder tolerates base64url alphabet and missing padding,
  // but normalize explicitly so behavior is deterministic across Node versions.
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(normalized, 'base64')
}

function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64urlEncodeJson(obj: Record<string, unknown>): string {
  return base64urlEncode(Buffer.from(JSON.stringify(obj), 'utf8'))
}

const HMAC_ALGS: Record<Exclude<ResignAlg, 'none'>, string> = {
  HS256: 'sha256',
  HS384: 'sha384',
  HS512: 'sha512'
}

// --- Handler ----------------------------------------------------------------

function decode(input: DecodeJwtInput): DecodeJwtOutput {
  const notes: string[] = []
  const [rawHeader, rawPayload, rawSignature] = input.token.split('.')

  let header: Record<string, unknown> = {}
  let payload: Record<string, unknown> = {}

  // Decode header.
  try {
    const parsed = JSON.parse(base64urlDecode(rawHeader).toString('utf8'))
    if (isPlainObject(parsed)) {
      header = parsed
    } else {
      notes.push('header is not a JSON object')
    }
  } catch {
    notes.push('header segment is not valid base64url JSON')
  }

  // Decode payload.
  try {
    const parsed = JSON.parse(base64urlDecode(rawPayload).toString('utf8'))
    if (isPlainObject(parsed)) {
      payload = parsed
    } else {
      notes.push('payload is not a JSON object')
    }
  } catch {
    notes.push('payload segment is not valid base64url JSON')
  }

  const signature = rawSignature

  // Apply shallow-merge edits.
  if (input.edit?.header) {
    header = { ...header, ...input.edit.header }
  }
  if (input.edit?.payload) {
    payload = { ...payload, ...input.edit.payload }
  }

  // Validation notes on the (possibly edited) parts.
  if (typeof payload.exp === 'number') {
    const nowSec = Math.floor(Date.now() / 1000)
    if (payload.exp < nowSec) {
      notes.push('exp in past')
    }
  }
  if (input.resign && typeof header.alg === 'string' && header.alg !== input.resign.alg) {
    notes.push(`alg mismatch: header.alg=${header.alg} but resign.alg=${input.resign.alg}`)
  }

  const out: DecodeJwtOutput = { header, payload, signature, notes }

  // Re-sign if requested.
  if (input.resign) {
    const { alg } = input.resign
    const signingInput = `${base64urlEncodeJson(header)}.${base64urlEncodeJson(payload)}`

    if (alg === 'none') {
      out.resignedToken = `${signingInput}.`
      notes.push('resigned with alg:none (empty signature — downgrade probe)')
    } else {
      if (input.resign.secret === undefined) {
        notes.push(`resign skipped: secret required for ${alg}`)
      } else {
        const hmac = createHmac(HMAC_ALGS[alg], input.resign.secret)
        hmac.update(signingInput)
        const newSig = base64urlEncode(hmac.digest())
        out.resignedToken = `${signingInput}.${newSig}`
      }
    }
  }

  return out
}

export const decodeJwtTool: CapabilityTool<DecodeJwtInput, DecodeJwtOutput> = {
  name: 'decode_jwt',
  description:
    'Base64url-decodes a JWT into header + payload JSON, optionally shallow-merges edits, and optionally re-signs (HS256/384/512 via HMAC, or alg:none for downgrade probing). Surfaces validation notes (exp in past, alg mismatch). Pure compute — no network or filesystem.',
  riskTier: 'processing',
  validateInput: validate,
  handler: decode
}
