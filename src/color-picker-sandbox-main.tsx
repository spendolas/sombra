import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { ColorPickerSandbox } from './pages/ColorPickerSandbox'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ColorPickerSandbox />
  </StrictMode>,
)
