import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({}))

import { parseAddress } from './tabs'

const href = (input: string): string | undefined => parseAddress(input)?.href

describe('parseAddress', () => {
  it('adds https:// to bare domains', () => {
    expect(href('google.com')).toBe('https://google.com/')
    expect(href('  example.com/path?q=1  ')).toBe('https://example.com/path?q=1')
  })

  it('adds http:// to local hosts', () => {
    expect(href('localhost')).toBe('http://localhost/')
    expect(href('localhost:3000')).toBe('http://localhost:3000/')
    expect(href('127.0.0.1:8080/api')).toBe('http://127.0.0.1:8080/api')
  })

  it('keeps explicit schemes', () => {
    expect(href('http://google')).toBe('http://google/')
    expect(href('about:blank')).toBe('about:blank')
  })

  it('rejects lone words and search phrases instead of searching', () => {
    expect(parseAddress('google')).toBeNull()
    expect(parseAddress('how to hack')).toBeNull()
    expect(parseAddress('example.com is down')).toBeNull()
    expect(parseAddress('   ')).toBeNull()
  })

  it('loads single-label internal hosts written unambiguously', () => {
    expect(href('jenkins/')).toBe('https://jenkins/')
    expect(href('jenkins:8080')).toBe('https://jenkins:8080/')
  })
})
