import { createRoot } from 'react-dom/client'
import './index.css'
import { initializeNodeLibrary } from './nodes'
import { SrtRendererSandbox } from './pages/SrtRendererSandbox'

initializeNodeLibrary()

// No StrictMode: its dev double-invoke mounts → disposes → remounts the WebGPU
// renderer, and disposing destroys the shared GPUDevice, leaving a dead canvas.
// The renderer owns imperative GPU state; a single mount is correct here.
createRoot(document.getElementById('root')!).render(<SrtRendererSandbox />)
