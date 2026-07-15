import type { RefObject } from 'react'
import { PreviewToolbar } from './PreviewToolbar'
import { BackgroundModeControl } from './BackgroundModeControl'
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
      <BackgroundModeControl className="absolute top-xl left-xl z-10" />
      <PreviewToolbar className="absolute top-xl right-xl z-10" />
    </div>
  )
}
