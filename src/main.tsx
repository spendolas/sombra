import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary'
import { initializeNodeLibrary, bindNodeComponents } from './nodes'
import { installDevBridge } from './dev-bridge'

// Root backstop: if anything escapes the per-node boundaries, show a recoverable
// message instead of a blank/solid screen (React unmounts the tree on an uncaught throw).
const rootFallback = (
  <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', gap: 12,
    alignItems: 'center', justifyContent: 'center', background: '#0f0f1a', color: '#e8e8f0',
    font: '14px system-ui, sans-serif' }}>
    <div>Something went wrong.</div>
    <button onClick={() => location.reload()}
      style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #3a3a52',
        background: '#6366f1', color: '#fff', cursor: 'pointer' }}>Reload</button>
  </div>
)

// Initialize node library (register all node types)
initializeNodeLibrary()

// Boot: await async component bindings before first render
async function boot() {
  await bindNodeComponents()
  installDevBridge()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary fallback={rootFallback} label="app root">
        <App />
      </ErrorBoundary>
    </StrictMode>,
  )
}
boot()
