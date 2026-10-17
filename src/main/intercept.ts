import { BrowserWindow, ipcMain } from 'electron'
import type { InspectorSend, InterceptSink } from './inspector'
import type { InterceptRule, SaveInterceptRuleInput } from '../shared/tabs'

const MAX_RULES = 100

/** CDP Fetch.requestPaused payload (request stage only — we never pause responses). */
type RequestPausedParams = {
  requestId: string
  request: { url: string; method: string; headers: Record<string, string> }
}

export type Interceptor = { sink: InterceptSink; close: () => void }

let seq = 1
const newId = (): string => `rule-${Date.now().toString(36)}-${seq++}`

/** Applies enabled rules to a header map, returning the new map and whether anything changed. */
export function applyRules(
  rules: InterceptRule[],
  url: string,
  headers: Record<string, string>
): { headers: Record<string, string>; changed: boolean } {
  // Work on a case-preserving copy; CDP hands us the request's own header casing.
  const out: Record<string, string> = { ...headers }
  let changed = false
  for (const rule of rules) {
    if (!rule.enabled) continue
    if (rule.urlPattern && !url.includes(rule.urlPattern)) continue
    // Match the target header case-insensitively; act on the existing key if present.
    const existingKey = Object.keys(out).find((k) => k.toLowerCase() === rule.header.toLowerCase())
    if (rule.action === 'remove') {
      if (existingKey !== undefined) {
        delete out[existingKey]
        changed = true
      }
    } else {
      const key = existingKey ?? rule.header
      if (out[key] !== rule.value) {
        out[key] = rule.value ?? ''
        changed = true
      }
    }
  }
  return { headers: out, changed }
}

function normalizeRule(raw: unknown): SaveInterceptRuleInput | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.name !== 'string' || r.name.length > 200) return null
  if (typeof r.urlPattern !== 'string' || r.urlPattern.length > 2000) return null
  if (typeof r.header !== 'string' || !r.header || r.header.length > 200) return null
  if (r.action !== 'set' && r.action !== 'remove') return null
  if (/[\r\n]/.test(r.header)) return null
  let value: string | undefined
  if (r.action === 'set') {
    if (typeof r.value !== 'string' || /[\r\n]/.test(r.value) || r.value.length > 4000) return null
    value = r.value
  }
  return {
    id: typeof r.id === 'string' ? r.id : undefined,
    name: r.name,
    urlPattern: r.urlPattern,
    header: r.header,
    action: r.action,
    value
  }
}

/**
 * Live request-header match/replace (ARCHITECTURE.MD §11.1, tier M). Rewrites
 * headers/tokens on in-flight requests of the inspected target over CDP Fetch.
 *
 * SAFETY INVARIANT: Fetch.enable pauses every matching request; a paused request
 * that is not continued hangs the page. So every Fetch.requestPaused is ALWAYS
 * continued — on match, on no-match, and even if applying a rule throws. Fetch is
 * enabled ONLY while at least one enabled rule exists, and disabled otherwise, so a
 * ruleless session pauses nothing. On target switch the debugger resets Fetch to
 * off; `onAttached` re-enables it if rules are present.
 */
export function createInterceptor(win: BrowserWindow): Interceptor {
  const rules = new Map<string, InterceptRule>()
  let send: InspectorSend | null = null
  let fetchEnabled = false

  const enabledRules = (): InterceptRule[] => [...rules.values()].filter((r) => r.enabled)
  const list = (): InterceptRule[] => [...rules.values()]

  const broadcast = (): void => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('intercept:changed', list())
    }
  }

  // Reconciles Fetch.enable/disable with whether any enabled rule exists.
  const syncFetch = (): void => {
    if (!send) return
    const want = enabledRules().length > 0
    if (want && !fetchEnabled) {
      void send('Fetch.enable', { patterns: [{ requestStage: 'Request' }] }).catch(() => undefined)
      fetchEnabled = true
    } else if (!want && fetchEnabled) {
      void send('Fetch.disable').catch(() => undefined)
      fetchEnabled = false
    }
  }

  const handleFetchEvent = (
    method: string,
    params: Record<string, unknown>,
    evSend: InspectorSend
  ): void => {
    if (method !== 'Fetch.requestPaused') return
    const { requestId, request } = params as unknown as RequestPausedParams
    // Resume no matter what; a dropped continue hangs the page.
    let override: { name: string; value: string }[] | undefined
    try {
      const { headers, changed } = applyRules(enabledRules(), request.url, request.headers ?? {})
      if (changed) override = Object.entries(headers).map(([name, value]) => ({ name, value }))
    } catch {
      override = undefined
    }
    void evSend('Fetch.continueRequest', {
      requestId,
      ...(override ? { headers: override } : {})
    }).catch(() => undefined)
  }

  const save = (raw: unknown): InterceptRule | null => {
    const input = normalizeRule(raw)
    if (!input) return null
    if (input.id) {
      const existing = rules.get(input.id)
      if (!existing) return null
      Object.assign(existing, {
        name: input.name,
        urlPattern: input.urlPattern,
        header: input.header,
        action: input.action,
        value: input.value
      })
      syncFetch()
      broadcast()
      return existing
    }
    if (rules.size >= MAX_RULES) return null
    const created: InterceptRule = {
      id: newId(),
      enabled: true,
      name: input.name,
      urlPattern: input.urlPattern,
      header: input.header,
      action: input.action,
      value: input.value
    }
    rules.set(created.id, created)
    syncFetch()
    broadcast()
    return created
  }

  const toggle = (id: unknown, enabled: unknown): InterceptRule | null => {
    if (typeof id !== 'string' || typeof enabled !== 'boolean') return null
    const rule = rules.get(id)
    if (!rule) return null
    rule.enabled = enabled
    syncFetch()
    broadcast()
    return rule
  }

  const remove = (id: unknown): boolean => {
    if (typeof id !== 'string') return false
    const had = rules.delete(id)
    if (had) {
      syncFetch()
      broadcast()
    }
    return had
  }

  const sink: InterceptSink = {
    handleFetchEvent,
    onAttached: (s) => {
      send = s
      fetchEnabled = false // fresh debugger session: Fetch starts disabled
      syncFetch()
    },
    reset: () => {
      send = null
      fetchEnabled = false
    }
  }

  const handle = (channel: string, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, ...args) =>
      event.sender === win.webContents ? fn(...args) : null
    )
  }
  handle('intercept:list', () => list())
  handle('intercept:save', (payload) => save(payload))
  handle('intercept:toggle', (id, enabled) => toggle(id, enabled))
  handle('intercept:delete', (id) => remove(id))

  const channels = ['intercept:list', 'intercept:save', 'intercept:toggle', 'intercept:delete']
  const close = (): void => {
    for (const c of channels) ipcMain.removeHandler(c)
  }
  win.on('closed', close)
  return { sink, close }
}
