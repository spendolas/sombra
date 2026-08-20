import { IconButton } from '@/components/IconButton'
import { RgbaColorPicker, type Rgba } from '@/components/RgbaColorPicker'
import { AmdSeeThroughWarning } from '@/components/AmdSeeThroughWarning'
import { useSettingsStore } from '@/stores/settingsStore'
import { useCompilerStore } from '@/stores/compilerStore'
import { effectiveBackground, seeThroughAvailable } from '@/utils/preview-background'
import { cn } from '@/lib/utils'
import { ds } from '@/generated/ds'

interface BackgroundModeControlProps {
  className?: string
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v))
}

/** Parse a CSS color string (#rgb / #rrggbb / #rrggbbaa / rgb()/rgba()) into [r,g,b,a] 0-1 floats. */
function cssColorToRgba(css: string): Rgba {
  const trimmed = css.trim()

  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(trimmed)
  if (hexMatch) {
    let hex = hexMatch[1]
    if (hex.length === 3) {
      hex = hex.split('').map((c) => c + c).join('')
    }
    const r = parseInt(hex.slice(0, 2), 16) / 255
    const g = parseInt(hex.slice(2, 4), 16) / 255
    const b = parseInt(hex.slice(4, 6), 16) / 255
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
    return [r, g, b, a]
  }

  const rgbaMatch = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(trimmed)
  if (rgbaMatch) {
    const r = clamp01(Number(rgbaMatch[1]) / 255)
    const g = clamp01(Number(rgbaMatch[2]) / 255)
    const b = clamp01(Number(rgbaMatch[3]) / 255)
    const a = rgbaMatch[4] !== undefined ? clamp01(Number(rgbaMatch[4])) : 1
    return [r, g, b, a]
  }

  // Unknown format (e.g. a named color) — fall back to opaque black.
  return [0, 0, 0, 1]
}

/** Serialize [r,g,b,a] back to a CSS color string — #rrggbb when opaque, rgba() otherwise. */
function rgbaToCssColor([r, g, b, a]: Rgba): string {
  const R = Math.round(clamp01(r) * 255)
  const G = Math.round(clamp01(g) * 255)
  const B = Math.round(clamp01(b) * 255)
  if (a >= 1) {
    const toHex = (n: number) => n.toString(16).padStart(2, '0')
    return `#${toHex(R)}${toHex(G)}${toHex(B)}`
  }
  return `rgba(${R}, ${G}, ${B}, ${Number(a.toFixed(3))})`
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
  const previewMode = useSettingsStore((s) => s.previewMode)
  const fragmentShader = useCompilerStore((s) => s.fragmentShader)
  const outputHasAlpha = useCompilerStore((s) => s.outputHasAlpha)

  const active = ds.button.ghostActive
  const inactive = ds.button.ghost

  // No compiled shader means the DVD placeholder owns the preview; fully opaque
  // output means every background mode is a no-op. Hide the switcher in both
  // cases rather than offer controls that cannot affect what is visible.
  if (!fragmentShader || !outputHasAlpha) return null

  // Highlight the mode actually in effect: see-through collapses to checker where
  // it isn't available (docked/fullwindow), and the eye button is hidden there.
  const effMode = effectiveBackground(previewBackground, previewMode).mode
  const showSeeThrough = seeThroughAvailable(previewMode)

  return (
    <div className={cn('flex items-center gap-md', className)}>
      <div className={cn(ds.previewToolbar.root, 'nodrag nowheel')}>
        <IconButton
          icon="chessKnight"
          title="Background: checker"
          className={effMode === 'checker' ? active : inactive}
          onClick={() => setPreviewBackground({ mode: 'checker' })}
        />
        {showSeeThrough && (
          <IconButton
            icon="eye"
            title="Background: see-through (transparent — shows the UI behind)"
            className={effMode === 'none' ? active : inactive}
            onClick={() => setPreviewBackground({ mode: 'none' })}
          />
        )}
        <IconButton
          icon="paintBucket"
          title="Background: solid"
          className={effMode === 'solid' ? active : inactive}
          onClick={() => setPreviewBackground({ mode: 'solid' })}
        />
        {previewBackground.mode === 'solid' && (
          <RgbaColorPicker
            mode="popover"
            showAlpha={false}
            value={cssColorToRgba(previewBackground.color)}
            onChange={(rgba) => setPreviewBackground({ color: rgbaToCssColor(rgba) })}
          />
        )}
      </div>
      <AmdSeeThroughWarning />
    </div>
  )
}
