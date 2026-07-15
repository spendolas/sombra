import type { RefObject } from 'react'
import { PreviewToolbar } from './PreviewToolbar'
import { BackgroundModeControl } from './BackgroundModeControl'
import { ShaderPlaceholder } from './ShaderPlaceholder'
import { PreviewBackdrop } from './PreviewBackdrop'
import { useCompilerStore } from '../stores/compilerStore'
import { useSettingsStore } from '../stores/settingsStore'
import { ds } from '@/generated/ds'

interface PreviewPanelProps {
  targetRef: RefObject<HTMLDivElement | null>
}

/**
 * Compile-error banner — the errors have always been in compilerStore
 * (node-attributed); this is their first UI consumer. Without it, any
 * compile failure was a silent placeholder/stale canvas.
 */
function CompileErrorBanner() {
  const errors = useCompilerStore((s) => s.errors)
  if (errors.length === 0) return null
  const shown = errors.slice(0, 3)
  return (
    <div className="absolute bottom-xl left-xl z-10 max-w-[min(60%,480px)] rounded-md bg-surface-raised/95 border border-edge px-md py-sm pointer-events-none">
      <div className="text-section text-error">Shader error</div>
      {shown.map((e, i) => (
        <div key={i} className="text-body text-fg-dim truncate">
          {e.message}
        </div>
      ))}
      {errors.length > shown.length && (
        <div className="text-param text-fg-muted">+{errors.length - shown.length} more</div>
      )}
    </div>
  )
}

export function PreviewPanel({ targetRef }: PreviewPanelProps) {
  // See-through mode: strip the panel's opaque scrim so a transparent shader
  // composites all the way through to the Sombra UI behind the preview.
  const seeThrough = useSettingsStore((s) => s.previewBackground.mode === 'none')
  return (
    <div className={ds.previewPanel.root + ' isolate' + (seeThrough ? ' !bg-transparent' : '')}>
      <PreviewBackdrop />
      <BackgroundModeControl className="absolute top-xl left-xl z-10" />
      <PreviewToolbar className="absolute top-xl right-xl z-10" />
      <div ref={targetRef} className="w-full h-full" />
      <ShaderPlaceholder />
      <CompileErrorBanner />
    </div>
  )
}
