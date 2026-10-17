import { app, shell, BrowserWindow, ipcMain, session } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { attachInspector } from './inspector'
import { startNetworkCapture, type NetworkCapture } from './network'
import { createSessionManager } from './session'
import { createTabManager } from './tabs'

// keep in sync with --tabbar-height and --color-bg-deep in tokens.css
const TAB_BAR_HEIGHT = 40
const TAB_BAR_COLOR = '#18181a'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1b1b1c',
    // the tab bar is the title bar, so each OS draws its window controls over it
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 16, y: 13 } }
      : {
          titleBarOverlay: {
            color: TAB_BAR_COLOR,
            symbolColor: '#a0a0a6',
            height: TAB_BAR_HEIGHT
          }
        }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      // The UI window runs fully sandboxed: no Node in the renderer. The preload
      // (src/preload/index.ts) is sandbox-safe — it only pulls contextBridge +
      // ipcRenderer from require('electron'), both allowed in sandboxed preloads.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Strict CSP backstop for the UI window (default-src 'self', no 'unsafe-inline').
  // CSP split dev vs prod: the electron-vite dev server injects inline scripts/styles
  // and talks over ws: for HMR, which a no-'unsafe-inline' policy would break — so in
  // dev we rely on the looser <meta> CSP in src/renderer/index.html and add NO header.
  // In production we attach the strict policy here. It is applied via defaultSession,
  // which the UI window uses; the target WebContentsViews run on their own session
  // partition (TARGET_PARTITION in tabs.ts), so this never touches target pages.
  // data: is kept only for img/font because Vite inlines small SVG icons as data URIs;
  // it introduces no inline-script/style execution path.
  if (!is.dev) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self'; " +
              "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; " +
              "object-src 'none'; base-uri 'self'; frame-src 'none'"
          ]
        }
      })
    })
  }

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  let network: NetworkCapture | undefined
  const inspector = attachInspector(mainWindow)
  const tabs = createTabManager(mainWindow, {
    onActiveChanged: (target) => inspector.setTarget(target),
    onTabClosed: (tabId) => network?.forgetTab(tabId)
  })
  network = startNetworkCapture(mainWindow, tabs)
  createSessionManager(mainWindow)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.reconix.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('ping', () => 'pong')

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
