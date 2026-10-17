import { describe, expect, it } from 'vitest'
import { extractLinks, nextCrawlTargets } from './crawler'

const BASE = 'https://app.example.com/dir/page'

describe('extractLinks', () => {
  it('resolves relative and absolute anchors, strips fragments, sorts', () => {
    const html = `
      <a href="/a">a</a>
      <a href="sub/b">b</a>
      <a href="https://app.example.com/c#frag">c</a>
      <a href='https://other.example.com/d'>d</a>
    `
    const urls = extractLinks(html, BASE).map((c) => c.url)
    expect(urls).toEqual([
      'https://app.example.com/a',
      'https://app.example.com/c',
      'https://app.example.com/dir/sub/b',
      'https://other.example.com/d'
    ])
  })

  it('de-dupes identical resolved URLs (fragment-only differences collapse)', () => {
    const html = `<a href="/x">1</a><a href="/x#a">2</a><a href="/x#b">3</a>`
    expect(extractLinks(html, BASE)).toEqual([
      { url: 'https://app.example.com/x', source: 'anchor' }
    ])
  })

  it('drops non-navigational schemes and empty hrefs', () => {
    const html = `
      <a href="javascript:void(0)">js</a>
      <a href="mailto:a@b.com">mail</a>
      <a href="tel:+1">tel</a>
      <a href="#top">frag</a>
      <a href="">empty</a>
      <a href="data:text/html,x">data</a>
    `
    expect(extractLinks(html, BASE)).toEqual([])
  })

  it('ignores forms and resources unless includeResources is set', () => {
    const html = `
      <a href="/a">a</a>
      <form action="/submit"></form>
      <script src="/app.js"></script>
      <img src="/pic.png">
      <iframe src="/frame"></iframe>
    `
    expect(extractLinks(html, BASE).map((c) => c.url)).toEqual(['https://app.example.com/a'])

    const all = extractLinks(html, BASE, { includeResources: true })
    expect(all).toEqual([
      { url: 'https://app.example.com/a', source: 'anchor' },
      { url: 'https://app.example.com/app.js', source: 'resource' },
      { url: 'https://app.example.com/frame', source: 'resource' },
      { url: 'https://app.example.com/pic.png', source: 'resource' },
      { url: 'https://app.example.com/submit', source: 'form' }
    ])
  })

  it('handles unquoted and single-quoted attribute values', () => {
    const html = `<a href=/bare>x</a><a href='/single'>y</a>`
    expect(extractLinks(html, BASE).map((c) => c.url)).toEqual([
      'https://app.example.com/bare',
      'https://app.example.com/single'
    ])
  })

  it('returns [] for HTML with no links', () => {
    expect(extractLinks('<p>nothing here</p>', BASE)).toEqual([])
  })
})

describe('nextCrawlTargets', () => {
  const sameOrigin = (url: string): boolean => url.startsWith('https://app.example.com/')

  it('keeps only scope-allowed URLs', () => {
    const html = `<a href="/in">in</a><a href="https://evil.example.com/out">out</a>`
    expect(nextCrawlTargets(html, BASE, sameOrigin).map((c) => c.url)).toEqual([
      'https://app.example.com/in'
    ])
  })

  it('excludes already-seen URLs', () => {
    const html = `<a href="/a">a</a><a href="/b">b</a>`
    const seen = ['https://app.example.com/a']
    expect(nextCrawlTargets(html, BASE, sameOrigin, { seen }).map((c) => c.url)).toEqual([
      'https://app.example.com/b'
    ])
  })

  it('caps the frontier at limit', () => {
    const html = ['/a', '/b', '/c', '/d'].map((p) => `<a href="${p}">x</a>`).join('')
    expect(nextCrawlTargets(html, BASE, sameOrigin, { limit: 2 })).toHaveLength(2)
  })

  it('is deterministic: same input yields the same ordered output', () => {
    const html = `<a href="/c">c</a><a href="/a">a</a><a href="/b">b</a>`
    const a = nextCrawlTargets(html, BASE, sameOrigin)
    const b = nextCrawlTargets(html, BASE, sameOrigin)
    expect(a).toEqual(b)
    expect(a.map((c) => c.url)).toEqual([
      'https://app.example.com/a',
      'https://app.example.com/b',
      'https://app.example.com/c'
    ])
  })

  it('a deny-all scope yields no targets', () => {
    const html = `<a href="/a">a</a>`
    expect(nextCrawlTargets(html, BASE, () => false)).toEqual([])
  })
})
