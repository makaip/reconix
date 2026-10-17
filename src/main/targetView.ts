import { BrowserWindow, WebContentsView, ipcMain } from 'electron'

export type Bounds = { x: number; y: number; width: number; height: number }
export type NavigateResult = { ok: true } | { ok: false; error: string }

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])
const PAGE_BACKGROUND = '#f5f7fa'
const PAGE_RADIUS = 8

function isBounds(value: unknown): value is Bounds {
  if (typeof value !== 'object' || value === null) return false
  const b = value as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every(
    (key) => typeof b[key] === 'number' && Number.isFinite(b[key])
  )
}

// note that theres no preload node access and uses in memory sesision
export function createTargetView(win: BrowserWindow): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'target'
    }
  })

  const { webContents } = view
  webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  view.setBackgroundColor(PAGE_BACKGROUND)
  view.setBorderRadius(PAGE_RADIUS)
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
  win.contentView.addChildView(view)
  webContents.loadURL('about:blank')

  const fromApp = (sender: Electron.WebContents): boolean => sender === win.webContents

  ipcMain.removeHandler('target:set-bounds')
  ipcMain.handle('target:set-bounds', (event, bounds: unknown) => {
    if (!fromApp(event.sender) || !isBounds(bounds)) return
    // render measures in CSS px
    // also native bounds are DIP, so account for app zoom
    const zoom = win.webContents.getZoomFactor()
    view.setBounds({
      x: Math.round(bounds.x * zoom),
      y: Math.round(bounds.y * zoom),
      width: Math.max(0, Math.round(bounds.width * zoom)),
      height: Math.max(0, Math.round(bounds.height * zoom))
    })
  })

  ipcMain.removeHandler('target:navigate')
  ipcMain.handle('target:navigate', async (event, url: unknown): Promise<NavigateResult> => {
    if (!fromApp(event.sender)) return { ok: false, error: 'Untrusted sender' }
    let parsed: URL
    try {
      parsed = new URL(String(url))
    } catch {
      return { ok: false, error: 'Invalid URL' }
    }
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      return { ok: false, error: `Unsupported protocol ${parsed.protocol}` }
    }
    try {
      await webContents.loadURL(parsed.href)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  win.on('closed', () => {
    ipcMain.removeHandler('target:set-bounds')
    ipcMain.removeHandler('target:navigate')
    if (!webContents.isDestroyed()) webContents.close()
  })

  return view
}
