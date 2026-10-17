import { describe, expect, it } from 'vitest'
import type { CapturedRequest } from '../../../shared/tabs'
import { queryRequests, responseBytes } from './requestQuery'

const req = (over: Partial<CapturedRequest>): CapturedRequest => ({
  id: Math.random().toString(),
  tabId: 1,
  method: 'GET',
  url: 'https://app.test/',
  resourceType: 'xhr',
  startedAt: 0,
  ...over
})

const sample: CapturedRequest[] = [
  req({ url: 'https://app.test/login', method: 'POST', statusCode: 200 }),
  req({ url: 'https://api.test/users?id=1', statusCode: 404 }),
  req({ url: 'https://app.test/admin', statusCode: 500, responseHeaders: { 'Content-Length': ['5000'] } })
]

describe('queryRequests', () => {
  it('filters by host substring', () => {
    expect(queryRequests(sample, { host: 'api' }).map((r) => r.url)).toEqual([
      'https://api.test/users?id=1'
    ])
  })

  it('filters by method and exact status', () => {
    expect(queryRequests(sample, { method: 'post' })).toHaveLength(1)
    expect(queryRequests(sample, { status: '404' })).toHaveLength(1)
  })

  it('filters by status class', () => {
    expect(queryRequests(sample, { status: '5xx' }).map((r) => r.statusCode)).toEqual([500])
  })

  it('filters by url regex, matching nothing on an invalid pattern', () => {
    expect(queryRequests(sample, { urlRegex: 'adm.n' })).toHaveLength(1)
    expect(queryRequests(sample, { urlRegex: '(' })).toHaveLength(0)
  })

  it('filters by query-param presence', () => {
    expect(queryRequests(sample, { param: 'id' })).toHaveLength(1)
  })

  it('filters by response size bounds, excluding requests with no Content-Length', () => {
    expect(queryRequests(sample, { minBytes: 1000 }).map((r) => r.statusCode)).toEqual([500])
    expect(queryRequests(sample, { maxBytes: 100 })).toHaveLength(0)
  })

  it('AND-combines fields', () => {
    expect(queryRequests(sample, { host: 'app', status: '2xx' })).toHaveLength(1)
    expect(queryRequests(sample, { host: 'app', status: '404' })).toHaveLength(0)
  })

  it('responseBytes reads Content-Length case-insensitively', () => {
    expect(responseBytes(req({ responseHeaders: { 'content-length': ['42'] } }))).toBe(42)
    expect(responseBytes(req({}))).toBeUndefined()
  })
})
