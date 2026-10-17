import { useMemo, useState } from 'react'
import type { CapturedRequest } from '../../../../shared/tabs'
import { buildSitemap } from '../../lib/sitemap'
import type { CrawlerApi } from '../../hooks/useCrawler'

type CrawlerPanelProps = {
  api: CrawlerApi
  /** Active tab URL, used to prefill the start field. */
  defaultUrl?: string
}

function statusText(status: number | null, reason?: string): string {
  if (reason && status === null) return reason
  if (status === null) return '—'
  return reason ? `${status} · ${reason}` : String(status)
}

function CrawlerPanel({ api, defaultUrl }: CrawlerPanelProps): JSX.Element {
  const { state } = api
  const [url, setUrl] = useState(defaultUrl ?? '')
  const [maxDepth, setMaxDepth] = useState(2)
  const [maxPages, setMaxPages] = useState(50)
  const [includeResources, setIncludeResources] = useState(false)

  // Feed the discovered pages through the SAME deterministic sitemap builder the
  // passive sitemap uses — only the `url` field is read, so minimal rows suffice.
  const sitemap = useMemo(() => {
    const rows: CapturedRequest[] = state.pages.map((p, i) => ({
      id: `crawl-${i}`,
      tabId: -1,
      method: 'GET',
      url: p.url,
      resourceType: 'document',
      startedAt: 0
    }))
    return buildSitemap(rows)
  }, [state.pages])

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    const trimmed = url.trim()
    if (!trimmed) return
    api.start({ url: trimmed, maxDepth, maxPages, includeResources })
  }

  return (
    <div className="dt-crawler">
      <form className="dt-crawler__form" onSubmit={submit}>
        <input
          type="text"
          className="dt-crawler__url"
          placeholder="https://target.example.com/"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={state.running}
        />
        <label className="dt-crawler__num">
          depth
          <input
            type="number"
            min={0}
            max={10}
            value={maxDepth}
            onChange={(e) => setMaxDepth(Number(e.target.value))}
            disabled={state.running}
          />
        </label>
        <label className="dt-crawler__num">
          pages
          <input
            type="number"
            min={1}
            max={500}
            value={maxPages}
            onChange={(e) => setMaxPages(Number(e.target.value))}
            disabled={state.running}
          />
        </label>
        <label className="dt-crawler__check">
          <input
            type="checkbox"
            checked={includeResources}
            onChange={(e) => setIncludeResources(e.target.checked)}
            disabled={state.running}
          />
          resources
        </label>
        {state.running ? (
          <button type="button" className="dt-text-button" onClick={api.stop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="dt-text-button">
            Crawl
          </button>
        )}
      </form>

      <div className="dt-crawler__status">
        {state.running ? 'crawling' : (state.stoppedReason ?? 'idle')} · {state.visited} fetched ·{' '}
        {state.queued} queued
      </div>

      <div className="dt-crawler__body">
        <ol className="dt-crawler__pages">
          {state.pages.map((p) => (
            <li key={p.url} className="dt-crawler__page" title={p.url}>
              <span className="dt-crawler__depth">d{p.depth}</span>
              <span
                className={
                  p.status !== null && p.status < 400
                    ? 'dt-crawler__code dt-crawler__code--ok'
                    : 'dt-crawler__code dt-crawler__code--bad'
                }
              >
                {statusText(p.status, p.reason)}
              </span>
              <span className="dt-crawler__pageurl">{p.url}</span>
            </li>
          ))}
          {state.pages.length === 0 && <li className="dt-empty">No pages crawled yet.</li>}
        </ol>

        {sitemap.length > 0 && (
          <ul className="dt-crawler__sitemap">
            {sitemap.map((node) => (
              <li
                key={node.id}
                className={`dt-crawler__node dt-crawler__node--${node.kind}`}
                style={{ paddingLeft: `${node.depth * 12 + 4}px` }}
              >
                {node.label}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export default CrawlerPanel
