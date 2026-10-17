import { useState } from 'react'
import type { CookieInfo, StorageArea, StorageEntry } from '../../../../shared/devtools'
import type { ApplicationApi } from '../../hooks/useApplication'
import { useResizable } from '../../hooks/useResizable'
import ResizeHandle from '../chrome/ResizeHandle'

type ApplicationPanelProps = {
  application: ApplicationApi
}

type Section = 'cookies' | 'local' | 'session'

function expiresLabel(expires: number): string {
  if (expires < 0) return 'Session'
  return new Date(expires * 1000).toLocaleString()
}

function CookiesTable({
  cookies,
  onDelete
}: {
  cookies: CookieInfo[]
  onDelete: (name: string) => Promise<void>
}): JSX.Element {
  if (cookies.length === 0) return <p className="dt-network__detail-empty">No cookies for this page.</p>
  return (
    <div className="dt-table-wrap">
      <table className="dt-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Value</th>
            <th>Domain</th>
            <th>Path</th>
            <th>Expires</th>
            <th>Flags</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {cookies.map((cookie) => (
            <tr key={`${cookie.domain}:${cookie.path}:${cookie.name}`}>
              <td className="dt-table__mono">{cookie.name}</td>
              <td className="dt-table__mono dt-table__truncate">{cookie.value}</td>
              <td>{cookie.domain}</td>
              <td>{cookie.path}</td>
              <td>{expiresLabel(cookie.expires)}</td>
              <td className="dt-muted">
                {[cookie.httpOnly && 'HttpOnly', cookie.secure && 'Secure', cookie.sameSite]
                  .filter(Boolean)
                  .join(', ') || '—'}
              </td>
              <td>
                <button
                  type="button"
                  className="dt-text-button"
                  onClick={() => void onDelete(cookie.name)}
                  aria-label={`Delete cookie ${cookie.name}`}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function StorageTable({
  area,
  entries,
  onSet,
  onDelete,
  onClear
}: {
  area: StorageArea
  entries: StorageEntry[]
  onSet: (area: StorageArea, key: string, value: string) => Promise<void>
  onDelete: (area: StorageArea, key: string) => Promise<void>
  onClear: (area: StorageArea) => Promise<void>
}): JSX.Element {
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')

  const submit = (): void => {
    const key = newKey.trim()
    if (!key) return
    void onSet(area, key, newValue).then(() => {
      setNewKey('')
      setNewValue('')
    })
  }

  return (
    <div className="dt-table-wrap">
      <div className="dt-storage__toolbar">
        <button
          type="button"
          className="dt-text-button"
          onClick={() => void onClear(area)}
          disabled={entries.length === 0}
        >
          Clear all
        </button>
      </div>
      <table className="dt-table">
        <thead>
          <tr>
            <th>Key</th>
            <th>Value</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.key}>
              <td className="dt-table__mono">{entry.key}</td>
              <td className="dt-table__mono dt-table__truncate">{entry.value}</td>
              <td>
                <button
                  type="button"
                  className="dt-text-button"
                  onClick={() => void onDelete(area, entry.key)}
                  aria-label={`Delete ${entry.key}`}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
          <tr>
            <td>
              <input
                className="dt-styles__input"
                placeholder="key"
                value={newKey}
                onChange={(event) => setNewKey(event.target.value)}
                aria-label="New storage key"
              />
            </td>
            <td>
              <input
                className="dt-styles__input"
                placeholder="value"
                value={newValue}
                onChange={(event) => setNewValue(event.target.value)}
                aria-label="New storage value"
              />
            </td>
            <td>
              <button type="button" className="dt-text-button" onClick={submit} disabled={!newKey.trim()}>
                Add
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function ApplicationPanel({ application }: ApplicationPanelProps): JSX.Element {
  const listResize = useResizable({ axis: 'x', initial: 220, min: 140, max: 600, storageKey: 'application.list' })
  const [section, setSection] = useState<Section>('cookies')

  return (
    <div className="dt-application">
      <div
        className="dt-sources__list"
        role="tree"
        aria-label="Application storage"
        style={{ width: listResize.size }}
      >
        <button
          type="button"
          className={section === 'cookies' ? 'dt-sources__row dt-sources__row--selected' : 'dt-sources__row'}
          onClick={() => setSection('cookies')}
        >
          <span className="dt-sources__row-name">Cookies</span>
          <span className="dt-sources__row-type dt-muted">{application.cookies.length}</span>
        </button>
        <button
          type="button"
          className={section === 'local' ? 'dt-sources__row dt-sources__row--selected' : 'dt-sources__row'}
          onClick={() => setSection('local')}
        >
          <span className="dt-sources__row-name">Local Storage</span>
          <span className="dt-sources__row-type dt-muted">{application.localStorage.length}</span>
        </button>
        <button
          type="button"
          className={section === 'session' ? 'dt-sources__row dt-sources__row--selected' : 'dt-sources__row'}
          onClick={() => setSection('session')}
        >
          <span className="dt-sources__row-name">Session Storage</span>
          <span className="dt-sources__row-type dt-muted">{application.sessionStorage.length}</span>
        </button>
      </div>

      <ResizeHandle
        orientation="vertical"
        dragging={listResize.dragging}
        onPointerDown={listResize.onHandlePointerDown}
      />
      <div className="dt-application__detail">
        {section === 'cookies' && <CookiesTable cookies={application.cookies} onDelete={application.deleteCookie} />}
        {section === 'local' && (
          <StorageTable
            area="local"
            entries={application.localStorage}
            onSet={application.setStorageItem}
            onDelete={application.deleteStorageItem}
            onClear={application.clearStorage}
          />
        )}
        {section === 'session' && (
          <StorageTable
            area="session"
            entries={application.sessionStorage}
            onSet={application.setStorageItem}
            onDelete={application.deleteStorageItem}
            onClear={application.clearStorage}
          />
        )}
      </div>
    </div>
  )
}

export default ApplicationPanel
