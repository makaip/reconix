import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpOpenCodeTransport } from './transport'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

describe('MCP readiness before the first prompt', () => {
  it('waits through absent/pending MCP state before returning a usable session', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ data: { id: 's' } }))
      .mockResolvedValueOnce(json({ data: [] }))
      .mockResolvedValueOnce(json({ data: [{ name: 'reconix', status: { status: 'pending' } }] }))
      .mockResolvedValueOnce(json({ data: [{ name: 'reconix', status: { status: 'connected' } }] }))
    vi.stubGlobal('fetch', fetch)
    const transport = new HttpOpenCodeTransport({ baseUrl: 'http://localhost', password: 'test', requiredMcpServer: 'reconix' })
    const session = transport.createSession()
    await vi.advanceTimersByTimeAsync(200)
    await expect(session).resolves.toEqual({ id: 's' })
    expect(fetch.mock.calls.slice(1).every(([url]) => url.endsWith('/api/mcp'))).toBe(true)
  })

  it('does not add MCP polling to sessions that do not need browser tools', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ data: { id: 's' } }))
    vi.stubGlobal('fetch', fetch)
    await expect(new HttpOpenCodeTransport({ baseUrl: 'http://localhost', password: 'test' }).createSession()).resolves.toEqual({ id: 's' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('reports failed connections instead of proceeding without tools', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ data: { id: 's' } }))
      .mockResolvedValueOnce(json({ data: [{ name: 'reconix', status: { status: 'failed' } }] }))
    vi.stubGlobal('fetch', fetch)
    await expect(new HttpOpenCodeTransport({ baseUrl: 'http://localhost', password: 'test', requiredMcpServer: 'reconix' }).createSession()).rejects.toThrow('reconix is failed')
  })
})
