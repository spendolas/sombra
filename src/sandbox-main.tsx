import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { SandboxShell } from './sandbox/SandboxShell'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SandboxShell />
  </StrictMode>,
)
