/**
 * ColorSwatch — a color swatch that is a button (an icon button, to be precise).
 * Shows the current color composited over a checkerboard so alpha reads; an
 * OPTIONAL icon (from the DS lucide registry) is overlaid, its ink auto-picked
 * for contrast against the fill. Most swatches want no icon (the plain color
 * button that opens a picker); pass `icon` only where the affordance is needed
 * (currently just the export-matte custom color).
 *
 * Forwards its ref to the <button> so callers can anchor a popover to it.
 */

import { forwardRef } from 'react'
import { icons, type IconName } from '@/components/icons'
import { cn } from '@/lib/utils'
import { ds } from '@/generated/ds'

const CHECKER_STYLE: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg,rgba(128,128,128,.4) 25%,transparent 25%),linear-gradient(-45deg,rgba(128,128,128,.4) 25%,transparent 25%),' +
    'linear-gradient(45deg,transparent 75%,rgba(128,128,128,.4) 75%),linear-gradient(-45deg,transparent 75%,rgba(128,128,128,.4) 75%)',
  backgroundSize: '8px 8px', backgroundPosition: '0 0,0 4px,4px -4px,-4px 0',
}
const to255 = (x: number) => Math.round(x * 255)
// Ink for an icon drawn on the swatch. The fill is composited over the swatch's
// checkerboard (which, on Sombra's dark surfaces, reads as a dark grey) at the
// given alpha, so a translucent colour picks a light glyph — a dark glyph would
// vanish once the transparent checker shows through.
const CHECKER_BACKDROP_L = 0.18
const contrastInk = (r: number, g: number, b: number, a: number) => {
  const lColor = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const l = a * lColor + (1 - a) * CHECKER_BACKDROP_L
  return l > 0.55 ? '#141420' : '#ffffff'
}

type ColorSwatchProps = Omit<React.ComponentProps<'button'>, 'color' | 'value'> & {
  /** normalized [r,g,b,a] floats (0-1) */
  value: [number, number, number, number]
  /** optional DS icon overlaid on the swatch */
  icon?: IconName
}

export const ColorSwatch = forwardRef<HTMLButtonElement, ColorSwatchProps>(
  ({ value, icon, className, ...props }, ref) => {
    const [r, g, b, a] = value
    const Icon = icon ? icons[icon] : null
    return (
      <button ref={ref} type="button" style={CHECKER_STYLE}
        className={cn(ds.colorSwatch.root, 'block relative overflow-hidden focus-visible:outline-2 focus-visible:outline-indigo-hover', className)}
        {...props}>
        <span className="absolute inset-0" style={{ background: `rgba(${to255(r)}, ${to255(g)}, ${to255(b)}, ${a})` }} />
        {Icon && (
          <span className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ color: contrastInk(r, g, b, a) }}>
            <Icon className="size-icon-sm" />
          </span>
        )}
      </button>
    )
  },
)
ColorSwatch.displayName = 'ColorSwatch'
