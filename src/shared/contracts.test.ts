import { describe, expect, it } from 'vitest'
import { hostInScope } from './contracts'

describe('hostInScope', () => {
  it('matches exact hosts', () => {
    expect(hostInScope('app.local', ['app.local'])).toBe(true)
    expect(hostInScope('evil.local', ['app.local'])).toBe(false)
  })

  it('matches leading-wildcard patterns, including the apex', () => {
    expect(hostInScope('app.local', ['*.app.local'])).toBe(true)
    expect(hostInScope('api.app.local', ['*.app.local'])).toBe(true)
    expect(hostInScope('app.local.evil', ['*.app.local'])).toBe(false)
  })

  it('is false for an empty pattern set', () => {
    expect(hostInScope('app.local', [])).toBe(false)
  })
})
