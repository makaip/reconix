import CopilotPanel from './components/copilot/CopilotPanel'
import Sidebar from './components/sidebar/Sidebar'
import ViewSlot from './components/ViewSlot'

function App(): JSX.Element {
  return (
    <div className="shell">
      <Sidebar />

      <main className="center">
        <section className="viewport" aria-label="Target page">
          <ViewSlot view="page" className="viewport__slot" />
        </section>
        <section className="devtools" aria-label="Developer tools">
          <ViewSlot view="devtools" className="devtools__slot" />
        </section>
      </main>

      <CopilotPanel />
    </div>
  )
}

export default App
