import { describe, expect, it } from 'vitest'
import type { CapturedRequest } from '../../../shared/tabs'
import { buildSitemap } from './sitemap'

const req = (url: string): CapturedRequest => ({
  id: url,
  tabId: 1,
  method: 'GET',
  url,
  resourceType: 'xhr',
  startedAt: 0
})

describe('buildSitemap', () => {
  it('groups by host and nests path segments', () => {
    const nodes = buildSitemap([
      req('https://app.test/login'),
      req('https://app.test/api/v1/users'),
      req('https://app.test/api/v1/orders')
    ])
    expect(nodes).toEqual([
      { id: 'app.test', label: 'app.test', depth: 0, kind: 'folder' },
      { id: 'app.test/api', label: '/api', depth: 1, kind: 'folder' },
      { id: 'app.test/api/v1', label: '/v1', depth: 2, kind: 'folder' },
      { id: 'app.test/api/v1/orders', label: '/orders', depth: 3, kind: 'page' },
      { id: 'app.test/api/v1/users', label: '/users', depth: 3, kind: 'page' },
      { id: 'app.test/login', label: '/login', depth: 1, kind: 'page' }
    ])
  })

  it('dedupes repeated URLs and marks a prefix both endpoint and folder as folder', () => {
    const nodes = buildSitemap([req('https://a/x'), req('https://a/x'), req('https://a/x/y')])
    expect(nodes.filter((n) => n.id === 'a/x')).toHaveLength(1)
    expect(nodes.find((n) => n.id === 'a/x')?.kind).toBe('folder')
  })

  it('skips malformed URLs and sorts hosts alphabetically', () => {
    const nodes = buildSitemap([req('https://b/'), req('not a url'), req('https://a/')])
    expect(nodes.map((n) => n.id)).toEqual(['a', 'b'])
  })
})
