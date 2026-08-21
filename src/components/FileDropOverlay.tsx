import { ds } from '@/generated/ds'
import { cn } from '@/lib/utils'
import { icons } from '@/components/icons'
import type { DropClassification, FileDropFormat } from '@/utils/file-drop'

export type FileDropOverlayState =
  | { kind: 'preview'; classification: DropClassification }
  | { kind: 'busy'; format: FileDropFormat; fileCount: number }

export function FileDropOverlay({ state }: { state: FileDropOverlayState }) {
  let title: string
  let detail: string
  let tone: 'indigo' | 'warning' | 'error' | 'neutral'
  let icon: 'paintBucket' | 'folderOpen' | 'triangleAlert'

  if (state.kind === 'busy') {
    title = state.format.overlay.busyTitle(state.fileCount)
    detail = state.format.overlay.detail
    tone = state.format.overlay.tone
    icon = state.format.overlay.icon
  } else if (state.classification.status === 'accepted') {
    const { format, fileCount } = state.classification
    title = format.overlay.title(fileCount)
    detail = format.overlay.detail
    tone = format.overlay.tone
    icon = format.overlay.icon
  } else if (state.classification.status === 'unresolved') {
    title = 'Inspect dropped files'
    detail = state.classification.reason
    tone = 'neutral'
    icon = 'folderOpen'
  } else {
    title = state.classification.status === 'mixed' ? 'Choose one import type' : 'Unsupported file drop'
    detail = state.classification.reason
    tone = 'error'
    icon = 'triangleAlert'
  }

  const Icon = icons[icon]
  const toneClass = {
    indigo: 'text-indigo',
    warning: 'text-warning',
    error: 'text-error',
    neutral: 'text-fg-dim',
  }[tone]

  return (
    <div
      className={cn(
        ds.fullWindowOverlay.root,
        'items-center justify-center pointer-events-none',
      )}
      role="status"
      aria-live="polite"
    >
      <div className={cn(ds.propertiesPanel.nodeInfo, 'mx-2xl items-center text-center')}>
        <Icon className={cn('size-icon-md', toneClass, state.kind === 'busy' && 'animate-pulse')} />
        <div className={ds.propertiesPanel.nodeTitle}>{title}</div>
        <div className={ds.propertiesPanel.description}>{detail}</div>
      </div>
    </div>
  )
}
