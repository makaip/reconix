import { useEffect, useState } from 'react'
import type { ResourceInfo } from '../../../../shared/devtools'
import { RESOURCE_DRAG_TYPE, type ResourceDragItem } from '../../lib/dragTypes'
import { nextSelection } from '../../lib/selection'

type SourcesPanelProps = {
  resources: ResourceInfo[]
  loaded: boolean
  /** A sitemap endpoint (host+path) to reveal/select, re-triggered by its nonce. */
  openTarget: { target: string; nonce: number } | null
  onDragStart: () => void
  onDragEnd: () => void
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

/** host+path, trailing slash stripped — the scheme-agnostic key the sitemap matches on. */
function hostPath(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}${parsed.pathname}`.replace(/\/$/, '')
  } catch {
    return url
  }
}

const keyOf = (resource: Pick<ResourceInfo, 'frameId' | 'url'>): string =>
  `${resource.frameId}:${resource.url}`

function SourcesPanel({
  resources,
  loaded,
  openTarget,
  onDragStart,
  onDragEnd
}: SourcesPanelProps): JSX.Element {
  const [active, setActive] = useState<ResourceInfo | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'binary' | 'error'>('idle')

  const reveal = (resource: ResourceInfo): void => {
    setActive(resource)
    setSelected(new Set([keyOf(resource)]))
    setAnchor(keyOf(resource))
  }

  // A sitemap double-click opens the matching resource here (if the page loaded it).
  useEffect(() => {
    if (!openTarget) return
    const match = resources.find((r) => hostPath(r.url) === openTarget.target.replace(/\/$/, ''))
    if (match) reveal(match)
  }, [openTarget, resources])

  // Loads the active resource's source into the viewer.
  useEffect(() => {
    if (!active) {
      setContent(null)
      setState('idle')
      return
    }
    let stale = false
    setState('loading')
    void window.reconix.devtools
      .getResourceContent({ frameId: active.frameId, url: active.url })
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
  }, [active])

  // Drop selections/active that point at resources gone after a navigation.
  useEffect(() => {
    const present = new Set(resources.map(keyOf))
    setSelected((current) => {
      const next = new Set([...current].filter((k) => present.has(k)))
      return next.size === current.size ? current : next
    })
    if (active && !present.has(keyOf(active))) setActive(null)
  }, [resources, active])

  const select = (
    resource: ResourceInfo,
    mods: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }
  ): void => {
    const keys = resources.map(keyOf)
    const result = nextSelection(selected, anchor, keyOf(resource), keys, mods)
    setSelected(result.set)
    setAnchor(result.anchor)
    setActive(resource)
  }

  // Dragging a row carries every selected file; dragging an unselected row selects just it first.
  const dragItems = (resource: ResourceInfo): ResourceDragItem[] => {
    const key = keyOf(resource)
    let keys = selected
    if (!selected.has(key)) {
      keys = new Set([key])
      setSelected(keys)
      setAnchor(key)
    }
    return resources
      .filter((r) => keys.has(keyOf(r)))
      .map((r) => ({ url: r.url, label: resourceLabel(r.url), frameId: r.frameId }))
  }

  return (
    <div className="dt-sources">
      <div className="dt-sources__list" role="tree" aria-label="Page resources">
        {!loaded && <p className="dt-empty">Loading…</p>}
        {loaded && resources.length === 0 && <p className="dt-empty">No resources loaded.</p>}
        {resources.map((resource) => (
          <button
            key={keyOf(resource)}
            type="button"
            className={
              selected.has(keyOf(resource))
                ? 'dt-sources__row dt-sources__row--selected'
                : 'dt-sources__row'
            }
            title={resource.url}
            draggable
            onClick={(event) =>
              select(resource, {
                metaKey: event.metaKey,
                ctrlKey: event.ctrlKey,
                shiftKey: event.shiftKey
              })
            }
            onDragStart={(event) => {
              const items = dragItems(resource)
              event.dataTransfer.effectAllowed = 'copy'
              event.dataTransfer.setData(RESOURCE_DRAG_TYPE, JSON.stringify(items))
              event.dataTransfer.setData('text/plain', items.map((item) => item.url).join('\n'))
              onDragStart()
            }}
            onDragEnd={onDragEnd}
          >
            <span className="dt-sources__row-name">{resourceLabel(resource.url)}</span>
            <span className="dt-sources__row-type dt-muted">{resource.type}</span>
          </button>
        ))}
      </div>

      <div className="dt-sources__viewer">
        {!active && <p className="dt-network__detail-empty">Select a resource to view its source.</p>}
        {active && state === 'loading' && <p className="dt-network__detail-empty">Loading…</p>}
        {active && state === 'binary' && <p className="dt-network__detail-empty">Binary content, not shown.</p>}
        {active && state === 'error' && (
          <p className="dt-network__detail-empty">Couldn't load this resource.</p>
        )}
        {active && state === 'idle' && content !== null && <pre className="dt-sources__code">{content}</pre>}
      </div>
    </div>
  )
}

export default SourcesPanel
