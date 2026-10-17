import { useEffect, useState } from 'react'
import type { ResourceInfo } from '../../../../shared/devtools'

type SourcesPanelProps = {
  resources: ResourceInfo[]
  loaded: boolean
}

/** Last path segment (or the host, for a bare "/") — same idea as Network's requestName. */
function resourceLabel(url: string): string {
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split('/').filter(Boolean)
    return segments.length ? segments[segments.length - 1] : parsed.host || url
  } catch {
    return url
  }
}

function SourcesPanel({ resources, loaded }: SourcesPanelProps): JSX.Element {
  const [selected, setSelected] = useState<ResourceInfo | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'binary' | 'error'>('idle')

  useEffect(() => {
    if (!selected) {
      setContent(null)
      setState('idle')
      return
    }
    let stale = false
    setState('loading')
    void window.reconix.devtools
      .getResourceContent({ frameId: selected.frameId, url: selected.url })
      .then((result) => {
        if (stale) return
        if (!result) {
          setState('error')
          return
        }
        if (result.binary) {
          setState('binary')
          return
        }
        setContent(result.truncated ? `${result.content}\n\n… truncated …` : result.content)
        setState('idle')
      })
      .catch(() => {
        if (!stale) setState('error')
      })
    return () => {
      stale = true
    }
  }, [selected])

  // the resource the selection pointed at may disappear on navigation
  useEffect(() => {
    if (selected && !resources.some((r) => r.url === selected.url && r.frameId === selected.frameId)) {
      setSelected(null)
    }
  }, [resources, selected])

  return (
    <div className="dt-sources">
      <div className="dt-sources__list" role="tree" aria-label="Page resources">
        {!loaded && <p className="dt-empty">Loading…</p>}
        {loaded && resources.length === 0 && <p className="dt-empty">No resources loaded.</p>}
        {resources.map((resource) => (
          <button
            key={`${resource.frameId}:${resource.url}`}
            type="button"
            className={
              selected?.url === resource.url && selected?.frameId === resource.frameId
                ? 'dt-sources__row dt-sources__row--selected'
                : 'dt-sources__row'
            }
            title={resource.url}
            onClick={() => setSelected(resource)}
          >
            <span className="dt-sources__row-name">{resourceLabel(resource.url)}</span>
            <span className="dt-sources__row-type dt-muted">{resource.type}</span>
          </button>
        ))}
      </div>

      <div className="dt-sources__viewer">
        {!selected && <p className="dt-network__detail-empty">Select a resource to view its source.</p>}
        {selected && state === 'loading' && <p className="dt-network__detail-empty">Loading…</p>}
        {selected && state === 'binary' && <p className="dt-network__detail-empty">Binary content, not shown.</p>}
        {selected && state === 'error' && (
          <p className="dt-network__detail-empty">Couldn't load this resource.</p>
        )}
        {selected && state === 'idle' && content !== null && <pre className="dt-sources__code">{content}</pre>}
      </div>
    </div>
  )
}

export default SourcesPanel
