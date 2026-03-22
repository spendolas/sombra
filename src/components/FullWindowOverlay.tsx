import type { RefObject } from 'react'
import { PreviewToolbar } from './PreviewToolbar'
import { ShaderPlaceholder } from './ShaderPlaceholder'
import { ds } from '@/generated/ds'

interface FullWindowOverlayProps {
  targetRef: RefObject<HTMLDivElement | null>
}

export function FullWindowOverlay({ targetRef }: FullWindowOverlayProps) {
  return (
    <div className={ds.fullWindowOverlay.root}>
      <div ref={targetRef} className="w-full h-full" />
      <ShaderPlaceholder />
      <PreviewToolbar className="absolute top-xl right-xl z-10" />
    </div>
  )
}
