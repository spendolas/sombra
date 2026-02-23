import type { RefObject } from 'react'
import { PreviewToolbar } from './PreviewToolbar'

interface PreviewPanelProps {
  targetRef: RefObject<HTMLDivElement | null>
}

export function PreviewPanel({ targetRef }: PreviewPanelProps) {
  return (
    <div className="relative w-full h-full bg-black">
      <PreviewToolbar className="absolute top-2 right-2 z-10" />
      <div ref={targetRef} className="w-full h-full" />
    </div>
  )
}
