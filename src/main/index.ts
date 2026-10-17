import { app, shell, BrowserWindow, ipcMain } from 'electron'
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
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

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
