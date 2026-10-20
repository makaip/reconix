// Engagement store (ARCHITECTURE §6.4: engagements(id, goal, scope_json, policy_json,
// started_at, stopped_at, status)). One engagement is one authorized run over the
// loaded scope. The store owns the start/stop lifecycle and the IPC surface; the
// app's attribution id (findings/traces/tool_calls) stays the scope's id, so a
// run's rows are readable through the usual store queries.
import { ipcMain, type BrowserWindow } from 'electron'
import type { Database } from 'node-sqlite3-wasm'
import { currentScopeStatus, loadScopeConfig, scopeStatusFromUnknown, setScopeStatus } from './engagement'
import type { EngagementRow } from '../shared/engagements'

export interface EngagementStoreOptions {
  /** Policy used when a start request omits one (defaults to the app policy). */
  defaultPolicy?: unknown
}

export interface EngagementStore {
  /** The active engagement's id, or the loaded scope's id, or null. */
  currentId(): string | null
  /** The active engagement row, or null. */
  current(): EngagementRow | null
  /** Start a new engagement (stops any currently active one first). */
  start(input: { goal: string; scope?: unknown; policy?: unknown }): EngagementRow
  /** Stop an engagement (the active one if no id is given). */
  stop(id?: string): void
  get(id: string): EngagementRow | null
  list(): EngagementRow[]
  close(): void
}

const toRow = (row: Record<string, unknown>): EngagementRow => ({
  id: String(row.id),
  goal: typeof row.goal === 'string' ? row.goal : '',
  scope: parseJson(row.scope_json),
  policy: parseJson(row.policy_json),
  startedAt: Number(row.started_at) || 0,
  stoppedAt: row.stopped_at == null ? null : Number(row.stopped_at),
  status: row.status === 'active' ? 'active' : 'stopped'
})

function parseJson(value: unknown): unknown {
  try {
    return JSON.parse(String(value))
  } catch {
    return null
  }
}

export function createEngagementStore(
  db: Database,
  win: BrowserWindow,
  options: EngagementStoreOptions = {}
): EngagementStore {
  const { defaultPolicy = null } = options

  const current = (): EngagementRow | null => {
    const row = db.get(
      "SELECT id, goal, scope_json, policy_json, started_at, stopped_at, status FROM engagements WHERE status = 'active' ORDER BY started_at DESC LIMIT 1"
    )
    return row ? toRow(row as Record<string, unknown>) : null
  }

  const currentId = (): string | null => {
    const active = current()
    if (active) return active.id
    return loadScopeConfig()?.engagementId ?? null
  }

  const start = (input: { goal: string; scope?: unknown; policy?: unknown }): EngagementRow => {
    // Only one engagement runs at a time.
    db.run("UPDATE engagements SET status = 'stopped', stopped_at = ? WHERE status = 'active'", [Date.now()])

    const scope = input.scope ?? loadScopeConfig()
    const policy = input.policy ?? defaultPolicy
    const id = (scope && typeof scope === 'object' && typeof (scope as Record<string, unknown>).engagementId === 'string'
      ? (scope as Record<string, unknown>).engagementId
      : `eng_${Date.now()}`) as string

    // An explicit run scope becomes the live scope view; a run that just reuses
    // scope.json leaves the view on the file so later edits still show through.
    setScopeStatus(input.scope === undefined ? null : scopeStatusFromUnknown(scope))

    const startedAt = Date.now()
    db.run(
      'INSERT OR REPLACE INTO engagements (id, goal, scope_json, policy_json, started_at, stopped_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, input.goal, JSON.stringify(scope ?? null), JSON.stringify(policy ?? null), startedAt, null, 'active']
    )
    broadcast()
    return { id, goal: input.goal, scope, policy, startedAt, stoppedAt: null, status: 'active' }
  }

  const stop = (id?: string): void => {
    const target = id ?? current()?.id
    if (!target) return
    db.run("UPDATE engagements SET status = 'stopped', stopped_at = ? WHERE id = ? AND status = 'active'", [
      Date.now(),
      target
    ])
    // No active run -> back to the loaded scope.json view.
    setScopeStatus(null)
    broadcast()
  }

  const get = (id: string): EngagementRow | null => {
    const row = db.get(
      'SELECT id, goal, scope_json, policy_json, started_at, stopped_at, status FROM engagements WHERE id = ?',
      [id]
    )
    return row ? toRow(row as Record<string, unknown>) : null
  }

  const list = (): EngagementRow[] =>
    db
      .all('SELECT id, goal, scope_json, policy_json, started_at, stopped_at, status FROM engagements ORDER BY started_at DESC')
      .map((row) => toRow(row as Record<string, unknown>))

  const broadcast = (): void => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      // Scope first: the badge should already be correct when the engagement
      // row arrives. `scope:changed` carries the same projection scope:get does.
      win.webContents.send('scope:changed', currentScopeStatus())
      win.webContents.send('engagement:changed', current())
    }
  }

  ipcMain.removeHandler('engagement:start')
  ipcMain.handle('engagement:start', (event, goal: unknown, scope?: unknown, policy?: unknown) => {
    if (event.sender !== win.webContents) return null
    if (typeof goal !== 'string' || !goal.trim()) return null
    return start({ goal: goal.trim(), scope, policy })
  })
  ipcMain.removeHandler('engagement:stop')
  ipcMain.handle('engagement:stop', (event, id?: unknown) => {
    if (event.sender !== win.webContents) return
    stop(typeof id === 'string' ? id : undefined)
  })
  ipcMain.removeHandler('engagement:current')
  ipcMain.handle('engagement:current', (event) =>
    event.sender === win.webContents ? current() : null
  )
  ipcMain.removeHandler('engagement:list')
  ipcMain.handle('engagement:list', (event) => (event.sender === win.webContents ? list() : []))
  // engagement:get now reflects the active run (falling back to the scope.json id),
  // so the status bar / useRuntimeStatus stay correct without a separate code path.
  ipcMain.removeHandler('engagement:get')
  ipcMain.handle('engagement:get', (event) => (event.sender === win.webContents ? currentId() : null))

  const close = (): void => {
    ipcMain.removeHandler('engagement:start')
    ipcMain.removeHandler('engagement:stop')
    ipcMain.removeHandler('engagement:current')
    ipcMain.removeHandler('engagement:list')
    ipcMain.removeHandler('engagement:get')
  }
  win.on('closed', close)

  return { currentId, current, start, stop, get, list, close }
}
