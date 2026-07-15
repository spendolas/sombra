import { IconButton } from '@/components/IconButton'
import { RgbaColorPicker, type Rgba } from '@/components/RgbaColorPicker'
import { useSettingsStore } from '@/stores/settingsStore'
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
        <RgbaColorPicker
          mode="popover"
          showAlpha={false}
          value={cssColorToRgba(previewBackground.color)}
          onChange={(rgba) => setPreviewBackground({ color: rgbaToCssColor(rgba) })}
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
