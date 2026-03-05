import type { RefObject } from 'react'
import { PreviewToolbar } from './PreviewToolbar'
import { ds } from '@/generated/ds'

interface PreviewPanelProps {
  targetRef: RefObject<HTMLDivElement | null>
}

export function PreviewPanel({ targetRef }: PreviewPanelProps) {
  return (
    <div className={ds.previewPanel.root}>
      <PreviewToolbar className="absolute top-md right-md z-10" />
      <div ref={targetRef} className="w-full h-full" />
    </div>
  )
}
