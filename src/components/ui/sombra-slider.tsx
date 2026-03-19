/**
 * SombraSlider — purpose-built slider for shader parameter tweaking
 *
 * Features:
 * - Blender-style label scrub (drag anywhere on label row)
 * - Shift+drag fine control (10x smaller step) — shift can be pressed anytime during drag
 * - Double-click to reset to default
 * - Filled track with no visible thumb
 * - Dual-thumb range mode for [min, max] pairs
 * - Track shows param range; scrub/text entry allow values beyond range
 * - nodrag nowheel to prevent React Flow canvas interference
 */

import { useRef, useState, useCallback, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { ds } from '@/generated/ds'

interface SombraSliderProps {
  label: string | [string, string]
  value: number | [number, number]
  onChange: (value: number | [number, number]) => void
  min?: number
  max?: number
  step?: number
  defaultValue?: number | [number, number]
  disabled?: boolean
  className?: string
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(Math.max(v, lo), hi)
}

function snap(v: number, step: number, min: number) {
  return Math.round((v - min) / step) * step + min
}

function frac(v: number, min: number, max: number) {
  return max === min ? 0 : (v - min) / (max - min)
}

function formatValue(v: number, step: number) {
  if (step >= 1) return String(Math.round(v))
  const decimals = Math.max(0, -Math.floor(Math.log10(step)))
  return v.toFixed(decimals)
}

function SombraSlider({
  label,
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
  defaultValue,
  disabled = false,
  className,
}: SombraSliderProps) {
  const isRange = Array.isArray(value)
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<null | 'single' | 'lo' | 'hi'>(null)
  const [editingField, setEditingField] = useState<null | 'single' | 'lo' | 'hi'>(null)
  const [editText, setEditText] = useState('')

  // Track visual uses min/max, but values can exceed the range
  const valueToX = useCallback(
    (v: number) => clamp(frac(v, min, max), 0, 1),
    [min, max]
  )

  // Track click → value (clamped to track range)
  const xToValue = useCallback(
    (x: number, fineMode: boolean) => {
      const raw = min + x * (max - min)
      const s = fineMode ? step * 0.1 : step
      return clamp(snap(raw, s, min), min, max)
    },
    [min, max, step]
  )

  // -- Pointer-based drag on the track ---
  const handleTrackPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled || editingField) return
      e.preventDefault()
      e.stopPropagation()
      const rect = trackRef.current?.getBoundingClientRect()
      if (!rect) return

      const x = clamp((e.clientX - rect.left) / rect.width, 0, 1)
      const clickedVal = xToValue(x, false) // never use shift for initial click

      let which: 'single' | 'lo' | 'hi' = 'single'
      if (isRange) {
        const [lo, hi] = value as [number, number]
        const dLo = Math.abs(clickedVal - lo)
        const dHi = Math.abs(clickedVal - hi)
        which = dLo <= dHi ? 'lo' : 'hi'
      }

      // Apply immediate value
      if (isRange) {
        const [lo, hi] = value as [number, number]
        if (which === 'lo') onChange([Math.min(clickedVal, hi), hi])
        else onChange([lo, Math.max(clickedVal, lo)])
      } else {
        onChange(clickedVal)
      }

      setDragging(which)
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    },
    [disabled, editingField, isRange, value, onChange, xToValue]
  )

  const handleTrackPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return
      const rect = trackRef.current?.getBoundingClientRect()
      if (!rect) return
      const x = clamp((e.clientX - rect.left) / rect.width, 0, 1)
      const newVal = xToValue(x, e.shiftKey)

      if (isRange) {
        const [lo, hi] = value as [number, number]
        if (dragging === 'lo') onChange([Math.min(newVal, hi), hi])
        else onChange([lo, Math.max(newVal, lo)])
      } else {
        onChange(newVal)
      }
    },
    [dragging, isRange, value, onChange, xToValue]
  )

  const handleTrackPointerUp = useCallback(() => {
    setDragging(null)
  }, [])

  // -- Label scrub (horizontal drag on label row) ---
  const scrubState = useRef({
    active: false,
    startX: 0,
    startValue: 0,
    which: 'single' as 'single' | 'lo' | 'hi',
    moved: false,
  })

  const handleLabelPointerDown = useCallback(
    (e: React.PointerEvent, which: 'single' | 'lo' | 'hi' = 'single') => {
      if (disabled || editingField) return
      e.preventDefault()
      e.stopPropagation()

      const currentVal = isRange
        ? (which === 'lo' ? (value as [number, number])[0] : (value as [number, number])[1])
        : (value as number)

      scrubState.current = {
        active: true,
        startX: e.clientX,
        startValue: currentVal,
        which,
        moved: false,
      }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    },
    [disabled, editingField, isRange, value]
  )

  const handleLabelPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const s = scrubState.current
      if (!s.active) return

      const dx = e.clientX - s.startX
      // Use a pixel threshold to distinguish click from drag — shift doesn't affect this
      if (!s.moved && Math.abs(dx) <= 2) return
      s.moved = true

      const range = max - min
      // Shift for fine control — only affects sensitivity, checked live during drag
      const sensitivity = e.shiftKey ? 0.0005 : 0.003
      const raw = s.startValue + dx * range * sensitivity
      // Scrub allows going beyond min/max — only snap, no clamp
      const newVal = snap(raw, e.shiftKey ? step * 0.1 : step, min)

      if (isRange) {
        const [lo, hi] = value as [number, number]
        if (s.which === 'lo') onChange([Math.min(newVal, hi), hi])
        else onChange([lo, Math.max(newVal, lo)])
      } else {
        onChange(newVal)
      }
    },
    [isRange, value, onChange, min, max, step]
  )

  const handleLabelPointerUp = useCallback(() => {
    scrubState.current.active = false
  }, [])

  // -- Double-click to reset ---
  const handleDoubleClick = useCallback(
    (which: 'single' | 'lo' | 'hi' = 'single') => {
      if (disabled) return
      if (defaultValue === undefined) return
      if (isRange && Array.isArray(defaultValue)) {
        const [lo, hi] = value as [number, number]
        if (which === 'lo') onChange([defaultValue[0], hi])
        else onChange([lo, defaultValue[1]])
      } else if (!isRange && typeof defaultValue === 'number') {
        onChange(defaultValue)
      }
    },
    [disabled, defaultValue, isRange, value, onChange]
  )

  // -- Click value to enter text edit mode ---
  const handleValueClick = useCallback(
    (e: React.MouseEvent, which: 'single' | 'lo' | 'hi') => {
      if (disabled) return
      if (scrubState.current.moved) return // Don't open editor after scrub
      e.stopPropagation()
      const v = isRange
        ? (which === 'lo' ? (value as [number, number])[0] : (value as [number, number])[1])
        : (value as number)
      setEditText(formatValue(v, step))
      setEditingField(which)
    },
    [disabled, isRange, value, step]
  )

  const commitEdit = useCallback(
    (which: 'single' | 'lo' | 'hi') => {
      const parsed = parseFloat(editText)
      if (!isNaN(parsed)) {
        // Text entry allows any value — no clamping
        const snapped = snap(parsed, step, min)
        if (isRange) {
          const [lo, hi] = value as [number, number]
          if (which === 'lo') onChange([Math.min(snapped, hi), hi])
          else onChange([lo, Math.max(snapped, lo)])
        } else {
          onChange(snapped)
        }
      }
      setEditingField(null)
    },
    [editText, min, step, isRange, value, onChange]
  )

  // Sync dragging cursor style on body
  useEffect(() => {
    if (dragging || scrubState.current.active) {
      document.body.style.cursor = 'ew-resize'
      return () => { document.body.style.cursor = '' }
    }
  }, [dragging])

  // -- Render ---
  const labels = Array.isArray(label) ? label : [label]
  const vals = isRange ? (value as [number, number]) : [value as number]

  return (
    <div
      className={cn(
        ds.floatSlider.root,
        disabled && 'opacity-60 pointer-events-none',
        className
      )}
    >
      {/* Label + value row */}
      <div
        className={ds.floatSlider.labelRow}
        onDoubleClick={() => handleDoubleClick(isRange ? 'lo' : 'single')}
      >
        {isRange ? (
          <>
            {/* Lo label + value */}
            <div
              className="flex items-center gap-xs"
              onPointerDown={(e) => handleLabelPointerDown(e, 'lo')}
              onPointerMove={handleLabelPointerMove}
              onPointerUp={handleLabelPointerUp}
            >
              <span className={ds.floatSlider.label}>{labels[0]}</span>
              {editingField === 'lo' ? (
                <input
                  autoFocus
                  className={cn("w-10", ds.floatSlider.input)}
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onBlur={() => commitEdit('lo')}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitEdit('lo'); if (e.key === 'Escape') setEditingField(null) }}
                  onFocus={(e) => e.target.select()}
                />
              ) : (
                <span
                  className={ds.floatSlider.value}
                  onClick={(e) => handleValueClick(e, 'lo')}
                >
                  {formatValue(vals[0], step)}
                </span>
              )}
            </div>
            {/* Hi label + value */}
            <div
              className="flex items-center gap-xs"
              onPointerDown={(e) => handleLabelPointerDown(e, 'hi')}
              onPointerMove={handleLabelPointerMove}
              onPointerUp={handleLabelPointerUp}
              onDoubleClick={(e) => { e.stopPropagation(); handleDoubleClick('hi') }}
            >
              {editingField === 'hi' ? (
                <input
                  autoFocus
                  className={cn("w-10", ds.floatSlider.input)}
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onBlur={() => commitEdit('hi')}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitEdit('hi'); if (e.key === 'Escape') setEditingField(null) }}
                  onFocus={(e) => e.target.select()}
                />
              ) : (
                <span
                  className={ds.floatSlider.value}
                  onClick={(e) => handleValueClick(e, 'hi')}
                >
                  {formatValue(vals[isRange ? 1 : 0], step)}
                </span>
              )}
              <span className={ds.floatSlider.label}>{labels[1] || labels[0]}</span>
            </div>
          </>
        ) : (
          <div
            className="flex justify-between items-center w-full"
            onPointerDown={(e) => handleLabelPointerDown(e, 'single')}
            onPointerMove={handleLabelPointerMove}
            onPointerUp={handleLabelPointerUp}
          >
            <span className={ds.floatSlider.label}>{labels[0]}</span>
            {editingField === 'single' ? (
              <input
                autoFocus
                className={cn("w-12", ds.floatSlider.input)}
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onBlur={() => commitEdit('single')}
                onKeyDown={(e) => { if (e.key === 'Enter') commitEdit('single'); if (e.key === 'Escape') setEditingField(null) }}
                onFocus={(e) => e.target.select()}
              />
            ) : (
              <span
                className={ds.floatSlider.value}
                onClick={(e) => handleValueClick(e, 'single')}
              >
                {formatValue(vals[0], step)}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Track */}
      <div
        ref={trackRef}
        className={cn(ds.sliderTrack.track, "cursor-ew-resize overflow-hidden")}
        onPointerDown={handleTrackPointerDown}
        onPointerMove={handleTrackPointerMove}
        onPointerUp={handleTrackPointerUp}
        onLostPointerCapture={handleTrackPointerUp}
      >
        {isRange ? (
          // Range fill between lo and hi (clamped to track visually)
          <div
            className={ds.sliderTrack.fill}
            style={{
              left: `${valueToX(vals[0]) * 100}%`,
              width: `${(valueToX(vals[1]) - valueToX(vals[0])) * 100}%`,
            }}
          />
        ) : (
          // Single fill from left (clamped to track visually)
          <div
            className={cn(ds.sliderTrack.fill, "left-0")}
            style={{ width: `${valueToX(vals[0]) * 100}%` }}
          />
        )}
      </div>
    </div>
  )
}

export { SombraSlider }
export type { SombraSliderProps }
