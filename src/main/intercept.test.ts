import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { InterceptRule } from '../shared/tabs'
import type { InspectorSend } from './inspector'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const sent: Array<{ channel: string; payload: unknown }> = []
const sender = {
  id: 1,
  isDestroyed: () => false,
  send: (channel: string, payload: unknown) => sent.push({ channel, payload })
}
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) =>
      handlers.set(channel, (...args: unknown[]) => fn({ sender }, ...args)),
    removeHandler: (channel: string) => handlers.delete(channel)
  }
}))

import { applyRules, createInterceptor } from './intercept'

const makeWin = (): BrowserWindow =>
  ({ isDestroyed: () => false, webContents: sender, on: () => undefined }) as unknown as BrowserWindow
const call = <T>(channel: string, ...args: unknown[]): T => handlers.get(channel)!(...args) as T

const rule = (over: Partial<InterceptRule>): InterceptRule => ({
  id: 'r', enabled: true, name: 'n', urlPattern: '', header: 'X', action: 'set', value: 'v', ...over
})

beforeEach(() => {
  handlers.clear()
  sent.length = 0
})

describe('applyRules', () => {
  it('sets a new header and reports change', () => {
    const { headers, changed } = applyRules([rule({ header: 'Authorization', value: 'Bearer x' })], 'https://a/', {})
    expect(headers.Authorization).toBe('Bearer x')
    expect(changed).toBe(true)
  })

  it('replaces an existing header case-insensitively on its own key', () => {
    const { headers } = applyRules(
      [rule({ header: 'authorization', value: 'new' })],
      'https://a/',
      { Authorization: 'old' }
    )
    expect(headers).toEqual({ Authorization: 'new' })
  })

  it('removes a header', () => {
    const { headers, changed } = applyRules(
      [rule({ action: 'remove', header: 'Cookie', value: undefined })],
      'https://a/',
      { Cookie: 'sid=1' }
    )
    expect(headers.Cookie).toBeUndefined()
    expect(changed).toBe(true)
  })

  it('skips disabled rules and non-matching urlPattern', () => {
    expect(applyRules([rule({ enabled: false })], 'https://a/', {}).changed).toBe(false)
    expect(applyRules([rule({ urlPattern: 'admin' })], 'https://a/public', {}).changed).toBe(false)
  })

  it('reports no change when set value already matches', () => {
    expect(applyRules([rule({ header: 'X', value: 'v' })], 'https://a/', { X: 'v' }).changed).toBe(false)
  })
})

describe('createInterceptor Fetch lifecycle', () => {
  it('enables Fetch only once an enabled rule exists, disables when gone', () => {
    const { sink } = createInterceptor(makeWin())
    const send = vi.fn().mockResolvedValue(undefined)
    sink.onAttached(send as unknown as InspectorSend)
    expect(send).not.toHaveBeenCalled() // no rules yet

    const created = call<InterceptRule>('intercept:save', { name: 'n', urlPattern: '', header: 'X', action: 'set', value: 'v' })
    expect(send).toHaveBeenCalledWith('Fetch.enable', { patterns: [{ requestStage: 'Request' }] })

    call('intercept:delete', created.id)
    expect(send).toHaveBeenCalledWith('Fetch.disable')
  })

  it('re-enables Fetch on re-attach if rules exist, and reset clears the send', () => {
    const { sink } = createInterceptor(makeWin())
    call('intercept:save', { name: 'n', urlPattern: '', header: 'X', action: 'set', value: 'v' })
    const send = vi.fn().mockResolvedValue(undefined)
    sink.onAttached(send as unknown as InspectorSend)
    expect(send).toHaveBeenCalledWith('Fetch.enable', expect.anything())

    sink.reset()
    const after = vi.fn().mockResolvedValue(undefined)
    // After reset there is no send; a paused event must not throw and uses the event's own send.
    sink.handleFetchEvent(
      'Fetch.requestPaused',
      { requestId: 'q', request: { url: 'https://a/', method: 'GET', headers: {} } },
      after as unknown as InspectorSend
    )
    // Rules persist across reset, so the still-enabled rule applies on the next target.
    expect(after).toHaveBeenCalledWith('Fetch.continueRequest', {
      requestId: 'q',
      headers: [{ name: 'X', value: 'v' }]
    })
  })

  it('always continues a paused request — with overridden headers on match', () => {
    const { sink } = createInterceptor(makeWin())
    call('intercept:save', { name: 'n', urlPattern: '', header: 'Authorization', action: 'set', value: 'Bearer z' })
    const send = vi.fn().mockResolvedValue(undefined)
    sink.handleFetchEvent(
      'Fetch.requestPaused',
      { requestId: 'q1', request: { url: 'https://a/', method: 'GET', headers: {} } },
      send as unknown as InspectorSend
    )
    const [, arg] = send.mock.calls[0]
    expect(send.mock.calls[0][0]).toBe('Fetch.continueRequest')
    expect(arg).toEqual({ requestId: 'q1', headers: [{ name: 'Authorization', value: 'Bearer z' }] })
  })

  it('continues plainly when no rule matches', () => {
    const { sink } = createInterceptor(makeWin())
    call('intercept:save', { name: 'n', urlPattern: 'admin', header: 'X', action: 'set', value: 'v' })
    const send = vi.fn().mockResolvedValue(undefined)
    sink.handleFetchEvent(
      'Fetch.requestPaused',
      { requestId: 'q2', request: { url: 'https://a/public', method: 'GET', headers: {} } },
      send as unknown as InspectorSend
    )
    expect(send).toHaveBeenCalledWith('Fetch.continueRequest', { requestId: 'q2' })
  })

  it('rejects malformed rules', () => {
    createInterceptor(makeWin())
    expect(call('intercept:save', { name: 'n', urlPattern: '', header: '', action: 'set', value: 'v' })).toBeNull()
    expect(call('intercept:save', { name: 'n', urlPattern: '', header: 'X', action: 'nope' })).toBeNull()
    expect(call('intercept:save', { name: 'n', urlPattern: '', header: 'X', action: 'set' })).toBeNull()
    expect(call('intercept:save', { name: 'n', urlPattern: '', header: 'X\r\nY', action: 'remove' })).toBeNull()
  })
})
