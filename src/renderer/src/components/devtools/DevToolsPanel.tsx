import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { StyleRule } from '../../../../shared/devtools'
import { nextSelection } from '../../lib/selection'
import { useApplication } from '../../hooks/useApplication'
import { useConsole } from '../../hooks/useConsole'
import { useCrawler } from '../../hooks/useCrawler'
import { buildRows, useDomTree } from '../../hooks/useDomTree'
import { useIntercept } from '../../hooks/useIntercept'
import { useNetworkRequests } from '../../hooks/useNetworkRequests'
import { useRepeater } from '../../hooks/useRepeater'
import { useResizable } from '../../hooks/useResizable'
import { useResources } from '../../hooks/useResources'
import { useWebSocket } from '../../hooks/useWebSocket'
import ResizeHandle from '../chrome/ResizeHandle'
import ApplicationPanel from './ApplicationPanel'
import Breadcrumbs from './Breadcrumbs'
import ConsolePanel from './ConsolePanel'
import CrawlerPanel from './CrawlerPanel'
import DevToolsToolbar, { type DevToolsTab } from './DevToolsToolbar'
import ElementsTree from './ElementsTree'
import InterceptPanel from './InterceptPanel'
import NetworkPanel from './NetworkPanel'
import RepeaterPanel from './RepeaterPanel'
import SourcesPanel from './SourcesPanel'
import StylesPane from './StylesPane'
import WebSocketPanel from './WebSocketPanel'

type DevToolsPanelProps = {
  /** Changes when the user switches tabs; the page inspector doesn't carry over. */
  activeTabId: number | null
  /** Active tab's URL, used to prefill the Crawler start field. */
  targetUrl?: string
  onDragStart: () => void
  onDragEnd: () => void
  /** Request (from the sitemap) to open a file in Sources; the nonce re-triggers repeats. */
  openSource: { target: string; nonce: number } | null
  style?: CSSProperties
}

function DevToolsPanel({
  activeTabId,
  targetUrl,
  onDragStart,
  onDragEnd,
  openSource,
  style
}: DevToolsPanelProps): JSX.Element {
  const { state, loaded, toggle, select } = useDomTree()
  const [rules, setRules] = useState<StyleRule[] | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const [devtoolsTab, setDevtoolsTab] = useState<DevToolsTab>('elements')
  const stylesResize = useResizable({
    axis: 'x',
    initial: 330,
    min: 200,
    max: 800,
    invert: true,
    storageKey: 'elements.styles'
  })
  // Multi-selection for the Elements tree (drag/attach). state.selectedId stays the "active"
  // node that drives Styles, the breadcrumb and $0; the anchor for shift-ranges tracks it.
  const [treeSel, setTreeSel] = useState<{ set: Set<number>; anchor: number | null }>({
    set: new Set(),
    anchor: null
  })
  const rows = useMemo(() => buildRows(state), [state])
  const networkRequests = useNetworkRequests(activeTabId)
  const repeater = useRepeater()
  const intercept = useIntercept()
  const consoleApi = useConsole()
  const { resources, loaded: resourcesLoaded } = useResources(activeTabId)
  const application = useApplication(activeTabId)
  const websockets = useWebSocket(activeTabId)
  const crawler = useCrawler()

  useEffect(() => setInspecting(false), [activeTabId])

  // A sitemap double-click opens the file in Sources.
  useEffect(() => {
    if (openSource) setDevtoolsTab('sources')
  }, [openSource])

  // Keep the multi-selection in step when the active node changes from outside the tree
  // (page inspector pick, keyboard nav): collapse to just that node.
  useEffect(() => {
    const id = state.selectedId
    if (id !== null && !treeSel.set.has(id)) setTreeSel({ set: new Set([id]), anchor: id })
  }, [state.selectedId])

  const selectRow = (
    id: number,
    mods: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }
  ): void => {
    const ids = rows.filter((row) => row.kind !== 'close').map((row) => row.id)
    const result = nextSelection(treeSel.set, treeSel.anchor, id, ids, mods)
    setTreeSel(result)
    select(id)
  }

  // page inspector turns itself off once element has been picked, and the pick is shown in Elements
  useEffect(
    () =>
      window.reconix.devtools.onEvent((event) => {
        if (event.method !== 'Reconix.nodeInspected') return
        setInspecting(false)
        setDevtoolsTab('elements')
      }),
    []
  )

  useEffect(() => {
    const { selectedId } = state
    if (selectedId === null) {
      setRules(null)
      return
    }
    let stale = false
    void window.reconix.devtools.getStyles(selectedId).then((result) => {
      if (!stale) setRules(result)
    })
    return () => {
      stale = true
    }
  }, [state.selectedId, state.nodes.get(state.selectedId ?? -1)?.attrs])

  const toggleInspect = (): void => {
    const next = !inspecting
    setInspecting(next)
    void window.reconix.devtools.setInspectMode(next)
  }

  return (
    <section className="devtools" aria-label="Developer tools" style={style}>
      <DevToolsToolbar
        inspecting={inspecting}
        onToggleInspect={toggleInspect}
        activeTab={devtoolsTab}
        onTabChange={setDevtoolsTab}
        counts={{
          network: networkRequests.length,
          websocket: websockets.length,
          crawler: crawler.state.pages.length,
          repeater: repeater.saved.length,
          intercept: intercept.rules.length,
          console: consoleApi.entries.length
        }}
        extra={
          devtoolsTab === 'console' ? (
            <button type="button" className="dt-text-button" onClick={consoleApi.clear}>
              Clear
            </button>
          ) : undefined
        }
      />
      {devtoolsTab === 'elements' && (
        <div className="dt-elements">
          <div className="dt-elements__tree">
            {loaded ? (
              <ElementsTree
                state={state}
                rows={rows}
                selectedIds={treeSel.set}
                onSelectRow={selectRow}
                onSelect={select}
                onToggle={toggle}
                onHover={(id) => void window.reconix.devtools.highlight(id)}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
              />
            ) : (
              <p className="dt-empty">Inspector unavailable.</p>
            )}
            <Breadcrumbs state={state} />
          </div>
          <ResizeHandle
            orientation="vertical"
            dragging={stylesResize.dragging}
            onPointerDown={stylesResize.onHandlePointerDown}
          />
          <StylesPane rules={rules} style={{ width: stylesResize.size }} />
        </div>
      )}
      {devtoolsTab === 'network' && (
        <NetworkPanel requests={networkRequests} onDragStart={onDragStart} onDragEnd={onDragEnd} />
      )}
      {devtoolsTab === 'websocket' && <WebSocketPanel connections={websockets} />}
      {devtoolsTab === 'crawler' && <CrawlerPanel api={crawler} defaultUrl={targetUrl} />}
      {devtoolsTab === 'repeater' && <RepeaterPanel api={repeater} />}
      {devtoolsTab === 'intercept' && <InterceptPanel api={intercept} />}
      {devtoolsTab === 'console' && (
        <ConsolePanel entries={consoleApi.entries} onEvaluate={consoleApi.evaluate} />
      )}
      {devtoolsTab === 'sources' && (
        <SourcesPanel
          resources={resources}
          loaded={resourcesLoaded}
          openTarget={openSource}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        />
      )}
      {devtoolsTab === 'application' && <ApplicationPanel application={application} />}
    </section>
  )
}

export default DevToolsPanel
