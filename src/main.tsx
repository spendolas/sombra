import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initializeNodeLibrary, bindNodeComponents } from './nodes'
import { installDevBridge } from './dev-bridge'

// Initialize node library (register all node types)
initializeNodeLibrary()

// Boot: await async component bindings before first render
async function boot() {
  await bindNodeComponents()
  installDevBridge()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
boot()
