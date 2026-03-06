import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initializeNodeLibrary, bindNodeComponents } from './nodes'
import { installDevBridge } from './dev-bridge'

// Initialize node library (register all node types)
initializeNodeLibrary()

// Attach React components to node definitions (main thread only)
bindNodeComponents()

// Expose stores/registry/compiler on window.__sombra for browser automation
installDevBridge()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
