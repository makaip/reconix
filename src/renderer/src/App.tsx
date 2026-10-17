import { useState } from 'react'

function App(): JSX.Element {
  const [pong, setPong] = useState<string>('')

  const ping = async (): Promise<void> => {
    setPong(await window.reconix.ping())
  }

  return (
    <main className="app">
      <h1>Reconix</h1>
      <p className="subtitle">AI-driven penetration testing browser</p>
      <button onClick={ping}>Ping main process</button>
      {pong && <p className="pong">IPC reply: {pong}</p>}
    </main>
  )
}

export default App
