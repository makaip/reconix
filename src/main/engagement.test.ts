import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadScopeChecker } from './engagement'

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
