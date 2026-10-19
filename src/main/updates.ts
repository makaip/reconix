import { app, ipcMain, type BrowserWindow, type WebContents } from 'electron'
import { autoUpdater } from 'electron-updater'

/**
 * Auto-update wiring (Discord-style in-place updates).
 *
 * electron-updater reads the feed described by the electron-builder config
 * (electron-builder.yml / app-update.yml). Nothing here talks to the network
 * until checkForUpdates() is called; in dev there is no app-update.yml, so
 * every check fails fast and is swallowed — never fatal, never blocking boot.
 *
 * Windows/Linux (NSIS/AppImage) install in place and relaunch; macOS needs a
 * signed+notarized build (Squirrel.Mac) for the swap to succeed. All of that
 * lives in the packaging config, not here.
 */

export type UpdateCheckResult = {
  ok: boolean
  /** Version the check found available, when one is. Undefined = already current. */
  version?: string
  error?: string
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * electron-updater can only replace a packaged install: Windows NSIS/macOS, and
 * on Linux ONLY an AppImage (it locates the file through $APPIMAGE). Calling a
 * check anywhere else only produces noise ("APPIMAGE env is not defined",
 * "downloadPromise is null") with no chance of succeeding, so skip it up front.
 */
function autoUpdateSupport(): { ok: boolean; reason?: string } {
  if (!app.isPackaged) return { ok: false, reason: 'unpackaged development build' }
  if (process.platform === 'linux' && !process.env.APPIMAGE) {
    return { ok: false, reason: 'Linux auto-update requires running the AppImage build' }
  }
  return { ok: true }
}

// One updater instance exists for the whole process, but windows are recreated
// (macOS activate). Keep a live reference instead of capturing a window in the
// event listeners, so a stale window never receives update pushes.
let mainWindowRef: BrowserWindow | null = null
let listenersAttached = false

function isMainWindow(sender: WebContents): boolean {
  const window = mainWindowRef
  return window !== null && !window.isDestroyed() && sender === window.webContents
}

function attachListeners(): void {
  if (listenersAttached) return
  listenersAttached = true

  autoUpdater.on('update-available', (info) => {
    console.log(`[updater] update available: ${info.version}`)
  })

  autoUpdater.on('download-progress', (progress) => {
    console.log(
      `[updater] downloading: ${progress.percent.toFixed(1)}% ` +
        `(${progress.transferred}/${progress.total} bytes)`
    )
  })

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[updater] update downloaded: ${info.version} — installs on quit`)
    const window = mainWindowRef
    if (window && !window.isDestroyed()) {
      window.webContents.send('app:update-downloaded', { version: info.version })
    }
  })

  autoUpdater.on('error', (error) => {
    console.warn(`[updater] ${messageOf(error)}`)
  })
}

/**
 * Attach the updater to a freshly created window: downloads happen in the
 * background, installs land on quit, and the renderer can trigger a check or
 * restart through IPC. Safe to call once per window.
 */
export function initAutoUpdater(mainWindow: BrowserWindow): void {
  attachListeners()
  mainWindowRef = mainWindow
  mainWindow.on('closed', () => {
    if (mainWindowRef === mainWindow) mainWindowRef = null
  })

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  // Synchronous version readback: the preload reads this while it loads, so the
  // Settings panel can show a version with no placeholder flash. Always assign
  // returnValue — an unanswered sendSync would deadlock the renderer.
  ipcMain.removeAllListeners('app:get-version')
  ipcMain.on('app:get-version', (event) => {
    event.returnValue = isMainWindow(event.sender) ? app.getVersion() : ''
  })

  ipcMain.removeHandler('app:check-for-updates')
  ipcMain.handle('app:check-for-updates', async (event): Promise<UpdateCheckResult> => {
    if (!isMainWindow(event.sender)) return { ok: false, error: 'unauthorized' }
    const support = autoUpdateSupport()
    if (!support.ok) return { ok: false, error: `Auto-update unavailable: ${support.reason}` }
    try {
      // Resolves null when the app is already current.
      const result = await autoUpdater.checkForUpdates()
      return { ok: true, version: result?.updateInfo.version }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  })

  ipcMain.removeHandler('app:quit-and-install')
  ipcMain.handle('app:quit-and-install', (event): boolean => {
    if (!isMainWindow(event.sender)) return false
    try {
      autoUpdater.quitAndInstall()
      return true
    } catch (error) {
      console.warn(`[updater] quitAndInstall failed: ${messageOf(error)}`)
      return false
    }
  })
}

/**
 * Fire-and-forget startup check. Both the sync throw (misconfiguration) and the
 * async rejection (offline, dev with no update feed) are swallowed: the app must
 * boot regardless of updater state.
 */
export function checkForUpdatesOnStartup(): void {
  const support = autoUpdateSupport()
  if (!support.ok) {
    console.log(`[updater] startup check skipped: ${support.reason}`)
    return
  }
  try {
    // autoDownload is enabled in initAutoUpdater, so a plain check is enough;
    // checkForUpdatesAndNotify() is what logs "downloadPromise is null" when
    // there is no download in flight.
    void autoUpdater.checkForUpdates().catch((error) => {
      console.warn(`[updater] startup check skipped: ${messageOf(error)}`)
    })
  } catch (error) {
    console.warn(`[updater] startup check skipped: ${messageOf(error)}`)
  }
}
