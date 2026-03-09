import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { DSPreview } from './pages/DSPreview'
import { initializeNodeLibrary, bindNodeComponents } from './nodes'

initializeNodeLibrary()

async function boot() {
  await bindNodeComponents()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <DSPreview />
    </StrictMode>,
  )
}
boot()
