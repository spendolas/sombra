import type { RefObject } from 'react'
import { PreviewToolbar } from './PreviewToolbar'
import { BackgroundModeControl } from './BackgroundModeControl'
import { GizmoViewControl } from './GizmoViewControl'
import { ShaderPlaceholder } from './ShaderPlaceholder'
import { PreviewBackdrop } from './PreviewBackdrop'
import { useSettingsStore } from '@/stores/settingsStore'
import { ds } from '@/generated/ds'

interface FullWindowOverlayProps {
  targetRef: RefObject<HTMLDivElement | null>
}

export function FullWindowOverlay({ targetRef }: FullWindowOverlayProps) {
  const seeThrough = useSettingsStore((s) => s.previewBackground.mode === 'none')
  return (
    <div className={ds.fullWindowOverlay.root + ' isolate' + (seeThrough ? ' !bg-transparent' : '')}>
      <PreviewBackdrop />
      <div ref={targetRef} className="w-full h-full" />
      <ShaderPlaceholder />
      <div className="absolute top-xl left-xl z-10 flex items-center gap-md">
        {/* Coords-view switch (its own group) sits LEFT of the alpha modes */}
        <GizmoViewControl />
        <BackgroundModeControl />
      </div>
      <PreviewToolbar className="absolute top-xl right-xl z-10" />
    </div>
  )
}
