import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react'
import type { CapturedRequest } from '../../../../shared/tabs'
import { queryRequests, type RequestQuery } from '../../lib/requestQuery'
import { fromHar, parsedHarToCaptured, toHar } from '../../lib/har'
import { REQUEST_DRAG_TYPE, type RequestDragItem } from '../../lib/dragTypes'
import { useResizable } from '../../hooks/useResizable'
import ResizeHandle from '../chrome/ResizeHandle'

type NetworkPanelProps = {
  requests: CapturedRequest[]
  /** Active tab; changing it drops HAR-imported rows (they belong to the previous page). */
  tabId?: number | null
  /** Fired when a request row starts/stops being dragged toward Copilot. */
  onDragStart: () => void
  onDragEnd: () => void
}

/** Request name as Chrome's Network panel shows it: path + query, falling back to the full URL. */
function requestName(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}` || '/'
  } catch {
    return url
  }
}

function statusClass(request: CapturedRequest): string {
  if (request.error) return 'dt-network__status--error'
  if (request.statusCode === undefined) return 'dt-network__status--pending'
  if (request.statusCode >= 500) return 'dt-network__status--error'
  if (request.statusCode >= 400) return 'dt-network__status--error'
  if (request.statusCode >= 300) return 'dt-network__status--redirect'
  return 'dt-network__status--ok'
}

function statusLabel(request: CapturedRequest): string {
  if (request.error) return request.error.replace(/^net::/, '')
  if (request.statusCode === undefined) return request.fromCache ? 'cache' : '…'
  return String(request.statusCode)
}

function HeaderList({ headers }: { headers: Record<string, string> | undefined }): JSX.Element {
  const entries = headers ? Object.entries(headers) : []
  if (entries.length === 0) return <p className="dt-network__detail-empty">None</p>
  return (
    <dl className="dt-network__headers">
      {entries.map(([name, value]) => (
        <div key={name} className="dt-network__header-row">
          <dt>{name}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

// webRequest's responseHeaders are string[] per key (duplicates possible); flatten for display.
function flattenResponseHeaders(headers: Record<string, string[]> | undefined): Record<string, string> {
  if (!headers) return {}
  return Object.fromEntries(Object.entries(headers).map(([name, values]) => [name, values.join(', ')]))
}

const EMPTY_QUERY: RequestQuery = {}

function NetworkPanel({ requests, tabId, onDragStart, onDragEnd }: NetworkPanelProps): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const detailResize = useResizable({
    axis: 'x',
    initial: 330,
    min: 200,
    max: 800,
    invert: true,
    storageKey: 'network.detail'
  })
  const [query, setQuery] = useState<RequestQuery>(EMPTY_QUERY)
  // HAR-imported rows live only in this panel (never in the capture buffer).
  const [imported, setImported] = useState<CapturedRequest[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Imported rows belong to the page they were loaded for: drop them when the tab changes.
  const lastTabId = useRef(tabId)
  useEffect(() => {
    if (lastTabId.current === tabId) return
    lastTabId.current = tabId
    setImported([])
  }, [tabId])

  const allRequests = useMemo(
    () => (imported.length === 0 ? requests : [...requests, ...imported]),
    [requests, imported]
  )
  const selected = allRequests.find((request) => request.id === selectedId) ?? null

  const filtered = useMemo(() => queryRequests(allRequests, query), [allRequests, query])

  // Downloads the currently-shown requests as a HAR 1.2 file (no server round-trip).
  const exportHar = (): void => {
    const blob = new Blob([JSON.stringify(toHar(filtered), null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `reconix-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.har`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Reads a .har file chosen by the user and appends its entries to the local display list.
  const onHarFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    // Reset so re-selecting the same file fires change again.
    event.target.value = ''
    if (!file) return
    try {
      const entries = fromHar(JSON.parse(await file.text()))
      if (entries.length === 0) return
      // Offset ids by the current import count so a second file can't collide with the first.
      setImported((prev) => [...prev, ...parsedHarToCaptured(entries, undefined, prev.length)])
    } catch {
      // Unreadable file or invalid JSON: nothing to show, leave the list unchanged.
    }
  }

  const set = (patch: Partial<RequestQuery>): void =>
    setQuery((q) => {
      const next = { ...q, ...patch }
      // Blank strings/NaN clear a field rather than filtering on emptiness.
      for (const key of Object.keys(next) as (keyof RequestQuery)[]) {
        const v = next[key]
        if (v === '' || v === undefined || (typeof v === 'number' && Number.isNaN(v))) delete next[key]
      }
      return next
    })

  // dropped requests (tab closed, capture buffer trimmed) shouldn't leave a dangling selection
  useEffect(() => {
    if (selectedId !== null && !allRequests.some((request) => request.id === selectedId)) {
      setSelectedId(null)
    }
  }, [allRequests, selectedId])

  return (
    <div className="dt-network">
      <div className="dt-netfilter">
        <input className="dt-netfilter__input" placeholder="host" onChange={(e) => set({ host: e.target.value })} />
        <input className="dt-netfilter__input dt-netfilter__input--sm" placeholder="method" onChange={(e) => set({ method: e.target.value })} />
        <input className="dt-netfilter__input dt-netfilter__input--sm" placeholder="status (404, 5xx)" onChange={(e) => set({ status: e.target.value })} />
        <input className="dt-netfilter__input" placeholder="URL regex" onChange={(e) => set({ urlRegex: e.target.value })} />
        <input className="dt-netfilter__input dt-netfilter__input--sm" placeholder="param" onChange={(e) => set({ param: e.target.value })} />
        <input className="dt-netfilter__input dt-netfilter__input--sm" type="number" placeholder="min B" onChange={(e) => set({ minBytes: e.target.valueAsNumber })} />
        <input className="dt-netfilter__input dt-netfilter__input--sm" type="number" placeholder="max B" onChange={(e) => set({ maxBytes: e.target.valueAsNumber })} />
        <button type="button" className="dt-text-button" onClick={exportHar} disabled={filtered.length === 0}>
          Export HAR
        </button>
        <button type="button" className="dt-text-button" onClick={() => fileInputRef.current?.click()}>
          Import HAR
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".har,application/json"
          aria-label="Import HAR file"
          className="dt-network__file"
          onChange={onHarFile}
        />
      </div>
      <div className="dt-network__body">
      <div className="dt-network__list" role="table" aria-label="Network requests">
        {filtered.length === 0 ? (
          <p className="dt-empty">
            {allRequests.length === 0 ? 'No requests captured yet.' : 'No requests match the filter.'}
          </p>
        ) : (
          <div className="dt-network__rows">
            <div className="dt-network__row dt-network__row--head" role="row">
              <span className="dt-network__cell dt-network__cell--status">Status</span>
              <span className="dt-network__cell dt-network__cell--method">Method</span>
              <span className="dt-network__cell dt-network__cell--name">Name</span>
              <span className="dt-network__cell dt-network__cell--type">Type</span>
              <span className="dt-network__cell dt-network__cell--time">Time</span>
            </div>
            {filtered.map((request) => (
              <button
                key={request.id}
                type="button"
                role="row"
                className={
                  request.id === selectedId
                    ? 'dt-network__row dt-network__row--selected'
                    : 'dt-network__row'
                }
                onClick={() => setSelectedId(request.id)}
                title={request.url}
                draggable
                onDragStart={(event) => {
                  const item: RequestDragItem = {
                    ...request,
                    label: `${request.method} ${requestName(request.url)}`
                  }
                  event.dataTransfer.effectAllowed = 'copy'
                  event.dataTransfer.setData(REQUEST_DRAG_TYPE, JSON.stringify([item]))
                  event.dataTransfer.setData('text/plain', `${request.method} ${request.url}`)
                  onDragStart()
                }}
                onDragEnd={onDragEnd}
              >
                <span className={`dt-network__cell dt-network__cell--status ${statusClass(request)}`}>
                  {statusLabel(request)}
                </span>
                <span className="dt-network__cell dt-network__cell--method">{request.method}</span>
                <span className="dt-network__cell dt-network__cell--name">
                  {requestName(request.url)}
                  {request.resourceType === 'imported' && <span className="dt-network__badge">imported</span>}
                </span>
                <span className="dt-network__cell dt-network__cell--type dt-muted">
                  {request.resourceType}
                </span>
                <span className="dt-network__cell dt-network__cell--time dt-muted">
                  {request.durationMs === undefined ? '' : `${request.durationMs} ms`}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <ResizeHandle
        orientation="vertical"
        dragging={detailResize.dragging}
        onPointerDown={detailResize.onHandlePointerDown}
      />
      <div className="dt-network__detail" style={{ width: detailResize.size }}>
        {selected === null ? (
          <p className="dt-network__detail-empty">Select a request to inspect its headers.</p>
        ) : (
          <>
            <div className="dt-network__detail-url">{selected.url}</div>
            <section className="dt-network__detail-section">
              <h3>General</h3>
              <div className="dt-network__header-row">
                <dt>Method</dt>
                <dd>{selected.method}</dd>
              </div>
              <div className="dt-network__header-row">
                <dt>Status</dt>
                <dd className={statusClass(selected)}>{statusLabel(selected)}</dd>
              </div>
              {selected.durationMs !== undefined && (
                <div className="dt-network__header-row">
                  <dt>Time</dt>
                  <dd>{selected.durationMs} ms</dd>
                </div>
              )}
            </section>
            <section className="dt-network__detail-section">
              <h3>Request Headers</h3>
              <HeaderList headers={selected.requestHeaders} />
            </section>
            <section className="dt-network__detail-section">
              <h3>Response Headers</h3>
              <HeaderList headers={flattenResponseHeaders(selected.responseHeaders)} />
            </section>
          </>
        )}
      </div>
      </div>
    </div>
  )
}

export default NetworkPanel
