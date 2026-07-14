import type { RefObject } from 'react'
import { PreviewToolbar } from './PreviewToolbar'
import { ShaderPlaceholder } from './ShaderPlaceholder'
import { PreviewBackdrop } from './PreviewBackdrop'
import { ds } from '@/generated/ds'

interface FullWindowOverlayProps {
  targetRef: RefObject<HTMLDivElement | null>
}

export function FullWindowOverlay({ targetRef }: FullWindowOverlayProps) {
  return (
    <div className={ds.fullWindowOverlay.root + ' isolate'}>
      <PreviewBackdrop />
      <div ref={targetRef} className="w-full h-full" />
      <ShaderPlaceholder />
      <PreviewToolbar className="absolute top-xl right-xl z-10" />
    </div>
  )
}
