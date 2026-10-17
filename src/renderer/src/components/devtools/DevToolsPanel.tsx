import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { StyleRule } from '../../../../shared/devtools'
import type { NodeRef } from '../../hooks/useCopilot'
import { useApplication } from '../../hooks/useApplication'
import { useConsole } from '../../hooks/useConsole'
import { buildRows, useDomTree } from '../../hooks/useDomTree'
import { useIntercept } from '../../hooks/useIntercept'
import { useNetworkRequests } from '../../hooks/useNetworkRequests'
import { useRepeater } from '../../hooks/useRepeater'
import { useResources } from '../../hooks/useResources'
import ApplicationPanel from './ApplicationPanel'
import Breadcrumbs from './Breadcrumbs'
import ConsolePanel from './ConsolePanel'
import DevToolsToolbar, { type DevToolsTab } from './DevToolsToolbar'
import ElementsTree from './ElementsTree'
import InterceptPanel from './InterceptPanel'
import NetworkPanel from './NetworkPanel'
import RepeaterPanel from './RepeaterPanel'
import SourcesPanel from './SourcesPanel'
import StylesPane from './StylesPane'

type DevToolsPanelProps = {
  /** Changes when the user switches tabs; the page inspector doesn't carry over. */
  activeTabId: number | null
  onNodeDragStart: (node: NodeRef) => void
  onNodeDragEnd: () => void
  style?: CSSProperties
}

function DevToolsPanel({
  activeTabId,
  onNodeDragStart,
  onNodeDragEnd,
  style
}: DevToolsPanelProps): JSX.Element {
  const { state, loaded, toggle, select } = useDomTree()
  const [rules, setRules] = useState<StyleRule[] | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const [devtoolsTab, setDevtoolsTab] = useState<DevToolsTab>('elements')
  const rows = useMemo(() => buildRows(state), [state])
  const networkRequests = useNetworkRequests(activeTabId)
  const repeater = useRepeater()
  const intercept = useIntercept()
  const consoleApi = useConsole()
  const { resources, loaded: resourcesLoaded } = useResources(activeTabId)
  const application = useApplication(activeTabId)

  useEffect(() => setInspecting(false), [activeTabId])

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
                onSelect={select}
                onToggle={toggle}
                onHover={(id) => void window.reconix.devtools.highlight(id)}
                onNodeDragStart={onNodeDragStart}
                onNodeDragEnd={onNodeDragEnd}
              />
            ) : (
              <p className="dt-empty">Inspector unavailable.</p>
            )}
            <Breadcrumbs state={state} />
          </div>
          <StylesPane rules={rules} />
        </div>
      )}
      {devtoolsTab === 'network' && <NetworkPanel requests={networkRequests} />}
      {devtoolsTab === 'repeater' && <RepeaterPanel api={repeater} />}
      {devtoolsTab === 'intercept' && <InterceptPanel api={intercept} />}
      {devtoolsTab === 'console' && (
        <ConsolePanel entries={consoleApi.entries} onEvaluate={consoleApi.evaluate} />
      )}
      {devtoolsTab === 'sources' && <SourcesPanel resources={resources} loaded={resourcesLoaded} />}
      {devtoolsTab === 'application' && <ApplicationPanel application={application} />}
    </section>
  )
}

export default DevToolsPanel
