import { describe, expect, it } from 'vitest'
import { detectLanguage, prettyPrint } from './sourceFormat'

describe('detectLanguage', () => {
  it('prefers the MIME type', () => {
    expect(detectLanguage({ url: 'https://a.test/x', type: 'Other', mimeType: 'application/json' })).toBe('json')
  })

  it('falls back to resource type, then extension', () => {
    expect(detectLanguage({ url: 'https://a.test/x', type: 'Script', mimeType: '' })).toBe('javascript')
    expect(detectLanguage({ url: 'https://a.test/a.css?v=1', type: 'Other', mimeType: '' })).toBe('css')
    expect(detectLanguage({ url: 'https://a.test/readme', type: 'Other', mimeType: '' })).toBe('plaintext')
  })
})

describe('prettyPrint', () => {
  it('formats minified JS and JSON', () => {
    expect(prettyPrint('function f(){return 1}', 'javascript')).toBe('function f() {\n  return 1\n}')
    expect(prettyPrint('{"a":[1]}', 'json')).toBe('{\n  "a": [\n    1\n  ]\n}')
  })

  it('returns unparseable input unchanged', () => {
    expect(prettyPrint('{not json', 'json')).toBe('{not json')
  })
})
