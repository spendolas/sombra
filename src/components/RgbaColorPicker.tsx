/**
 * RgbaColorPicker — self-contained HSV + alpha color picker.
 *
 * A swatch button (current color composited over a checkerboard so alpha is
 * visible) opens a popover with a saturation/value area, a hue slider, and
 * an alpha slider. Controlled: value/onChange are normalized [r,g,b,a] floats
 * (0-1). No external dependency — HSV<->RGB conversion is done inline.
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { cn } from '@/lib/utils'
import { ds } from '@/generated/ds'

export type Rgba = [number, number, number, number]

interface RgbaColorPickerProps {
  value: Rgba
  onChange: (value: Rgba) => void
  label?: string
  className?: string
}

interface Hsv {
  h: number // 0-360
  s: number // 0-1
  v: number // 0-1
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v))
}

function rgbToHsv(r: number, g: number, b: number): Hsv {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  const s = max === 0 ? 0 : d / max
  return { h, s, v: max }
}

function hsvToRgb({ h, s, v }: Hsv): [number, number, number] {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return [r + m, g + m, b + m]
}

function rgbaCss(r: number, g: number, b: number, a: number) {
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`
}

/** Fixed decorative pattern behind the swatch/alpha track so alpha reads visually. */
const CHECKER_STYLE: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg, rgba(128,128,128,0.4) 25%, transparent 25%), ' +
    'linear-gradient(-45deg, rgba(128,128,128,0.4) 25%, transparent 25%), ' +
    'linear-gradient(45deg, transparent 75%, rgba(128,128,128,0.4) 75%), ' +
    'linear-gradient(-45deg, transparent 75%, rgba(128,128,128,0.4) 75%)',
  backgroundSize: '8px 8px',
  backgroundPosition: '0 0, 0 4px, 4px -4px, -4px 0px',
}

function valuesEqual(a: Rgba, b: Rgba) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]
}

/** Shared range-input reset so our custom track gradient shows through, with a small visible thumb. */
const RANGE_CLASS =
  'relative w-full h-2 rounded-sm appearance-none cursor-pointer bg-transparent ' +
  '[&::-webkit-slider-runnable-track]:bg-transparent [&::-moz-range-track]:bg-transparent ' +
  '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 ' +
  '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border ' +
  '[&::-webkit-slider-thumb]:border-edge [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-3 ' +
  '[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-0 ' +
  '[&::-moz-range-thumb]:outline [&::-moz-range-thumb]:outline-1 [&::-moz-range-thumb]:outline-edge'

export function RgbaColorPicker({ value, onChange, label, className }: RgbaColorPickerProps) {
  const [open, setOpen] = useState(false)
  const [hsv, setHsv] = useState<Hsv>(() => rgbToHsv(value[0], value[1], value[2]))
  const rootRef = useRef<HTMLDivElement>(null)
  const svRef = useRef<HTMLDivElement>(null)
  const lastEmitted = useRef<Rgba>(value)

  // Resync HSV from external value changes (undo/redo, loading a graph) —
  // but not from our own onChange echoes, so hue/sat survive s=0 or v=0.
  useEffect(() => {
    if (!valuesEqual(value, lastEmitted.current)) {
      setHsv(rgbToHsv(value[0], value[1], value[2]))
      lastEmitted.current = value
    }
  }, [value])

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const emit = useCallback(
    (next: Hsv, a: number) => {
      const [r, g, b] = hsvToRgb(next)
      const rgba: Rgba = [r, g, b, a]
      lastEmitted.current = rgba
      onChange(rgba)
    },
    [onChange]
  )

  const a = value[3]

  const handleSvPointer = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const rect = svRef.current?.getBoundingClientRect()
      if (!rect) return

      const update = (clientX: number, clientY: number) => {
        const s = clamp01((clientX - rect.left) / rect.width)
        const v = clamp01(1 - (clientY - rect.top) / rect.height)
        const next = { ...hsv, s, v }
        setHsv(next)
        emit(next, a)
      }
      update(e.clientX, e.clientY)

      const onMove = (ev: PointerEvent) => update(ev.clientX, ev.clientY)
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [hsv, a, emit]
  )

  const handleHueChange = useCallback(
    (h: number) => {
      const next = { ...hsv, h }
      setHsv(next)
      emit(next, a)
    },
    [hsv, a, emit]
  )

  const handleAlphaChange = useCallback(
    (newA: number) => {
      emit(hsv, newA)
    },
    [hsv, emit]
  )

  const [r, g, b] = hsvToRgb(hsv)

  return (
    <div ref={rootRef} className={cn('relative nodrag nowheel', className)}>
      {label && <label className={ds.colorInput.label}>{label}</label>}
      <button
        type="button"
        className={cn(ds.colorSwatch.root, 'relative overflow-hidden block')}
        style={CHECKER_STYLE}
        onClick={() => setOpen((o) => !o)}
        aria-label={label ?? 'Color'}
      >
        <span className="absolute inset-0" style={{ backgroundColor: rgbaCss(r, g, b, a) }} />
      </button>

      {open && (
        <div className="absolute z-50 top-full left-0 mt-xs flex flex-col gap-sm bg-surface-raised border border-edge rounded-md p-md w-[180px] shadow-lg">
          {/* Saturation/Value area */}
          <div
            ref={svRef}
            className="relative w-full h-[110px] rounded-sm cursor-crosshair touch-none"
            style={{
              backgroundColor: `hsl(${hsv.h}, 100%, 50%)`,
              backgroundImage:
                'linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)',
            }}
            onPointerDown={handleSvPointer}
          >
            <div
              className="absolute w-3 h-3 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)] -translate-x-1/2 -translate-y-1/2 pointer-events-none"
              style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
            />
          </div>

          {/* Hue slider */}
          <input
            type="range"
            min={0}
            max={360}
            step={1}
            value={hsv.h}
            onChange={(e) => handleHueChange(Number(e.target.value))}
            className={RANGE_CLASS}
            style={{ backgroundImage: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)' }}
          />

          {/* Alpha slider */}
          <div className="relative rounded-sm overflow-hidden" style={CHECKER_STYLE}>
            <div
              className="absolute inset-0"
              style={{ backgroundImage: `linear-gradient(to right, ${rgbaCss(r, g, b, 0)}, ${rgbaCss(r, g, b, 1)})` }}
            />
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={a}
              onChange={(e) => handleAlphaChange(Number(e.target.value))}
              className={RANGE_CLASS}
            />
          </div>

          <div className="flex flex-row items-center justify-between text-param text-fg-subtle">
            <span>RGBA</span>
            <span className="text-mono-value text-fg">
              {Math.round(r * 255)}, {Math.round(g * 255)}, {Math.round(b * 255)}, {a.toFixed(2)}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
