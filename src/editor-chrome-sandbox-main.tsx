import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { EditorChromeSandbox } from './pages/EditorChromeSandbox'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <EditorChromeSandbox />
  </StrictMode>,
)
