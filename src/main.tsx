import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initializeNodeLibrary } from './nodes'
import { installDevBridge } from './dev-bridge'

// Initialize node library (register all node types)
initializeNodeLibrary()

// Expose stores/registry/compiler on window.__sombra for browser automation
installDevBridge()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
