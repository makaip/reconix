import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createActiveOriginScopeChecker, loadScopeChecker, loadScopeConfig, toScopeStatus } from './engagement'

const dir = mkdtempSync(join(tmpdir(), 'reconix-scope-'))
const write = (name: string, contents: string): string => {
  const p = join(dir, name)
  writeFileSync(p, contents)
  return p
}

describe('loadScopeChecker', () => {
  it('denies all when no path is given', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(loadScopeChecker(undefined).isAllowed('https://anything/')).toBe(false)
  })

  it('denies all on a missing file', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(loadScopeChecker(join(dir, 'nope.json')).isAllowed('https://x/')).toBe(false)
  })

  it('denies all on malformed JSON', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const p = write('bad.json', '{ not json')
    expect(loadScopeChecker(p).isAllowed('https://x/')).toBe(false)
  })

  it('denies all when the shape is wrong', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const p = write('wrong.json', JSON.stringify({ engagementId: 'e' }))
    expect(loadScopeChecker(p).isAllowed('https://x/')).toBe(false)
  })

  it('honors a valid scope: in-scope allowed, out-of-scope denied', () => {
    const p = write(
      'ok.json',
      JSON.stringify({ engagementId: 'e', infra: [], targets: [{ host: 'target.local' }] })
    )
    const checker = loadScopeChecker(p)
    expect(checker.isAllowed('https://target.local/')).toBe(true)
    expect(checker.isAllowed('https://evil.example/')).toBe(false)
  })
})

describe('createActiveOriginScopeChecker', () => {
  it('allows only the active origin and its loopback alias', () => {
    let active: string | null = 'http://localhost:9090/page'
    const checker = createActiveOriginScopeChecker(() => active)
    expect(checker.isAllowed('http://localhost:9090/get_config', 'GET')).toBe(true)
    expect(checker.isAllowed('http://127.0.0.1:9090/get_config', 'GET')).toBe(true)
    expect(checker.isAllowed('http://localhost:8080/get_config', 'GET')).toBe(false)
    expect(checker.isAllowed('https://localhost:9090/get_config', 'GET')).toBe(false)
    expect(checker.isAllowed('http://example.com:9090/get_config', 'GET')).toBe(false)
    active = null
    expect(checker.isAllowed('http://localhost:9090/get_config', 'GET')).toBe(false)
  })
})

describe('loadScopeConfig + toScopeStatus', () => {
  it('returns null when no path is set or the shape is wrong', () => {
    expect(loadScopeConfig(undefined)).toBeNull()
    expect(loadScopeConfig(write('bad-shape.json', JSON.stringify({ engagementId: 'e' })))).toBeNull()
  })

  it('projects a valid config to host patterns + a summary', () => {
    const p = write(
      'status.json',
      JSON.stringify({
        engagementId: 'e',
        infra: [{ host: 'model.internal' }],
        targets: [{ host: 'app.local' }, { host: '*.app.local' }, { cidr: '10.0.0.0/24' }]
      })
    )
    expect(toScopeStatus(loadScopeConfig(p))).toEqual({
      hosts: ['app.local', '*.app.local'],
      summary: '2 hosts · 3 rules'
    })
  })

  it('shows none when no scope is loaded', () => {
    expect(toScopeStatus(null)).toEqual({ hosts: [], summary: 'none' })
  })
})
