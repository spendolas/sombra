import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { SegmentedControlSandbox } from './pages/SegmentedControlSandbox'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SegmentedControlSandbox />
  </StrictMode>,
)
