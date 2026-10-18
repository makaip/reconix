import { lazy, Suspense, useEffect, useState } from 'react'
import Sidebar from './components/sidebar/Sidebar'
import Splash from './components/Splash'
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
import { useSettings } from './hooks/useSettings'
import { useTabs } from './hooks/useTabs'
import { useUsage } from './hooks/useUsage'

// Heavy panels are code-split so the initial bundle stays small; each loads on
// first use. The fallbacks are deliberately minimal to avoid layout shift.
const CopilotPanel = lazy(() => import('./components/copilot/CopilotPanel'))
const DevToolsPanel = lazy(() => import('./components/devtools/DevToolsPanel'))
const SettingsModal = lazy(() => import('./components/SettingsModal'))
const TracesPanel = lazy(() => import('./components/TracesPanel'))
const UsagePanel = lazy(() => import('./components/UsagePanel'))

const PanelFallback = (): JSX.Element => <div className="dock__panel" aria-busy="true" />

const setTargetBounds = window.reconix.target.setBounds

function App(): JSX.Element {
  const copilot = useCopilot()
  const engineStatus = useEngineStatus()
  const tabs = useTabs()
  const network = useNetworkStats()
  const usage = useUsage()
  const settings = useSettings()
  const [dragActive, setDragActive] = useState(false)
  const [copilotTargetId, setCopilotTargetId] = useState<number | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const [tracesOpen, setTracesOpen] = useState(false)
  // Launch-time panel visibility comes from settings; the user can still toggle at runtime.
  const [copilotOpen, setCopilotOpen] = useState(settings.settings.openCopilotOnLaunch)
  const [sidebarOpen, setSidebarOpen] = useState(settings.settings.openSidebarOnLaunch)

  // Cmd+, on macOS, Ctrl+, elsewhere — the OS-standard "open preferences" shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = window.reconix.platform === 'darwin' ? e.metaKey : e.ctrlKey
      if (mod && e.key === ',') {
        e.preventDefault()
        setUsageOpen(false)
        setTracesOpen(false)
        setSettingsOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // File ▸ Preferences in the native app menu opens the settings panel.
  useEffect(() => {
    return window.reconix.menu.onOpenSettings(() => {
      setUsageOpen(false)
      setTracesOpen(false)
      setSettingsOpen(true)
    })
  }, [])
  // Set when a sitemap file is double-clicked, so DevTools opens it in Sources. The counter
  // forces a re-open even when the same file is double-clicked twice in a row.
  const [openSource, setOpenSource] = useState<{ target: string; nonce: number } | null>(null)

  // Panel sizes are drag-resizable; see shell.css for the matching defaults these fall back to.
  // Dragging the sidebar edge far enough left collapses it; the toolbar button brings it back.
  const sidebarResize = useResizable({
    axis: 'x',
    initial: 240,
    min: 180,
    max: 480,
    onCollapse: () => setSidebarOpen(false)
  })
  const copilotResize = useResizable({ axis: 'x', initial: 360, min: 280, max: 560, invert: true })
  // Settings and cost/latency dock here instead of as centered modals: the target
  // page is a native view that paints above the window's HTML, so an overlay would
  // hide behind it. A docked column shrinks the page slot (the native view follows
  // the slot's bounds) and never covers it.
  const dockResize = useResizable({ axis: 'x', initial: 440, min: 320, max: 720, invert: true })
  // DevTools opens at a quarter of the window height.
  const devtoolsResize = useResizable({
    axis: 'y',
    initial: Math.round(window.innerHeight * 0.25),
    min: 160,
    max: 640,
    invert: true
  })

  const activeTab = tabs.tabs.find((tab) => tab.id === tabs.activeId)
  const copilotTargetTab = tabs.tabs.find((tab) => tab.id === copilotTargetId)
  const copilotRequestCount = copilotTargetId === null ? 0 : (network.perTab[copilotTargetId] ?? 0)
  // The dock borrows the Copilot's slot on the right, so only one right column shows.
  // Settings is a centered modal, not a dock column, so only usage/traces dock here.
  const dockOpen = usageOpen || tracesOpen

  // Hide the native target views while the settings modal is up: the page view is a
  // native layer that would otherwise paint over the HTML modal.
  useEffect(() => {
    void window.reconix.target.setOverlay(settingsOpen)
  }, [settingsOpen])

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
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        copilotOpen={copilotOpen}
        onToggleCopilot={() => setCopilotOpen((open) => !open)}
        navDisabled={engineStatus.status === 'starting'}
      />

      <div className="shell">
        {sidebarOpen && (
          <>
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
          </>
        )}

        <main className="center">
          <section className="viewport" aria-label="Target page">
            <ViewSlot
              className="viewport__slot"
              onBoundsChange={setTargetBounds}
              agentActive={copilot.browserActive && tabs.activeId === copilotTargetId}
            />
            {activeTab && !activeTab.url && <Splash />}
          </section>
          <ResizeHandle
            orientation="horizontal"
            dragging={devtoolsResize.dragging}
            onPointerDown={devtoolsResize.onHandlePointerDown}
          />
          <Suspense fallback={<PanelFallback />}>
            <DevToolsPanel
              activeTabId={tabs.activeId}
              targetUrl={activeTab?.url ?? ''}
              onDragStart={() => setDragActive(true)}
              onDragEnd={() => setDragActive(false)}
              openSource={openSource}
              style={{ flexBasis: devtoolsResize.size }}
            />
          </Suspense>
        </main>

        {copilotOpen && !dockOpen && (
          <>
            <ResizeHandle
              orientation="vertical"
              dragging={copilotResize.dragging}
              onPointerDown={copilotResize.onHandlePointerDown}
            />
            <Suspense fallback={<PanelFallback />}>
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
            </Suspense>
          </>
        )}

        {dockOpen && (
          <>
            <ResizeHandle
              orientation="vertical"
              dragging={dockResize.dragging}
              onPointerDown={dockResize.onHandlePointerDown}
            />
            <aside className="dock" style={{ flexBasis: dockResize.size }}>
              <Suspense fallback={<PanelFallback />}>
                {usageOpen && <UsagePanel usage={usage} onClose={() => setUsageOpen(false)} />}
                {tracesOpen && <TracesPanel onClose={() => setTracesOpen(false)} />}
              </Suspense>
            </aside>
          </>
        )}
      </div>

      <StatusBar
        requests={network.total}
        usage={usage}
        onOpenUsage={() => {
          setSettingsOpen(false)
          setTracesOpen(false)
          setUsageOpen((open) => !open)
        }}
        onOpenTraces={() => {
          setSettingsOpen(false)
          setUsageOpen(false)
          setTracesOpen((open) => !open)
        }}
      />

      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal settings={settings} onClose={() => setSettingsOpen(false)} />
        </Suspense>
      )}
    </div>
  )
}

export default App
