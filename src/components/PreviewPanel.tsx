import type { RefObject } from 'react'
import { PreviewToolbar } from './PreviewToolbar'
import { useSettingsStore } from '@/stores/settingsStore'

interface PreviewPanelProps {
  targetRef: RefObject<HTMLDivElement | null>
}

export function PreviewPanel({ targetRef }: PreviewPanelProps) {
  const splitDirection = useSettingsStore((s) => s.splitDirection)
  const borderClass = splitDirection === 'vertical' ? 'border-t' : 'border-l'

  return (
    <div className={`relative w-full h-full bg-black ${borderClass} border-edge`}>
      <PreviewToolbar className="absolute top-2 right-2 z-10" />
      <div ref={targetRef} className="w-full h-full" />
    </div>
  )
}
