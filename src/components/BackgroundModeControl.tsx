import { IconButton } from '@/components/IconButton'
import { useSettingsStore } from '@/stores/settingsStore'
import { cn } from '@/lib/utils'
import { ds } from '@/generated/ds'

interface BackgroundModeControlProps {
  className?: string
}

/**
 * Preview background modes (checker / solid+color / none). Reads and writes the
 * single `previewBackground` setting, so every instance stays in lockstep — the
 * preview overlay control and the mirrored copy on the Fragment Output node are
 * the same state. Order is ergonomic: the color swatch sits directly after the
 * Solid button it configures, with None last.
 */
export function BackgroundModeControl({ className }: BackgroundModeControlProps) {
  const previewBackground = useSettingsStore((s) => s.previewBackground)
  const setPreviewBackground = useSettingsStore((s) => s.setPreviewBackground)

  const active = ds.button.ghostActive
  const inactive = ds.button.ghost

  return (
    <div className={cn(ds.previewToolbar.root, 'nodrag nowheel', className)}>
      <IconButton
        icon="grid"
        title="Background: checker"
        className={previewBackground.mode === 'checker' ? active : inactive}
        onClick={() => setPreviewBackground({ mode: 'checker' })}
      />
      <IconButton
        icon="square"
        title="Background: solid"
        className={previewBackground.mode === 'solid' ? active : inactive}
        onClick={() => setPreviewBackground({ mode: 'solid' })}
      />
      {previewBackground.mode === 'solid' && (
        <input
          type="color"
          value={previewBackground.color}
          onChange={(e) => setPreviewBackground({ color: e.target.value })}
          title="Background color"
          className="size-btn-md rounded-sm border border-edge bg-transparent cursor-pointer"
        />
      )}
      <IconButton
        icon="ban"
        title="Background: none"
        className={previewBackground.mode === 'none' ? active : inactive}
        onClick={() => setPreviewBackground({ mode: 'none' })}
      />
    </div>
  )
}
