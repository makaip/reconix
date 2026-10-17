import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { invokeTool, ToolInputError } from '../shared/tools'
import { decodeJwtTool } from './decodeJwt'

function b64url(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function makeToken(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  signature = 'sig'
): string {
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.${signature}`
}

describe('decode_jwt', () => {
  it('happy path: decodes header, payload, and raw signature', () => {
    const token = makeToken(
      { alg: 'HS256', typ: 'JWT' },
      { sub: '1234', name: 'alice', admin: false },
      'abc123'
    )
    const result = invokeTool(decodeJwtTool, { token })
    expect(result.header).toEqual({ alg: 'HS256', typ: 'JWT' })
    expect(result.payload).toEqual({ sub: '1234', name: 'alice', admin: false })
    expect(result.signature).toBe('abc123')
    expect(result.resignedToken).toBeUndefined()
  })

  it('edit: shallow-merges into decoded header and payload', () => {
    const token = makeToken({ alg: 'HS256', typ: 'JWT' }, { sub: '1234', admin: false })
    const result = invokeTool(decodeJwtTool, {
      token,
      edit: { header: { kid: 'k1' }, payload: { admin: true } }
    })
    expect(result.header).toEqual({ alg: 'HS256', typ: 'JWT', kid: 'k1' })
    expect(result.payload).toEqual({ sub: '1234', admin: true })
  })

  it('resign HS256: round-trip verifiable with node crypto', () => {
    const token = makeToken({ alg: 'HS256', typ: 'JWT' }, { sub: '1234', admin: false })
    const secret = 's3cr3t'
    const result = invokeTool(decodeJwtTool, {
      token,
      edit: { payload: { admin: true } },
      resign: { alg: 'HS256', secret }
    })
    expect(result.resignedToken).toBeDefined()
    const [h, p, sig] = result.resignedToken!.split('.')
    // Decoded payload inside the resigned token reflects the edit.
    expect(JSON.parse(Buffer.from(p, 'base64').toString('utf8')).admin).toBe(true)
    // Recompute the HMAC independently and confirm it matches.
    const expected = createHmac('sha256', secret)
      .update(`${h}.${p}`)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '')
    expect(sig).toBe(expected)
  })

  it('resign HS384 and HS512 produce distinct verifiable signatures', () => {
    const token = makeToken({ alg: 'HS256' }, { sub: 'x' })
    const secret = 'key'
    for (const [alg, hash] of [
      ['HS384', 'sha384'],
      ['HS512', 'sha512']
    ] as const) {
      const result = invokeTool(decodeJwtTool, { token, resign: { alg, secret } })
      const [h, p, sig] = result.resignedToken!.split('.')
      const expected = createHmac(hash, secret)
        .update(`${h}.${p}`)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '')
      expect(sig).toBe(expected)
    }
  })

  it('resign alg:none yields empty signature (downgrade probe)', () => {
    const token = makeToken({ alg: 'HS256' }, { sub: 'x' })
    const result = invokeTool(decodeJwtTool, { token, resign: { alg: 'none' } })
    expect(result.resignedToken).toMatch(/\.$/)
    expect(result.resignedToken!.endsWith('.')).toBe(true)
    const parts = result.resignedToken!.split('.')
    expect(parts[2]).toBe('')
    expect(result.notes.some((n) => n.includes('alg:none'))).toBe(true)
  })

  it('resign HS256 without secret: skipped, surfaced in notes, no resignedToken', () => {
    const token = makeToken({ alg: 'HS256' }, { sub: 'x' })
    const result = invokeTool(decodeJwtTool, { token, resign: { alg: 'HS256' } })
    expect(result.resignedToken).toBeUndefined()
    expect(result.notes.some((n) => n.includes('secret required'))).toBe(true)
  })

  it('notes: exp in past', () => {
    const token = makeToken({ alg: 'HS256' }, { sub: 'x', exp: 1 })
    const result = invokeTool(decodeJwtTool, { token })
    expect(result.notes).toContain('exp in past')
  })

  it('notes: alg mismatch between header and resign', () => {
    const token = makeToken({ alg: 'HS256' }, { sub: 'x' })
    const result = invokeTool(decodeJwtTool, {
      token,
      resign: { alg: 'none' }
    })
    expect(result.notes.some((n) => n.includes('alg mismatch'))).toBe(true)
  })

  it('malformed token: non-base64url-JSON segment surfaced in notes, not a crash', () => {
    const token = 'not-json.@@@invalid@@@.sig'
    const result = invokeTool(decodeJwtTool, { token })
    expect(result.notes.length).toBeGreaterThan(0)
    expect(result.header).toEqual({})
    expect(result.payload).toEqual({})
    expect(result.signature).toBe('sig')
  })

  it('rejects hostile input: wrong token type', () => {
    expect(() => invokeTool(decodeJwtTool, { token: 42 })).toThrow(ToolInputError)
  })

  it('rejects hostile input: missing token', () => {
    expect(() => invokeTool(decodeJwtTool, {})).toThrow(ToolInputError)
  })

  it('rejects hostile input: wrong segment count', () => {
    expect(() => invokeTool(decodeJwtTool, { token: 'a.b' })).toThrow(ToolInputError)
  })

  it('rejects hostile input: unexpected top-level field', () => {
    const token = makeToken({ alg: 'HS256' }, { sub: 'x' })
    expect(() => invokeTool(decodeJwtTool, { token, replay: true })).toThrow(ToolInputError)
  })

  it('rejects hostile input: bad resign.alg', () => {
    const token = makeToken({ alg: 'HS256' }, { sub: 'x' })
    expect(() => invokeTool(decodeJwtTool, { token, resign: { alg: 'RS256' } })).toThrow(
      ToolInputError
    )
  })

  it('rejects hostile input: edit.payload not an object', () => {
    const token = makeToken({ alg: 'HS256' }, { sub: 'x' })
    expect(() => invokeTool(decodeJwtTool, { token, edit: { payload: 'nope' } })).toThrow(
      ToolInputError
    )
  })

  it('rejects hostile input: oversized token', () => {
    const huge = `${'a'.repeat(1_000_001)}.b.c`
    expect(() => invokeTool(decodeJwtTool, { token: huge })).toThrow(ToolInputError)
  })
})
