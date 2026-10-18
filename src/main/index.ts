import { app, shell, BrowserWindow, ipcMain, Menu, session, type MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { createBodyStore } from './bodies'
import { createCopilotBridge, type CopilotBridge } from './copilot'
import { createActiveOriginScopeChecker, loadScopeChecker } from './engagement'
import { attachInspector, combineNetworkSinks } from './inspector'
import { createInterceptor } from './intercept'
import { startNetworkCapture, type NetworkCapture } from './network'
import { createWebSocketCapture } from './websocket'
import { createCrawler } from './crawler'
import { createReplay } from './replay'
import { createRepeater } from './repeater'
import { createSessionManager } from './session'
import { runSmoke } from './smoke'
import { createTabManager } from './tabs'

// keep in sync with --tabbar-height and --color-bg-deep in tokens.css
const TAB_BAR_HEIGHT = 40
const TAB_BAR_COLOR = '#18181a'

// Dev-mode convenience: pulls provider keys (e.g. GOOGLE_GENERATIVE_AI_API_KEY)
// out of a gitignored .env at the project root into process.env, so the
// `opencode serve` child copilot.ts spawns inherits them. No-op if the file
// doesn't exist — never required for the app to start.
//
// Deliberately NOT process.loadEnvFile() with no arg: that resolves against
// process.cwd(), which is wherever the OS launched Electron from — not
// necessarily the project root (confirmed: under a test launcher it was a
// scratch directory with no .env, silently swallowed by this try/catch, and
// everything downstream failed for a confusing, unrelated-looking reason).
// app.getAppPath() is what's actually guaranteed to be the project root in
// dev mode.
try {
  process.loadEnvFile(join(app.getAppPath(), '.env'))
} catch {
  // no .env present — fine, OpenCode just won't have provider auth yet.
}
// reconix.env (the remote vLLM connection) is NOT loaded here: it's a shell
// file using `export` and "${VAR}" interpolation, which Electron's bundled
// Node 20 `loadEnvFile` crashes on natively (SIGTRAP, uncatchable). copilot.ts
// sources it in a shell at `opencode serve` spawn time instead.

let copilotBridge: CopilotBridge | null = null
let shuttingDown = false

/**
 * Tear the bridge down exactly once. stop() now waits for the spawned
 * `opencode serve` process group to actually exit, so awaiting it guarantees
 * no dangling server before the app terminates.
 */
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  const bridge = copilotBridge
  copilotBridge = null
  await bridge?.stop().catch(() => undefined)
}

// Application menu. The only custom entry is File ▸ Preferences, which tells the
// renderer to open the (docked) settings panel; the standard edit/view/window roles
// are kept so the usual OS shortcuts (copy/paste, zoom, close) still work. Built per
// platform: macOS wants the leading app menu, others start at File.
function buildAppMenu(mainWindow: BrowserWindow): void {
  const isMac = process.platform === 'darwin'
  const openPreferences = (): void => {
    mainWindow.webContents.send('menu:open-settings')
  }
  const preferencesItem: MenuItemConstructorOptions = {
    label: 'Preferences…',
    accelerator: 'CmdOrCtrl+,',
    click: openPreferences
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              preferencesItem,
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          } as MenuItemConstructorOptions
        ]
      : []),
    {
      label: 'File',
      submenu: isMac
        ? [{ label: 'Preferences…', click: openPreferences }, { type: 'separator' as const }, { role: 'close' as const }]
        : [preferencesItem, { type: 'separator' as const }, { role: 'quit' as const }]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

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

  buildAppMenu(mainWindow)

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Created before createTabManager: that call synchronously opens the first
  // tab and fires onActiveChanged once before createTabManager even returns.
  // network isn't assigned until after tabs exists (it needs tabs.tabIdFor),
  // so copilotBridge gets a getter instead of the instance — see
  // ActiveTabNetworkReader's comment in copilot.ts for why.
  let network: NetworkCapture | undefined
  let copilotTargetTabId: number | null = null
  copilotBridge = createCopilotBridge(mainWindow, () => network)

  const bodies = createBodyStore(mainWindow)
  const websockets = createWebSocketCapture(mainWindow)
  const interceptor = createInterceptor(mainWindow)
  const inspector = attachInspector(
    mainWindow,
    combineNetworkSinks(bodies, websockets),
    interceptor.sink
  )
  const tabs = createTabManager(mainWindow, {
    onActiveChanged: (target, tabId) => {
      inspector.setTarget(target)
      if (copilotTargetTabId === null) {
        copilotTargetTabId = tabId
        copilotBridge?.setActiveTarget(target, tabId)
      }
    },
    onTabClosed: (tabId) => {
      network?.forgetTab(tabId)
      if (copilotTargetTabId === tabId) {
        copilotTargetTabId = null
        copilotBridge?.setActiveTarget(null, null)
      }
    },
    beforeNavigate: () => copilotBridge?.waitUntilReady() ?? Promise.resolve()
  })
  ipcMain.removeHandler('copilot:set-target-tab')
  ipcMain.handle('copilot:set-target-tab', (event, tabId: unknown) => {
    if (event.sender !== mainWindow.webContents || typeof tabId !== 'number') return false
    const target = tabs.targetFor(tabId)
    if (!target) return false
    copilotTargetTabId = tabId
    copilotBridge?.setActiveTarget(target, tabId)
    return true
  })
  ipcMain.removeHandler('copilot:get-target-tab')
  ipcMain.handle('copilot:get-target-tab', (event) =>
    event.sender === mainWindow.webContents ? copilotTargetTabId : null
  )
  network = startNetworkCapture(mainWindow, tabs)
  // Host-side replay (Repeater) gates every send on the engagement scope; no
  // scope loaded -> deny all (default-deny holds). Same scope.json the proxy uses.
  const configuredScope = process.env.SCOPE_CONFIG_PATH ? loadScopeChecker() : null
  // Resolve the URL at authorization time: a WebContents can navigate without
  // changing its tab id, so a URL captured by onActiveChanged would be stale.
  const activeOriginScope = createActiveOriginScopeChecker(() => {
    if (copilotTargetTabId === null) return null
    const target = tabs.targetFor(copilotTargetTabId)
    return target && !target.isDestroyed() ? target.getURL() : null
  })
  const { replayer } = createReplay(mainWindow, configuredScope ?? activeOriginScope)
  // Repeater reuses the one gated replayer so its sends are scope-/rate-checked too.
  createRepeater(mainWindow, replayer)
  // The crawler drives the SAME gated replayer, so its spidering never egresses
  // outside authorized scope or past the per-host rate limit.
  createCrawler(mainWindow, replayer)
  createSessionManager(mainWindow)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.reconix.app')

  // Guarded smoke harness: exercises the MCP + OpenCode modules in the real
  // Electron main process, then exits. No effect on normal startup.
  if (process.env['RECONIX_SMOKE']) {
    await runSmoke()
    return
  }

  app.on('browser-window-created', (_, window) => {
    // zoom: true stops the toolkit from swallowing Cmd/Ctrl+Minus, which broke zoom out
    optimizer.watchWindowShortcuts(window, { escToCloseWindow: false, zoom: true })
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

app.on('before-quit', (event) => {
  // Defer the quit until the spawned `opencode serve` (and its process group)
  // is gone, so closing Reconix never leaves the server running.
  if (shuttingDown || !copilotBridge) return
  event.preventDefault()
  void shutdown().finally(() => app.quit())
})

// Dev/interactive exits (Ctrl-C, an external SIGTERM) skip Electron's own
// quit sequence, so run the same teardown before exiting.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown().finally(() => process.exit(0))
  })
}
