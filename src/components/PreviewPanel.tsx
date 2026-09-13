import type { RefObject } from 'react'
import { PreviewToolbar } from './PreviewToolbar'
import { BackgroundModeControl } from './BackgroundModeControl'
import { GizmoViewControl } from './GizmoViewControl'
import { ShaderPlaceholder } from './ShaderPlaceholder'
import { PreviewBackdrop } from './PreviewBackdrop'
import { CompileErrorBanner } from './CompileErrorBanner'
import { useSettingsStore } from '../stores/settingsStore'
import { ds } from '@/generated/ds'

interface PreviewPanelProps {
  targetRef: RefObject<HTMLDivElement | null>
}

export function PreviewPanel({ targetRef }: PreviewPanelProps) {
  // See-through mode: strip the panel's opaque scrim so a transparent shader
  // composites all the way through to the Sombra UI behind the preview.
  const seeThrough = useSettingsStore((s) => s.previewBackground.mode === 'none')
  return (
    <div className={ds.previewPanel.root + ' isolate' + (seeThrough ? ' !bg-transparent' : '')}>
      <PreviewBackdrop />
      <div className="absolute top-xl left-xl z-10 flex items-center gap-md">
        {/* Coords-view switch (its own group) sits LEFT of the alpha modes */}
        <GizmoViewControl />
        <BackgroundModeControl />
      </div>
      <PreviewToolbar className="absolute top-xl right-xl z-10" />
      <div ref={targetRef} className="w-full h-full" />
      <ShaderPlaceholder />
      <CompileErrorBanner />
    </div>
  )
}
