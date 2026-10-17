import { describe, expect, it } from 'vitest'
import { invokeTool, ToolInputError } from '../shared/tools'
import { inspectTlsCertTool } from './inspectTlsCert'

const DAY = 86_400_000
// Pinned reference "now": 2024-06-01T00:00:00Z.
const NOW = Date.parse('2024-06-01T00:00:00Z')

function iso(offsetDays: number): string {
  return new Date(NOW + offsetDays * DAY).toISOString()
}

describe('inspect_tls_cert', () => {
  it('flags an expired certificate as critical', () => {
    const result = invokeTool(inspectTlsCertTool, {
      cert: { validFrom: iso(-400), validTo: iso(-10) },
      nowMs: NOW
    })
    expect(result.expired).toBe(true)
    expect(result.daysUntilExpiry).toBeLessThan(0)
    expect(result.findings.some((f) => f.severity === 'critical' && /expired/i.test(f.message))).toBe(true)
  })

  it('flags not-yet-valid certificate as high', () => {
    const result = invokeTool(inspectTlsCertTool, {
      cert: { validFrom: iso(5), validTo: iso(100) },
      nowMs: NOW
    })
    expect(result.expired).toBe(false)
    expect(result.findings.some((f) => f.severity === 'high' && /not yet valid/i.test(f.message))).toBe(true)
  })

  it('flags expiring-soon (<30 days) with pinned nowMs', () => {
    const result = invokeTool(inspectTlsCertTool, {
      cert: { validFrom: iso(-100), validTo: iso(10) },
      nowMs: NOW
    })
    expect(result.expired).toBe(false)
    expect(result.daysUntilExpiry).toBe(10)
    expect(result.findings.some((f) => f.severity === 'medium' && /expires soon/i.test(f.message))).toBe(true)
  })

  it('flags hostname mismatch against SAN list', () => {
    const result = invokeTool(inspectTlsCertTool, {
      cert: {
        validFrom: iso(-10),
        validTo: iso(90),
        subjectAltNames: ['example.com', 'www.example.com']
      },
      hostname: 'evil.example.org',
      nowMs: NOW
    })
    expect(result.hostnameMatches).toBe(false)
    expect(result.findings.some((f) => f.severity === 'high' && /does not match/i.test(f.message))).toBe(true)
  })

  it('matches a wildcard SAN (one leftmost label only)', () => {
    const result = invokeTool(inspectTlsCertTool, {
      cert: {
        validFrom: iso(-10),
        validTo: iso(90),
        subjectAltNames: ['DNS:*.example.com']
      },
      hostname: 'api.example.com',
      nowMs: NOW
    })
    expect(result.hostnameMatches).toBe(true)
    expect(result.findings.some((f) => /does not match/i.test(f.message))).toBe(false)
  })

  it('wildcard does not match multi-label host', () => {
    const result = invokeTool(inspectTlsCertTool, {
      cert: {
        validFrom: iso(-10),
        validTo: iso(90),
        subjectAltNames: ['*.example.com']
      },
      hostname: 'a.b.example.com',
      nowMs: NOW
    })
    expect(result.hostnameMatches).toBe(false)
  })

  it('matches hostname via subject CN when no SANs', () => {
    const result = invokeTool(inspectTlsCertTool, {
      cert: {
        validFrom: iso(-10),
        validTo: iso(90),
        subject: { CN: 'host.example.com' }
      },
      hostname: 'host.example.com',
      nowMs: NOW
    })
    expect(result.hostnameMatches).toBe(true)
  })

  it('flags sha1 weak signature as high', () => {
    const result = invokeTool(inspectTlsCertTool, {
      cert: {
        validFrom: iso(-10),
        validTo: iso(90),
        signatureAlgorithm: 'sha1WithRSAEncryption'
      },
      nowMs: NOW
    })
    expect(result.findings.some((f) => f.severity === 'high' && /SHA-1/i.test(f.message))).toBe(true)
  })

  it('flags md5 weak signature as critical', () => {
    const result = invokeTool(inspectTlsCertTool, {
      cert: {
        validFrom: iso(-10),
        validTo: iso(90),
        signatureAlgorithm: 'md5WithRSAEncryption',
        keyType: 'RSA',
        keyBits: 2048
      },
      nowMs: NOW
    })
    expect(result.findings.some((f) => f.severity === 'critical' && /MD5/i.test(f.message))).toBe(true)
  })

  it('flags RSA 1024 weak key as high', () => {
    const result = invokeTool(inspectTlsCertTool, {
      cert: {
        validFrom: iso(-10),
        validTo: iso(90),
        keyType: 'RSA',
        keyBits: 1024
      },
      nowMs: NOW
    })
    expect(result.findings.some((f) => f.severity === 'high' && /RSA/i.test(f.message))).toBe(true)
  })

  it('flags missing key bits as low', () => {
    const result = invokeTool(inspectTlsCertTool, {
      cert: { validFrom: iso(-10), validTo: iso(90), keyType: 'RSA' },
      nowMs: NOW
    })
    expect(result.findings.some((f) => f.severity === 'low' && /unknown/i.test(f.message))).toBe(true)
  })

  it('flags self-signed as medium', () => {
    const result = invokeTool(inspectTlsCertTool, {
      cert: { validFrom: iso(-10), validTo: iso(90), selfSigned: true, keyType: 'RSA', keyBits: 4096 },
      nowMs: NOW
    })
    expect(result.findings.some((f) => f.severity === 'medium' && /self-signed/i.test(f.message))).toBe(true)
  })

  it('flags over-long validity period (>398 days) as low', () => {
    const result = invokeTool(inspectTlsCertTool, {
      cert: { validFrom: iso(-10), validTo: iso(500), keyType: 'RSA', keyBits: 2048 },
      nowMs: NOW
    })
    expect(result.findings.some((f) => f.severity === 'low' && /398/.test(f.message))).toBe(true)
  })

  it('clean valid certificate yields no high/critical findings', () => {
    const result = invokeTool(inspectTlsCertTool, {
      cert: {
        validFrom: iso(-30),
        validTo: iso(300),
        subjectAltNames: ['example.com', 'www.example.com'],
        subject: { CN: 'example.com' },
        signatureAlgorithm: 'sha256WithRSAEncryption',
        keyType: 'RSA',
        keyBits: 2048,
        selfSigned: false
      },
      hostname: 'www.example.com',
      nowMs: NOW
    })
    expect(result.expired).toBe(false)
    expect(result.hostnameMatches).toBe(true)
    expect(result.findings.some((f) => f.severity === 'high' || f.severity === 'critical')).toBe(false)
  })

  it('hostnameMatches is null when no hostname supplied', () => {
    const result = invokeTool(inspectTlsCertTool, {
      cert: { validFrom: iso(-10), validTo: iso(90), keyType: 'RSA', keyBits: 2048 },
      nowMs: NOW
    })
    expect(result.hostnameMatches).toBeNull()
  })

  it('rejects hostile input: missing cert', () => {
    expect(() => invokeTool(inspectTlsCertTool, {})).toThrow(ToolInputError)
  })

  it('rejects hostile input: cert missing validTo', () => {
    expect(() => invokeTool(inspectTlsCertTool, { cert: { validFrom: iso(0) } })).toThrow(ToolInputError)
  })

  it('rejects hostile input: unparseable date', () => {
    expect(() =>
      invokeTool(inspectTlsCertTool, { cert: { validFrom: 'not-a-date', validTo: iso(90) } })
    ).toThrow(ToolInputError)
  })

  it('rejects hostile input: wrong types', () => {
    expect(() =>
      invokeTool(inspectTlsCertTool, {
        cert: { validFrom: iso(-10), validTo: iso(90), keyBits: 'lots' as unknown as number }
      })
    ).toThrow(ToolInputError)
  })

  it('rejects hostile input: subjectAltNames not an array of strings', () => {
    expect(() =>
      invokeTool(inspectTlsCertTool, {
        cert: { validFrom: iso(-10), validTo: iso(90), subjectAltNames: [1, 2] as unknown as string[] }
      })
    ).toThrow(ToolInputError)
  })
})
