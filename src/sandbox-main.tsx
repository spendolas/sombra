import { createRoot } from 'react-dom/client'
import './index.css'
import { SandboxShell } from './sandbox/SandboxShell'

// No StrictMode: dev double-invoke mounts → disposes → remounts the WebGPU
// renderer, and disposing destroys the shared GPUDevice, leaving a dead
// canvas (srt-renderer harness). The app's real src/main.tsx keeps StrictMode.
createRoot(document.getElementById('root')!).render(<SandboxShell />)
