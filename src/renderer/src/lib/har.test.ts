import { describe, expect, it } from 'vitest'
import type { CapturedRequest } from '../../../shared/tabs'
import { fromHar, parsedHarToCaptured, toHar } from './har'

const req = (over: Partial<CapturedRequest>): CapturedRequest => ({
  id: '1',
  tabId: 1,
  method: 'GET',
  url: 'https://app.test/a?x=1',
  resourceType: 'xhr',
  startedAt: 1_700_000_000_000,
  ...over
})

describe('toHar', () => {
  it('produces a valid HAR 1.2 log with request/response fields', () => {
    const har = toHar([
      req({
        method: 'POST',
        statusCode: 201,
        durationMs: 42,
        requestHeaders: { 'X-Test': '1' },
        responseHeaders: { 'Content-Type': ['application/json'] }
      })
    ])
    expect(har.log.version).toBe('1.2')
    const entry = har.log.entries[0]
    expect(entry.request.method).toBe('POST')
    expect(entry.request.queryString).toEqual([{ name: 'x', value: '1' }])
    expect(entry.request.headers).toEqual([{ name: 'X-Test', value: '1' }])
    expect(entry.response.status).toBe(201)
    expect(entry.response.content.mimeType).toBe('application/json')
    expect(entry.time).toBe(42)
    expect(entry.startedDateTime).toBe(new Date(1_700_000_000_000).toISOString())
  })
})

describe('fromHar', () => {
  it('round-trips entries produced by toHar', () => {
    const har = toHar([req({ method: 'PUT', statusCode: 200, durationMs: 5, requestHeaders: { A: 'b' } })])
    const parsed = fromHar(har)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({
      method: 'PUT',
      url: 'https://app.test/a?x=1',
      status: 200,
      requestHeaders: { A: 'b' },
      durationMs: 5
    })
  })

  it('returns [] for non-HAR input and skips malformed entries', () => {
    expect(fromHar(null)).toEqual([])
    expect(fromHar({})).toEqual([])
    expect(fromHar({ log: { entries: 'nope' } })).toEqual([])
    expect(fromHar({ log: { entries: [{ request: { method: 'GET' } }, 42] } })).toEqual([])
  })
})

describe('parsedHarToCaptured', () => {
  it('maps parsed entries to CapturedRequest-shaped rows', () => {
    const har = toHar([
      req({
        method: 'POST',
        statusCode: 201,
        durationMs: 42,
        requestHeaders: { 'X-Test': '1' },
        responseHeaders: { 'Content-Type': ['application/json'] }
      })
    ])
    const out = parsedHarToCaptured(fromHar(har))
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      id: 'har-0',
      tabId: -1,
      method: 'POST',
      url: 'https://app.test/a?x=1',
      resourceType: 'imported',
      startedAt: 1_700_000_000_000,
      statusCode: 201,
      durationMs: 42,
      requestHeaders: { 'X-Test': '1' },
      responseHeaders: { 'Content-Type': ['application/json'] }
    })
  })

  it('uses the given tab index and derives positional ids', () => {
    const parsed = fromHar(toHar([req({ url: 'https://app.test/1' }), req({ url: 'https://app.test/2' })]))
    const out = parsedHarToCaptured(parsed, 3)
    expect(out.map((r) => r.id)).toEqual(['har-0', 'har-1'])
    expect(out.map((r) => r.tabId)).toEqual([3, 3])
  })

  it('offsets ids by startIndex so appended imports stay unique', () => {
    const parsed = fromHar(toHar([req({ url: 'https://app.test/1' }), req({ url: 'https://app.test/2' })]))
    const first = parsedHarToCaptured(parsed)
    const second = parsedHarToCaptured(parsed, undefined, first.length)
    const ids = [...first, ...second].map((r) => r.id)
    expect(ids).toEqual(['har-0', 'har-1', 'har-2', 'har-3'])
    expect(new Set(ids).size).toBe(ids.length)
    // tabIndex still defaults when startIndex is supplied positionally
    expect(second.map((r) => r.tabId)).toEqual([-1, -1])
  })

  it('returns [] for no entries and tolerates missing status/duration/headers', () => {
    expect(parsedHarToCaptured([])).toEqual([])
    const out = parsedHarToCaptured([
      { method: 'GET', url: 'https://app.test/z', requestHeaders: {}, responseHeaders: {}, startedAt: 0 }
    ])
    expect(out[0]).toMatchObject({
      id: 'har-0',
      statusCode: undefined,
      durationMs: undefined,
      responseHeaders: {},
      requestHeaders: {}
    })
  })
})
