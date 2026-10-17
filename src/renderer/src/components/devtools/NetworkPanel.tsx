import { useEffect, useMemo, useState } from 'react'
import type { CapturedRequest } from '../../../../shared/tabs'
import { queryRequests, type RequestQuery } from '../../lib/requestQuery'
import { toHar } from '../../lib/har'

type NetworkPanelProps = {
  requests: CapturedRequest[]
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

function NetworkPanel({ requests }: NetworkPanelProps): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState<RequestQuery>(EMPTY_QUERY)
  const selected = requests.find((request) => request.id === selectedId) ?? null

  const filtered = useMemo(() => queryRequests(requests, query), [requests, query])

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
    if (selectedId !== null && !requests.some((request) => request.id === selectedId)) {
      setSelectedId(null)
    }
  }, [requests, selectedId])

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
      </div>
      <div className="dt-network__body">
      <div className="dt-network__list" role="table" aria-label="Network requests">
        {filtered.length === 0 ? (
          <p className="dt-empty">
            {requests.length === 0 ? 'No requests captured yet.' : 'No requests match the filter.'}
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
              >
                <span className={`dt-network__cell dt-network__cell--status ${statusClass(request)}`}>
                  {statusLabel(request)}
                </span>
                <span className="dt-network__cell dt-network__cell--method">{request.method}</span>
                <span className="dt-network__cell dt-network__cell--name">{requestName(request.url)}</span>
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

      <div className="dt-network__detail">
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
