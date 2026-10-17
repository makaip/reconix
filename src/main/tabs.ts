import { BrowserWindow, WebContents, WebContentsView, ipcMain, session } from 'electron'
import type { NavigateResult, TabInfo, TabsState } from '../shared/tabs'

export const TARGET_PARTITION = 'target'

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])
const PAGE_BACKGROUND = '#ffffff'
const BLANK = 'about:blank'

type Bounds = { x: number; y: number; width: number; height: number }
type Tab = { id: number; view: WebContentsView }

export type TabHooks = {
  /** Called whenever the active tab (and so the inspected page) changes. */
  onActiveChanged: (target: WebContents | null, tabId: number) => void
  onTabClosed: (tabId: number) => void
  /** Awaited before a real navigation (tabs:navigate) proceeds — lets the
   *  Copilot engine (opencode serve + MCP) finish booting before a target
   *  site loads, so the DOM-parser watcher isn't racing a cold start the
   *  moment the page settles. Never blocks forever: the bridge resolves
   *  this even on engine failure, it just won't have browser tools yet. */
  beforeNavigate?: () => Promise<unknown>
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
    hooks.onActiveChanged(tab.view.webContents, tab.id)
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
    order = order.filter((tabId) => tabId !== id)
    tabs.delete(id)
    win.contentView.removeChildView(tab.view)
    tab.view.webContents.close()
    hooks.onTabClosed(id)

    if (order.length === 0) create()
    else if (activeId === id) activate(order[Math.min(index, order.length - 1)])
    else emitState()
  }

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
    await hooks.beforeNavigate?.()
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
