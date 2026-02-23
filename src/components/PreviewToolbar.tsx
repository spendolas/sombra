import { PictureInPicture2, Scan, Columns2, Rows2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSettingsStore } from '@/stores/settingsStore'
import { cn } from '@/lib/utils'

interface PreviewToolbarProps {
  className?: string
}

export function PreviewToolbar({ className }: PreviewToolbarProps) {
  const previewMode = useSettingsStore((s) => s.previewMode)
  const splitDirection = useSettingsStore((s) => s.splitDirection)
  const setPreviewMode = useSettingsStore((s) => s.setPreviewMode)
  const setSplitDirection = useSettingsStore((s) => s.setSplitDirection)

  const isDockedH = previewMode === 'docked' && splitDirection === 'horizontal'
  const isDockedV = previewMode === 'docked' && splitDirection === 'vertical'

  const active = 'bg-indigo text-fg hover:bg-indigo cursor-default'
  const inactive = 'text-fg-dim hover:bg-surface-elevated hover:text-fg cursor-pointer'

  return (
    <div
      className={cn(
        'flex items-center gap-1.5 text-xs px-2 py-1 rounded bg-surface-raised text-fg-dim',
        className
      )}
    >
      <Button
        variant="ghost"
        size="icon-xs"
        title="Vertical split"
        className={isDockedV ? active : inactive}
        onClick={() => { setPreviewMode('docked'); setSplitDirection('vertical') }}
      >
        <Rows2 />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        title="Horizontal split"
        className={isDockedH ? active : inactive}
        onClick={() => { setPreviewMode('docked'); setSplitDirection('horizontal') }}
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
      <Button
        variant="ghost"
        size="icon-xs"
        title="Full window"
        className={previewMode === 'fullwindow' ? active : inactive}
        onClick={() => setPreviewMode('fullwindow')}
      >
        <Scan />
      </Button>
    </div>
  )
}
