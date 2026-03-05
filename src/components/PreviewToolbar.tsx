import { PictureInPicture2, Scan, Minimize2, Columns2, Rows2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
        <Button
          variant="ghost"
          size="icon-xs"
          title="Exit full window (F / Esc)"
          className={inactive}
          onClick={() => setPreviewMode(previousPreviewMode === 'fullwindow' ? 'docked' : previousPreviewMode)}
        >
          <Minimize2 />
        </Button>
      </div>
    )
  }

  return (
    <div className={cn(ds.previewToolbar.wrapper, className)}>
      <div
        className={ds.previewToolbar.root}
      >
        <Button
          variant="ghost"
          size="icon-xs"
          title="Vertical split"
          className={isDockedV ? active : inactive}
          onClick={() => { if (isDockedV) { toggleSplitSwapped() } else { setPreviewMode('docked'); setSplitDirection('vertical') } }}
        >
          <Rows2 />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          title="Horizontal split"
          className={isDockedH ? active : inactive}
          onClick={() => { if (isDockedH) { toggleSplitSwapped() } else { setPreviewMode('docked'); setSplitDirection('horizontal') } }}
        >
          <Columns2 />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          title="Floating"
          className={previewMode === 'floating' ? active : inactive}
          onClick={() => setPreviewMode('floating')}
        >
          <PictureInPicture2 />
        </Button>
      </div>
      <div className={ds.previewToolbar.root}>
        <Button
          variant="ghost"
          size="icon-xs"
          title="Full window (F)"
          className={inactive}
          onClick={() => setPreviewMode('fullwindow')}
        >
          <Scan />
        </Button>
      </div>
    </div>
  )
}
