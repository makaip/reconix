import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/fonts.css'
import './styles/tokens.css'
import './index.css'
import './styles/shell.css'
import './styles/badge.css'
import './styles/sidebar.css'
import './styles/copilot.css'
import './styles/devtools.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
