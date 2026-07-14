import type { RefObject } from 'react'
import { PreviewToolbar } from './PreviewToolbar'
import { ShaderPlaceholder } from './ShaderPlaceholder'
import { useCompilerStore } from '../stores/compilerStore'
import { useSettingsStore } from '../stores/settingsStore'
import { ds } from '@/generated/ds'

interface PreviewPanelProps {
  targetRef: RefObject<HTMLDivElement | null>
}

// Runtime-dynamic backdrop values (checker tile + user-picked solid color) —
// documented CLAUDE.md exception to the "no inline style" rule.
const checkerStyle = {
  backgroundImage:
    'linear-gradient(45deg,#0000 75%,#00000022 0),linear-gradient(45deg,#00000022 25%,#0000 0),linear-gradient(-45deg,#0000 75%,#00000022 0),linear-gradient(-45deg,#00000022 25%,#0000 0)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0,8px 0,8px -8px,0 8px',
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
  const previewBackground = useSettingsStore((s) => s.previewBackground)

  return (
    <div className={ds.previewPanel.root}>
      {previewBackground.mode !== 'none' && (
        <div
          aria-hidden
          // The canvas host below is a plain (non-positioned) div, so an absolutely
          // positioned sibling with z-index >= 0 would actually paint ABOVE it per
          // CSS stacking rules — a negative z-index is required to stay behind it.
          className="absolute inset-0 -z-10 pointer-events-none"
          style={previewBackground.mode === 'checker' ? checkerStyle : { background: previewBackground.color }}
        />
      )}
      <PreviewToolbar className="absolute top-xl right-xl z-10" />
      <div ref={targetRef} className="w-full h-full" />
      <ShaderPlaceholder />
      <CompileErrorBanner />
    </div>
  )
}
