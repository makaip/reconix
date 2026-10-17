import CopilotPanel from './components/copilot/CopilotPanel'
import Sidebar from './components/sidebar/Sidebar'
import ViewSlot from './components/ViewSlot'

const setTargetBounds = window.reconix.target.setBounds

function App(): JSX.Element {
  return (
    <div className="shell">
      <Sidebar />

      <main className="center">
        <section className="viewport" aria-label="Target page">
          <ViewSlot className="viewport__slot" onBoundsChange={setTargetBounds} />
        </section>
        <section className="devtools" aria-label="Developer tools" />
      </main>

      <CopilotPanel />
    </div>
  )
}

export default App
