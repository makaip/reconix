import { describe, expect, it, vi } from 'vitest'
import { correlate_requests, extractCorrelations, type ImpactType } from './correlate_requests'
import { ToolInputError } from '../errors'
import type { ToolContext } from '../tool'
import type { CapturedRequest } from '../../../shared/tabs'

function req(id: string, overrides: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    id,
    tabId: 1,
    method: 'GET',
    url: 'https://app.example.com/',
    resourceType: 'xhr',
    startedAt: 1,
    ...overrides
  }
}

const ALL: ImpactType[] = ['reflection', 'token-leak', 'idor']

describe('correlate_requests parse', () => {
  it('rejects a missing baseRequestId', () => {
    expect(() => correlate_requests.parse({ parameterName: 'q', candidateRequestIds: ['2'] })).toThrow(
      ToolInputError
    )
  })

  it('rejects a missing/empty parameterName', () => {
    expect(() => correlate_requests.parse({ baseRequestId: '1', candidateRequestIds: ['2'] })).toThrow(
      ToolInputError
    )
    expect(() =>
      correlate_requests.parse({ baseRequestId: '1', parameterName: '', candidateRequestIds: ['2'] })
    ).toThrow(ToolInputError)
  })

  it('rejects a missing or empty candidateRequestIds', () => {
    expect(() => correlate_requests.parse({ baseRequestId: '1', parameterName: 'q' })).toThrow(
      ToolInputError
    )
    expect(() =>
      correlate_requests.parse({ baseRequestId: '1', parameterName: 'q', candidateRequestIds: [] })
    ).toThrow(ToolInputError)
  })

  it('rejects an unknown impactType and accepts the valid set', () => {
    expect(() =>
      correlate_requests.parse({
        baseRequestId: '1',
        parameterName: 'q',
        candidateRequestIds: ['2'],
        impactTypes: ['reflection', 'csrf']
      })
    ).toThrow(ToolInputError)

    const parsed = correlate_requests.parse({
      baseRequestId: '1',
      parameterName: 'q',
      candidateRequestIds: ['2'],
      impactTypes: ['idor']
    })
    expect(parsed.impactTypes).toEqual(['idor'])
  })
})

describe('extractCorrelations reflection', () => {
  it('flags a base query value that reappears in a candidate URL', () => {
    const base = req('1', { url: 'https://app.example.com/search?q=canary-abc-123' })
    const candidate = req('2', {
      url: 'https://app.example.com/render?next=canary-abc-123'
    })
    const out = extractCorrelations(base, [candidate], { parameterName: 'q' })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      id: 'corr_1',
      type: 'reflection',
      sourceRequestId: '1',
      targetRequestId: '2',
      parameter: 'q',
      confidence: 0.8
    })
    expect(out[0].evidence.urls).toEqual([base.url, candidate.url])
    expect(out[0].evidence.baseValue).toBe('canary-abc-123')
  })

  it('reads the parameter from a base request header (case-insensitive)', () => {
    const base = req('1', { requestHeaders: { 'X-Tenant': 'tenant-42' } })
    const candidate = req('2', { url: 'https://app.example.com/t/tenant-42/profile' })
    const out = extractCorrelations(base, [candidate], { parameterName: 'x-tenant' })
    expect(out.map((c) => c.type)).toEqual(['reflection'])
  })

  it('lowers confidence when the value only appears in a header', () => {
    const base = req('1', { url: 'https://app.example.com/a?q=canary-abc-123' })
    const candidate = req('2', {
      requestHeaders: { Referer: 'https://app.example.com/a?q=canary-abc-123' }
    })
    const out = extractCorrelations(base, [candidate], {
      parameterName: 'q',
      impactTypes: ['reflection']
    })
    expect(out).toHaveLength(1)
    expect(out[0].confidence).toBe(0.5)
    expect(out[0].description).toContain('Referer')
  })
})

describe('extractCorrelations token-leak', () => {
  it('flags a base Authorization value carried in a candidate header', () => {
    const base = req('1', {
      url: 'https://app.example.com/api/me',
      requestHeaders: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig' }
    })
    const candidate = req('2', {
      url: 'https://app.example.com/api/items',
      requestHeaders: { 'X-Debug-Auth': 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig' }
    })
    const out = extractCorrelations(base, [candidate], {
      parameterName: 'Authorization',
      impactTypes: ['token-leak']
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      type: 'token-leak',
      confidence: 0.9,
      targetRequestId: '2'
    })
    expect(out[0].evidence.candidateValue).toContain('X-Debug-Auth')
  })

  it('flags the same credential replayed to a different origin', () => {
    const base = req('1', {
      url: 'https://app.example.com/api/me',
      requestHeaders: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig' }
    })
    const candidate = req('2', {
      url: 'https://analytics.third-party.test/collect',
      requestHeaders: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig' }
    })
    const out = extractCorrelations(base, [candidate], {
      parameterName: 'Authorization',
      impactTypes: ['token-leak']
    })
    expect(out).toHaveLength(1)
    expect(out[0].description).toContain('cross-origin')
  })

  it('ignores normal same-origin session propagation', () => {
    const base = req('1', {
      url: 'https://app.example.com/api/me',
      requestHeaders: { Cookie: 'session=abcdef123456' }
    })
    const candidate = req('2', {
      url: 'https://app.example.com/api/items',
      requestHeaders: { Cookie: 'session=abcdef123456' }
    })
    const out = extractCorrelations(base, [candidate], {
      parameterName: 'Cookie',
      impactTypes: ['token-leak']
    })
    expect(out).toHaveLength(0)
  })
})

describe('extractCorrelations idor', () => {
  it('flags sequential numeric ids in the same path shape', () => {
    const base = req('1', { url: 'https://app.example.com/api/users/5/invoices?view=full' })
    const candidate = req('2', { url: 'https://app.example.com/api/users/6/invoices' })
    const out = extractCorrelations(base, [candidate], {
      parameterName: 'view',
      impactTypes: ['idor']
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      type: 'idor',
      confidence: 0.6,
      sourceRequestId: '1',
      targetRequestId: '2'
    })
    expect(out[0].evidence.baseValue).toBe('5')
    expect(out[0].evidence.candidateValue).toBe('6')
  })

  it('does not flag distant or differently-shaped ids', () => {
    const base = req('1', { url: 'https://app.example.com/api/users/5?view=full' })
    const far = req('2', { url: 'https://app.example.com/api/users/5000' })
    const differentShape = req('3', { url: 'https://app.example.com/api/orders/6' })
    const out = extractCorrelations(base, [far, differentShape], {
      parameterName: 'view',
      impactTypes: ['idor']
    })
    expect(out).toHaveLength(0)
  })
})

describe('extractCorrelations empty / error paths', () => {
  it('returns no correlations when nothing lines up', () => {
    const base = req('1', { url: 'https://app.example.com/a?q=canary-abc-123' })
    const candidate = req('2', { url: 'https://app.example.com/b?other=1' })
    expect(
      extractCorrelations(base, [candidate], { parameterName: 'q', impactTypes: ALL })
    ).toEqual([])
  })

  it('throws when the parameter is not present in the base request', () => {
    const base = req('1', { url: 'https://app.example.com/a?q=1' })
    expect(() => extractCorrelations(base, [req('2')], { parameterName: 'missing' })).toThrow(
      ToolInputError
    )
  })

  it('honours impactTypes filtering', () => {
    const base = req('1', { url: 'https://app.example.com/api/users/5?q=canary-abc-123' })
    const candidate = req('2', { url: 'https://app.example.com/api/users/6?next=canary-abc-123' })
    const out = extractCorrelations(base, [candidate], {
      parameterName: 'q',
      impactTypes: ['idor']
    })
    expect(out.map((c) => c.type)).toEqual(['idor'])
  })
})

describe('correlate_requests execute', () => {
  function ctxWith(entries: CapturedRequest[]): { ctx: ToolContext; save: ReturnType<typeof vi.fn> } {
    const save = vi.fn(async () => 'trace_abc')
    const ctx = {
      network: {
        list: () => entries,
        get: (id: string) => entries.find((e) => e.id === id)
      },
      traces: { save, get: () => null }
    } as unknown as ToolContext
    return { ctx, save }
  }

  const base = req('1', {
    url: 'https://app.example.com/search?q=canary-abc-123',
    requestHeaders: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig' }
  })
  const reflected = req('2', { url: 'https://app.example.com/render?next=canary-abc-123' })
  const leaked = req('3', {
    url: 'https://third-party.test/collect',
    requestHeaders: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig' }
  })

  it('returns correlations, a per-type summary and a rawRef', async () => {
    const { ctx, save } = ctxWith([base, reflected, leaked])
    const out = await correlate_requests.execute(
      {
        baseRequestId: '1',
        parameterName: 'q',
        candidateRequestIds: ['2', '3'],
        impactTypes: ['reflection', 'token-leak']
      },
      ctx
    )
    // ranked by confidence: token-leak (0.9) before reflection (0.8)
    expect(out.correlations.map((c) => c.type)).toEqual(['token-leak', 'reflection'])
    expect(out.summary).toEqual({
      total: 2,
      byType: { reflection: 1, 'token-leak': 1, idor: 0 }
    })
    expect(out.rawRef).toBe('trace_abc')
    expect(save).toHaveBeenCalledWith('trace', expect.any(String))
    const savedJson = JSON.parse(save.mock.calls[0][1] as string)
    expect(savedJson.parameterName).toBe('q')
    expect(savedJson.checked).toEqual(['2', '3'])
  })

  it('skips unknown candidate ids and notes them', async () => {
    const { ctx } = ctxWith([base, reflected])
    const out = await correlate_requests.execute(
      { baseRequestId: '1', parameterName: 'q', candidateRequestIds: ['2', 'ghost'] },
      ctx
    )
    expect(out.summary.total).toBe(1)
    expect(out.note).toContain('ghost')
  })

  it('throws for an unknown base request', async () => {
    const { ctx } = ctxWith([reflected])
    await expect(
      correlate_requests.execute(
        { baseRequestId: 'ghost', parameterName: 'q', candidateRequestIds: ['2'] },
        ctx
      )
    ).rejects.toBeInstanceOf(ToolInputError)
  })

  it('omits rawRef when no trace store is wired', async () => {
    const ctx = {
      network: {
        list: () => [base, reflected],
        get: (id: string) => [base, reflected].find((e) => e.id === id)
      }
    } as unknown as ToolContext
    const out = await correlate_requests.execute(
      { baseRequestId: '1', parameterName: 'q', candidateRequestIds: ['2'] },
      ctx
    )
    expect(out.rawRef).toBeUndefined()
    expect(out.summary.total).toBe(1)
  })
})
