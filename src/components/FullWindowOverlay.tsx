import type { RefObject } from 'react'
import { PreviewToolbar } from './PreviewToolbar'

interface FullWindowOverlayProps {
  targetRef: RefObject<HTMLDivElement | null>
}

export function FullWindowOverlay({ targetRef }: FullWindowOverlayProps) {
  return (
    <div className="fixed inset-0 z-50 bg-black">
      <div ref={targetRef} className="w-full h-full" />
      <PreviewToolbar className="absolute top-2 right-2 z-10" />
    </div>
  )
}
