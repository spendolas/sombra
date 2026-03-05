import { IconButton } from '@/components/IconButton'
import { useSettingsStore } from '@/stores/settingsStore'
import { cn } from '@/lib/utils'
import { ds } from '@/generated/ds'

interface PreviewToolbarProps {
  className?: string
}

export function PreviewToolbar({ className }: PreviewToolbarProps) {
  const previewMode = useSettingsStore((s) => s.previewMode)
  const previousPreviewMode = useSettingsStore((s) => s.previousPreviewMode)
  const splitDirection = useSettingsStore((s) => s.splitDirection)
  const setPreviewMode = useSettingsStore((s) => s.setPreviewMode)
  const setSplitDirection = useSettingsStore((s) => s.setSplitDirection)
  const toggleSplitSwapped = useSettingsStore((s) => s.toggleSplitSwapped)

  const isDockedH = previewMode === 'docked' && splitDirection === 'horizontal'
  const isDockedV = previewMode === 'docked' && splitDirection === 'vertical'

  const active = ds.previewToolbar.buttonActive
  const inactive = ds.previewToolbar.buttonInactive

  // In fullwindow mode, only show a collapse button
  if (previewMode === 'fullwindow') {
    return (
      <div
        className={cn(
          ds.previewToolbar.root,
          className
        )}
      >
        <IconButton
          icon="minimize"
          title="Exit full window (F / Esc)"
          className={inactive}
          onClick={() => setPreviewMode(previousPreviewMode === 'fullwindow' ? 'docked' : previousPreviewMode)}
        />
      </div>
    )
  }

  return (
    <div className={cn(ds.previewToolbar.wrapper, className)}>
      <div
        className={ds.previewToolbar.root}
      >
        <IconButton
          icon="rows"
          title="Vertical split"
          className={isDockedV ? active : inactive}
          onClick={() => { if (isDockedV) { toggleSplitSwapped() } else { setPreviewMode('docked'); setSplitDirection('vertical') } }}
        />
        <IconButton
          icon="columns"
          title="Horizontal split"
          className={isDockedH ? active : inactive}
          onClick={() => { if (isDockedH) { toggleSplitSwapped() } else { setPreviewMode('docked'); setSplitDirection('horizontal') } }}
        />
        <IconButton
          icon="pip"
          title="Floating"
          className={previewMode === 'floating' ? active : inactive}
          onClick={() => setPreviewMode('floating')}
        />
      </div>
      <div className={ds.previewToolbar.root}>
        <IconButton
          icon="scan"
          title="Full window (F)"
          className={inactive}
          onClick={() => setPreviewMode('fullwindow')}
        />
      </div>
    </div>
  )
}
