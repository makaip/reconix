import { describe, expect, it } from 'vitest'
import { proxyStatus } from './runtime'

describe('proxyStatus', () => {
  it('reports a configured address', () => {
    expect(proxyStatus({ RECONIX_PROXY_ADDR: '127.0.0.1:8080' })).toEqual({
      address: '127.0.0.1:8080'
    })
  })

  it('trims surrounding whitespace', () => {
    expect(proxyStatus({ RECONIX_PROXY_ADDR: '  proxy.internal:3128  ' })).toEqual({
      address: 'proxy.internal:3128'
    })
  })

  it('is null when unconfigured or blank', () => {
    expect(proxyStatus({})).toEqual({ address: null })
    expect(proxyStatus({ RECONIX_PROXY_ADDR: '   ' })).toEqual({ address: null })
  })
})
