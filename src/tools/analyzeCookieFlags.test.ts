import { describe, expect, it } from 'vitest'
import { invokeTool, ToolInputError } from '../shared/tools'
import { analyzeCookieFlagsTool } from './analyzeCookieFlags'

describe('analyze_cookie_flags', () => {
  it('flags missing Secure and HttpOnly on a bare cookie', () => {
    const result = invokeTool(analyzeCookieFlagsTool, {
      setCookieHeaders: ['sid=abc123; Path=/']
    })
    const cookie = result.cookies[0]
    expect(cookie.name).toBe('sid')
    expect(cookie.secure).toBe(false)
    expect(cookie.httpOnly).toBe(false)
    expect(cookie.findings.some((f) => f.message.includes('Secure'))).toBe(true)
    expect(cookie.findings.some((f) => f.message.includes('HttpOnly'))).toBe(true)
  })

  it('flags SameSite=None without Secure as high severity', () => {
    const result = invokeTool(analyzeCookieFlagsTool, {
      setCookieHeaders: ['sid=abc; HttpOnly; SameSite=None']
    })
    const cookie = result.cookies[0]
    expect(cookie.sameSite).toBe('None')
    expect(cookie.secure).toBe(false)
    expect(
      cookie.findings.some((f) => f.severity === 'high' && f.message.includes('SameSite=None'))
    ).toBe(true)
  })

  it('flags missing SameSite attribute', () => {
    const result = invokeTool(analyzeCookieFlagsTool, {
      setCookieHeaders: ['sid=abc; Secure; HttpOnly']
    })
    const cookie = result.cookies[0]
    expect(cookie.sameSite).toBeNull()
    expect(cookie.findings.some((f) => f.message.includes('Missing SameSite'))).toBe(true)
  })

  it('clean cookie with all flags yields no medium/high findings', () => {
    const result = invokeTool(analyzeCookieFlagsTool, {
      setCookieHeaders: ['sid=abc; Secure; HttpOnly; SameSite=Strict']
    })
    const cookie = result.cookies[0]
    expect(cookie.secure).toBe(true)
    expect(cookie.httpOnly).toBe(true)
    expect(cookie.sameSite).toBe('Strict')
    expect(cookie.findings.every((f) => f.severity === 'info')).toBe(true)
  })

  it('flags CSP unsafe-inline as high severity', () => {
    const result = invokeTool(analyzeCookieFlagsTool, {
      setCookieHeaders: [],
      responseHeaders: {
        'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'"
      }
    })
    expect(
      result.headerFindings.some(
        (f) =>
          f.header === 'Content-Security-Policy' &&
          f.severity === 'high' &&
          f.message.includes('unsafe-inline')
      )
    ).toBe(true)
  })

  it('flags ACAO:* combined with credentials:true as high severity', () => {
    const result = invokeTool(analyzeCookieFlagsTool, {
      setCookieHeaders: [],
      responseHeaders: {
        'Access-Control-Allow-Origin': '*',
        'access-control-allow-credentials': 'true'
      }
    })
    expect(
      result.headerFindings.some(
        (f) => f.header === 'Access-Control-Allow-Origin' && f.severity === 'high'
      )
    ).toBe(true)
  })

  it('does case-insensitive header lookup and reports missing HSTS', () => {
    const result = invokeTool(analyzeCookieFlagsTool, {
      setCookieHeaders: [],
      responseHeaders: { 'content-security-policy': "default-src 'self'" }
    })
    expect(
      result.headerFindings.some(
        (f) => f.header === 'Strict-Transport-Security' && f.message.includes('No Strict-Transport-Security')
      )
    ).toBe(true)
    // CSP present and sane: no unsafe-* finding
    expect(result.headerFindings.some((f) => f.message.includes('unsafe'))).toBe(false)
  })

  it('rejects hostile input: setCookieHeaders not an array', () => {
    expect(() =>
      invokeTool(analyzeCookieFlagsTool, { setCookieHeaders: 'sid=abc' })
    ).toThrow(ToolInputError)
  })

  it('rejects hostile input: non-string cookie entry', () => {
    expect(() =>
      invokeTool(analyzeCookieFlagsTool, { setCookieHeaders: [42] })
    ).toThrow(ToolInputError)
  })

  it('rejects hostile input: responseHeaders with non-string value', () => {
    expect(() =>
      invokeTool(analyzeCookieFlagsTool, {
        setCookieHeaders: [],
        responseHeaders: { 'X-Thing': 123 }
      })
    ).toThrow(ToolInputError)
  })

  it('rejects hostile input: missing setCookieHeaders', () => {
    expect(() => invokeTool(analyzeCookieFlagsTool, {})).toThrow(ToolInputError)
  })
})
