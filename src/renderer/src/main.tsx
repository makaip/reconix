import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/tokens.css'
import './index.css'
import './styles/shell.css'
import './styles/sidebar.css'
import './styles/copilot.css'
import './styles/devtools.css'
import './styles/chrome.css'
import './styles/settings.css'
import './styles/usage.css'

// lets CSS adjust per OS (e.g. room for the macOS traffic lights)
document.documentElement.dataset.platform = window.reconix.platform

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
