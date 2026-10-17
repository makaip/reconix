import { BrowserWindow, WebContents, WebContentsView, ipcMain, session } from 'electron'
import type { NavigateResult, TabInfo, TabsState } from '../shared/tabs'

export const TARGET_PARTITION = 'target'

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])
const PAGE_BACKGROUND = '#ffffff'
const BLANK = 'about:blank'
const MAX_CLOSED = 25

type Bounds = { x: number; y: number; width: number; height: number }
type Tab = { id: number; view: WebContentsView }

export type TabHooks = {
  /** Called whenever the active tab (and so the inspected page) changes. */
  onActiveChanged: (target: WebContents | null) => void
  onTabClosed: (tabId: number) => void
}

export type TabManager = {
  tabIdFor: (webContentsId: number) => number | undefined
}

function isBounds(value: unknown): value is Bounds {
  if (typeof value !== 'object' || value === null) return false
  const b = value as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every(
    (key) => typeof b[key] === 'number' && Number.isFinite(b[key])
  )
}

/** Turns address-bar input into a URL: bare hosts get https:// (http:// for local hosts). */
export function parseAddress(input: string): URL | null {
  const text = input.trim()
  if (!text) return null
  const hasScheme =
    /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ||
    /^(about|data|file|javascript|blob|view-source|chrome|devtools):/i.test(text)
  const isLocal = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(text)
  try {
    return new URL(hasScheme ? text : `${isLocal ? 'http' : 'https'}://${text}`)
  } catch {
    return null
  }
}

/**
 * Owns the sandboxed web views that render target sites, one per tab. Targets get no
 * preload and no Node access, and share an in-memory session so their cookies never
 * touch the app. Only the active tab's view is visible, sized to the renderer's page slot.
 */
export function createTabManager(win: BrowserWindow, hooks: TabHooks): TabManager {
  const ses = session.fromPartition(TARGET_PARTITION)
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))

  const tabs = new Map<number, Tab>()
  let order: number[] = []
  let activeId: number | null = null
  let nextId = 1
  // URLs of recently closed tabs, newest last, for reopen-closed-tab
  const closed: string[] = []
  let bounds: Bounds = { x: 0, y: 0, width: 0, height: 0 }

  const describe = ({ id, view }: Tab): TabInfo => {
    const url = view.webContents.getURL()
    return {
      id,
      // a blank tab reports its URL as its title, which the UI would show verbatim
      title: url === BLANK ? '' : view.webContents.getTitle(),
      url: url === BLANK ? '' : url,
      loading: view.webContents.isLoading()
    }
  }

  const getState = (): TabsState => {
    const active = activeId === null ? undefined : tabs.get(activeId)
    const history = active?.view.webContents.navigationHistory
    return {
      tabs: order.flatMap((id) => (tabs.has(id) ? [describe(tabs.get(id)!)] : [])),
      activeId,
      canGoBack: history?.canGoBack() ?? false,
      canGoForward: history?.canGoForward() ?? false
    }
  }

  const emitState = (): void => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('tabs:state', getState())
    }
  }

  const applyBounds = (): void => {
    // Renderer measures in CSS px; native bounds are DIP, so account for app zoom.
    const zoom = win.webContents.getZoomFactor()
    const scaled = {
      x: Math.round(bounds.x * zoom),
      y: Math.round(bounds.y * zoom),
      width: Math.max(0, Math.round(bounds.width * zoom)),
      height: Math.max(0, Math.round(bounds.height * zoom))
    }
    for (const tab of tabs.values()) tab.view.setBounds(scaled)
  }

  function activate(id: number): void {
    const tab = tabs.get(id)
    if (!tab) return
    activeId = id
    for (const other of tabs.values()) other.view.setVisible(other.id === id)
    win.contentView.addChildView(tab.view) // re-adding moves the view to the top
    applyBounds()
    hooks.onActiveChanged(tab.view.webContents)
    emitState()
  }

  function create(url?: string): number {
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: TARGET_PARTITION
      }
    })
    view.setBackgroundColor(PAGE_BACKGROUND)
    view.setVisible(false)
    win.contentView.addChildView(view)

    const id = nextId++
    const { webContents } = view
    tabs.set(id, { id, view })
    order.push(id)

    webContents.on('before-input-event', onShortcut)
    webContents.setWindowOpenHandler(({ url: target }) => {
      const parsed = parseAddress(target)
      if (parsed && ALLOWED_PROTOCOLS.has(parsed.protocol)) create(parsed.href)
      return { action: 'deny' }
    })
    for (const event of [
      'page-title-updated',
      'did-navigate',
      'did-navigate-in-page',
      'did-start-loading',
      'did-stop-loading'
    ] as const) {
      // Typed overloads differ per event; the handlers ignore their arguments.
      ;(webContents as Electron.WebContents).on(event as 'did-stop-loading', emitState)
    }

    activate(id)
    webContents.loadURL(url ?? BLANK).catch(() => {
      // Aborted or failed loads surface through tab state, not as errors here.
    })
    return id
  }

  function close(id: number): void {
    const tab = tabs.get(id)
    if (!tab) return
    const index = order.indexOf(id)
    const url = tab.view.webContents.getURL()
    if (url && url !== BLANK) {
      closed.push(url)
      if (closed.length > MAX_CLOSED) closed.shift()
    }
    order = order.filter((tabId) => tabId !== id)
    tabs.delete(id)
    win.contentView.removeChildView(tab.view)
    tab.view.webContents.close()
    hooks.onTabClosed(id)

    if (order.length === 0) create()
    else if (activeId === id) activate(order[Math.min(index, order.length - 1)])
    else emitState()
  }

  function move(id: number, toIndex: number): void {
    const from = order.indexOf(id)
    if (from === -1) return
    const rest = order.filter((tabId) => tabId !== id)
    const to = Math.max(0, Math.min(Math.round(toIndex), rest.length))
    rest.splice(to, 0, id)
    order = rest
    emitState()
  }

  // activates the tab `step` places from the active one, wrapping around
  function cycle(step: number): void {
    if (activeId === null || order.length < 2) return
    const index = order.indexOf(activeId)
    activate(order[(index + step + order.length) % order.length])
  }

  /**
   * Browser tab shortcuts. Runs for the app shell and every tab's page, since keys typed into
   * a page go to that page's webContents rather than the shell. Cmd on macOS, Ctrl elsewhere.
   */
  function onShortcut(event: Electron.Event, input: Electron.Input): void {
    if (input.type !== 'keyDown') return
    const mod = process.platform === 'darwin' ? input.meta : input.control
    let handled = true
    if (input.control && input.code === 'Tab') cycle(input.shift ? -1 : 1)
    else if (!mod || input.alt) handled = false
    else if (input.code === 'KeyT' && input.shift) {
      const url = closed.pop()
      if (url) create(url)
    } else if (input.code === 'KeyT') create()
    else if (input.code === 'KeyW' && input.shift) win.close()
    else if (input.code === 'KeyW') {
      if (activeId !== null) close(activeId)
    } else if (/^Digit[1-9]$/.test(input.code) && !input.shift) {
      const digit = Number(input.code.slice(5))
      const id = digit === 9 ? order[order.length - 1] : order[digit - 1]
      if (id !== undefined) activate(id)
    } else handled = false
    if (handled) event.preventDefault()
  }
  win.webContents.on('before-input-event', onShortcut)

  const activeContents = (): WebContents | undefined =>
    activeId === null ? undefined : tabs.get(activeId)?.view.webContents

  const handle = (channel: string, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, ...args) => {
      if (event.sender !== win.webContents) return null
      return fn(...args)
    })
  }

  handle('target:set-bounds', (value) => {
    if (!isBounds(value)) return
    bounds = value
    applyBounds()
  })
  handle('tabs:get-state', () => getState())
  handle('tabs:create', (url) => create(typeof url === 'string' ? (parseAddress(url)?.href ?? undefined) : undefined))
  handle('tabs:close', (id) => {
    if (typeof id === 'number') close(id)
  })
  handle('tabs:activate', (id) => {
    if (typeof id === 'number') activate(id)
  })
  handle('tabs:move', (id, toIndex) => {
    if (typeof id === 'number' && typeof toIndex === 'number' && Number.isFinite(toIndex)) move(id, toIndex)
  })
  handle('tabs:back', () => activeContents()?.navigationHistory.goBack())
  handle('tabs:forward', () => activeContents()?.navigationHistory.goForward())
  handle('tabs:reload', () => activeContents()?.reload())
  handle('tabs:navigate', async (input): Promise<NavigateResult> => {
    const parsed = parseAddress(String(input))
    if (!parsed) return { ok: false, error: 'Invalid URL' }
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      return { ok: false, error: `Unsupported protocol ${parsed.protocol}` }
    }
    const contents = activeContents()
    if (!contents) return { ok: false, error: 'No active tab' }
    try {
      await contents.loadURL(parsed.href)
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // ERR_ABORTED is a superseded navigation (redirect, quick re-submit), not a failure.
      return message.includes('ERR_ABORTED') ? { ok: true } : { ok: false, error: message }
    }
  })

  win.on('closed', () => {
    for (const channel of [
      'target:set-bounds',
      'tabs:get-state',
      'tabs:create',
      'tabs:close',
      'tabs:activate',
      'tabs:move',
      'tabs:back',
      'tabs:forward',
      'tabs:reload',
      'tabs:navigate'
    ]) {
      ipcMain.removeHandler(channel)
    }
    for (const tab of tabs.values()) {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    }
  })

  create()

  return {
    tabIdFor: (webContentsId) =>
      [...tabs.values()].find((tab) => tab.view.webContents.id === webContentsId)?.id
  }
}
