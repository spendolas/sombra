import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { ds } from '@/generated/ds'
import { cn } from '@/lib/utils'
import { icons } from '@/components/icons'
import { ActionButton } from '@/components/ActionButton'
import type { DropClassification, FileDropFormat } from '@/utils/file-drop'

export type FileDropOverlayState =
  | { kind: 'preview'; classification: DropClassification }
  | { kind: 'busy'; format: FileDropFormat; fileCount: number }

export interface FileDropDialogState {
  title: string
  detail: string
  confirmLabel: string
  cancelLabel?: string
}

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

export function FileDropDialog({
  state,
  onResolve,
}: {
  state: FileDropDialogState
  onResolve: (confirmed: boolean) => void
}) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    confirmRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onResolve(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onResolve])

  return createPortal(
    <div
      className={ds.fileDropDialog.root}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onResolve(false)
      }}
    >
      <div
        className={ds.fileDropDialog.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-drop-dialog-title"
        aria-describedby="file-drop-dialog-detail"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div id="file-drop-dialog-title" className={ds.fileDropDialog.title}>
          {state.title}
        </div>
        <div id="file-drop-dialog-detail" className={ds.fileDropDialog.detail}>
          {state.detail}
        </div>
        <div className={ds.fileDropDialog.actions}>
          {state.cancelLabel && (
            <ActionButton onClick={() => onResolve(false)}>
              {state.cancelLabel}
            </ActionButton>
          )}
          <ActionButton
            ref={confirmRef}
            variant="primary"
            onClick={() => onResolve(true)}
          >
            {state.confirmLabel}
          </ActionButton>
        </div>
      </div>
    </div>,
    document.body,
  )
}
