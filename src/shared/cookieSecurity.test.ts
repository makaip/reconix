import { describe, expect, it } from 'vitest'
import {
  COOKIE_SEVERITY_ORDER,
  analyzeCookie,
  analyzeCookieList,
  isActionableSeverity
} from './cookieSecurity'

describe('shared cookieSecurity', () => {
  it('flags missing Secure/HttpOnly/SameSite on a bare cookie', () => {
    const findings = analyzeCookie({ secure: false, httpOnly: false, sameSite: null })
    expect(findings.map((f) => f.severity)).toEqual(['medium', 'medium', 'low'])
    expect(findings.some((f) => f.message.includes('Secure'))).toBe(true)
    expect(findings.some((f) => f.message.includes('HttpOnly'))).toBe(true)
    expect(findings.some((f) => f.message.includes('Missing SameSite'))).toBe(true)
  })

  it('treats SameSite=None without Secure as high severity', () => {
    const findings = analyzeCookie({ secure: false, httpOnly: true, sameSite: 'None' })
    expect(
      findings.some((f) => f.severity === 'high' && f.message.includes('SameSite=None'))
    ).toBe(true)
  })

  it('yields only info advisories for a fully-flagged cookie', () => {
    const findings = analyzeCookie({ secure: true, httpOnly: true, sameSite: 'Strict' })
    expect(findings).toHaveLength(1)
    expect(findings.every((f) => f.severity === 'info')).toBe(true)
    expect(findings.every((f) => !isActionableSeverity(f.severity))).toBe(true)
  })

  it('handles SameSite case-insensitively and flags unrecognized values', () => {
    expect(analyzeCookie({ secure: true, httpOnly: true, sameSite: 'lAx' })[0].severity).toBe(
      'info'
    )
    const unrecognized = analyzeCookie({ secure: true, httpOnly: true, sameSite: 'weird' })
    expect(unrecognized.some((f) => f.severity === 'low' && f.message.includes('weird'))).toBe(true)
  })

  it('treats an undefined sameSite as missing', () => {
    const findings = analyzeCookie({ secure: true, httpOnly: true })
    expect(findings.some((f) => f.message.includes('Missing SameSite'))).toBe(true)
  })

  it('analyzeCookieList tags findings with the cookie name', () => {
    const findings = analyzeCookieList([
      { name: 'a', secure: false, httpOnly: false, sameSite: 'Lax' },
      { name: 'b', secure: true, httpOnly: true, sameSite: 'Strict' }
    ])
    expect(findings.filter((f) => f.cookie === 'a')).toHaveLength(3)
    expect(findings.filter((f) => f.cookie === 'b')).toHaveLength(1)
    expect(findings.find((f) => f.cookie === 'b')?.severity).toBe('info')
  })

  it('orders severities most-severe first', () => {
    expect(COOKIE_SEVERITY_ORDER.high).toBeLessThan(COOKIE_SEVERITY_ORDER.medium)
    expect(COOKIE_SEVERITY_ORDER.medium).toBeLessThan(COOKIE_SEVERITY_ORDER.low)
    expect(COOKIE_SEVERITY_ORDER.low).toBeLessThan(COOKIE_SEVERITY_ORDER.info)
  })
})
