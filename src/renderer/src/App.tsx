import { useEffect, useState } from 'react'
import CopilotPanel from './components/copilot/CopilotPanel'
import DevToolsPanel from './components/devtools/DevToolsPanel'
import Sidebar from './components/sidebar/Sidebar'
import ViewSlot from './components/ViewSlot'
import EngineStatusBanner from './components/chrome/EngineStatusBanner'
import ResizeHandle from './components/chrome/ResizeHandle'
import StatusBar from './components/chrome/StatusBar'
import TabBar from './components/chrome/TabBar'
import Toolbar from './components/chrome/Toolbar'
import { useCopilot } from './hooks/useCopilot'
import { useEngineStatus } from './hooks/useEngineStatus'
import { useNetworkStats } from './hooks/useNetworkStats'
import { useResizable } from './hooks/useResizable'
import { useTabs } from './hooks/useTabs'

const setTargetBounds = window.reconix.target.setBounds

function App(): JSX.Element {
  const copilot = useCopilot()
  const engineStatus = useEngineStatus()
  const tabs = useTabs()
  const network = useNetworkStats()
  const [dragActive, setDragActive] = useState(false)
  const [copilotOpen, setCopilotOpen] = useState(true)
  const [copilotTargetId, setCopilotTargetId] = useState<number | null>(null)
  // Set when a sitemap file is double-clicked, so DevTools opens it in Sources. The counter
  // forces a re-open even when the same file is double-clicked twice in a row.
  const [openSource, setOpenSource] = useState<{ target: string; nonce: number } | null>(null)

  // Panel sizes are drag-resizable; see shell.css for the matching defaults these fall back to.
  const sidebarResize = useResizable({ axis: 'x', initial: 240, min: 180, max: 480 })
  const copilotResize = useResizable({ axis: 'x', initial: 360, min: 280, max: 560, invert: true })
  const devtoolsResize = useResizable({ axis: 'y', initial: 380, min: 160, max: 640, invert: true })

  const activeTab = tabs.tabs.find((tab) => tab.id === tabs.activeId)
  const copilotTargetTab = tabs.tabs.find((tab) => tab.id === copilotTargetId)
  const copilotRequestCount = copilotTargetId === null ? 0 : (network.perTab[copilotTargetId] ?? 0)

  useEffect(() => {
    void window.reconix.copilot.getTargetTab().then(setCopilotTargetId)
  }, [])

  useEffect(() => {
    if (tabs.activeId === null || copilotTargetTab) return
    void window.reconix.copilot.setTargetTab(tabs.activeId).then((ok) => {
      if (ok) setCopilotTargetId(tabs.activeId)
    })
  }, [copilotTargetTab, tabs.activeId])

  return (
    <div className="app">
      <TabBar
        tabs={tabs.tabs}
        activeId={tabs.activeId}
        onActivate={(id) => void window.reconix.tabs.activate(id)}
        onClose={(id) => void window.reconix.tabs.close(id)}
        onNew={() => void window.reconix.tabs.create()}
        onMove={(id, toIndex) => void window.reconix.tabs.move(id, toIndex)}
        agentActiveId={copilot.browserActive ? copilotTargetId : null}
      />
      <EngineStatusBanner status={engineStatus} />
      <Toolbar
        url={activeTab?.url ?? ''}
        canGoBack={tabs.canGoBack}
        canGoForward={tabs.canGoForward}
        copilotOpen={copilotOpen}
        onToggleCopilot={() => setCopilotOpen((open) => !open)}
        navDisabled={engineStatus.status === 'starting'}
      />

      <div className="shell">
        <Sidebar
          style={{ flexBasis: sidebarResize.size }}
          onDragStart={() => setDragActive(true)}
          onDragEnd={() => setDragActive(false)}
          onOpenSource={(target) => setOpenSource((prev) => ({ target, nonce: (prev?.nonce ?? 0) + 1 }))}
        />
        <ResizeHandle
          orientation="vertical"
          dragging={sidebarResize.dragging}
          onPointerDown={sidebarResize.onHandlePointerDown}
        />

        <main className="center">
          <section className="viewport" aria-label="Target page">
            <ViewSlot
              className="viewport__slot"
              onBoundsChange={setTargetBounds}
              agentActive={copilot.browserActive && tabs.activeId === copilotTargetId}
            />
          </section>
          <ResizeHandle
            orientation="horizontal"
            dragging={devtoolsResize.dragging}
            onPointerDown={devtoolsResize.onHandlePointerDown}
          />
          <DevToolsPanel
            activeTabId={tabs.activeId}
            targetUrl={activeTab?.url ?? ''}
            onDragStart={() => setDragActive(true)}
            onDragEnd={() => setDragActive(false)}
            openSource={openSource}
            style={{ flexBasis: devtoolsResize.size }}
          />
        </main>

        {copilotOpen && (
          <>
            <ResizeHandle
              orientation="vertical"
              dragging={copilotResize.dragging}
              onPointerDown={copilotResize.onHandlePointerDown}
            />
            <CopilotPanel
              copilot={copilot}
              dragActive={dragActive}
              onDrop={() => setDragActive(false)}
              onClose={() => setCopilotOpen(false)}
              requestCount={copilotRequestCount}
              activeTab={copilotTargetTab}
              viewedTab={activeTab}
              onUseViewedTab={() => {
                if (!activeTab) return
                void window.reconix.copilot.setTargetTab(activeTab.id).then((ok) => {
                  if (ok) setCopilotTargetId(activeTab.id)
                })
              }}
              style={{ flexBasis: copilotResize.size }}
            />
          </>
        )}
      </div>

      <StatusBar requests={network.total} />
    </div>
  )
}

export default App
