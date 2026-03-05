import type { RefObject } from 'react'
import { PreviewToolbar } from './PreviewToolbar'
import { cn } from '@/lib/utils'
import { ds } from '@/generated/ds'

interface FullWindowOverlayProps {
  targetRef: RefObject<HTMLDivElement | null>
}

export function FullWindowOverlay({ targetRef }: FullWindowOverlayProps) {
  return (
    <div className={cn(ds.fullWindowOverlay.root, "fixed inset-0 z-50")}>
      <div ref={targetRef} className="w-full h-full" />
      <PreviewToolbar className="absolute top-md right-md z-10" />
    </div>
  )
}
