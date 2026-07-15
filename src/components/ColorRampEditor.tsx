/**
 * ColorRampEditor — Interactive gradient editor for the Color Ramp node.
 * Renders a CSS gradient preview, draggable stop markers, color picker,
 * add/remove controls, and preset palette selector.
 */

import { useState, useRef, useCallback, useEffect } from 'react'
import { useGraphStore } from '@/stores/graphStore'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { IconButton } from '@/components/IconButton'
import { RgbaColorPicker, type Rgba } from '@/components/RgbaColorPicker'
import { cn } from '@/lib/utils'
import { ds } from '@/generated/ds'

/** Checkerboard pattern behind gradient/swatch surfaces so alpha reads visually (mirrors RgbaColorPicker). */
const CHECKER_STYLE: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg, rgba(128,128,128,0.4) 25%, transparent 25%), ' +
    'linear-gradient(-45deg, rgba(128,128,128,0.4) 25%, transparent 25%), ' +
    'linear-gradient(45deg, transparent 75%, rgba(128,128,128,0.4) 75%), ' +
    'linear-gradient(-45deg, transparent 75%, rgba(128,128,128,0.4) 75%)',
  backgroundSize: '8px 8px',
  backgroundPosition: '0 0, 0 4px, 4px -4px, -4px 0px',
}

// --- Types ---

interface ColorStop {
  position: number
  /** RGB (legacy, alpha defaults to 1) or RGBA. */
  color: [number, number, number] | Rgba
}

interface Preset {
  name: string
  stops: ColorStop[]
}

// --- Presets (from spectra-pixel-bg) ---

const PRESETS: Preset[] = [
  {
    name: 'Cobalt Drift',
    stops: [
      { position: 0.0, color: [0.020, 0.027, 0.051] },
      { position: 0.25, color: [0.137, 0.231, 0.416] },
      { position: 0.5, color: [0.235, 0.435, 1.000] },
      { position: 0.75, color: [0.549, 0.776, 1.000] },
      { position: 1.0, color: [0.663, 0.729, 0.839] },
    ],
  },
  {
    name: 'Violet Ember',
    stops: [
      { position: 0.0, color: [0.039, 0.027, 0.063] },
      { position: 0.25, color: [0.165, 0.059, 0.231] },
      { position: 0.5, color: [0.416, 0.122, 0.820] },
      { position: 0.75, color: [1.000, 0.416, 0.835] },
      { position: 1.0, color: [0.957, 0.725, 0.882] },
    ],
  },
  {
    name: 'Teal Afterglow',
    stops: [
      { position: 0.0, color: [0.016, 0.031, 0.039] },
      { position: 0.25, color: [0.059, 0.184, 0.227] },
      { position: 0.5, color: [0.110, 0.624, 0.651] },
      { position: 0.75, color: [0.412, 0.753, 0.702] },
      { position: 1.0, color: [0.831, 0.929, 0.882] },
    ],
  },
  {
    name: 'Solar Ember',
    stops: [
      { position: 0.0, color: [0.063, 0.024, 0.020] },
      { position: 0.25, color: [0.231, 0.059, 0.039] },
      { position: 0.5, color: [0.533, 0.153, 0.102] },
      { position: 0.75, color: [0.741, 0.361, 0.141] },
      { position: 1.0, color: [1.000, 0.820, 0.541] },
    ],
  },
  {
    name: 'Citrus Pulse',
    stops: [
      { position: 0.0, color: [0.059, 0.027, 0.020] },
      { position: 0.25, color: [0.227, 0.118, 0.047] },
      { position: 0.5, color: [0.478, 0.247, 0.086] },
      { position: 0.75, color: [0.612, 0.322, 0.114] },
      { position: 1.0, color: [0.839, 0.627, 0.361] },
    ],
  },
  {
    name: 'Rose Heat',
    stops: [
      { position: 0.0, color: [0.071, 0.020, 0.027] },
      { position: 0.25, color: [0.231, 0.039, 0.094] },
      { position: 0.5, color: [0.639, 0.090, 0.247] },
      { position: 0.75, color: [1.000, 0.294, 0.431] },
      { position: 1.0, color: [1.000, 0.753, 0.784] },
    ],
  },
]

const DEFAULT_STOPS: ColorStop[] = [
  { position: 0.0, color: [0.0, 0.0, 0.0] },
  { position: 1.0, color: [1.0, 1.0, 1.0] },
]

// --- Helpers ---

/** Normalize a stop color to RGBA, defaulting alpha to 1 for legacy 3-length colors. */
function normalizeStopColor(color: ColorStop['color']): Rgba {
  return color.length === 4 ? color : [color[0], color[1], color[2], 1]
}

function stopToRgba(stop: ColorStop): string {
  const [r, g, b, a] = normalizeStopColor(stop.color)
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`
}

/** Interpolate between two RGBA colors at ratio t (0-1) */
function lerpColor(a: Rgba, b: Rgba, t: number): Rgba {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
    a[3] + (b[3] - a[3]) * t,
  ]
}

/** Get interpolated RGBA color at position from sorted stops */
function colorAtPosition(stops: ColorStop[], pos: number): Rgba {
  if (stops.length === 0) return [0, 0, 0, 1]
  if (pos <= stops[0].position) return normalizeStopColor(stops[0].color)
  if (pos >= stops[stops.length - 1].position) return normalizeStopColor(stops[stops.length - 1].color)

  for (let i = 1; i < stops.length; i++) {
    if (pos <= stops[i].position) {
      const prev = stops[i - 1]
      const curr = stops[i]
      const range = curr.position - prev.position
      const t = range < 0.0001 ? 0 : (pos - prev.position) / range
      return lerpColor(normalizeStopColor(prev.color), normalizeStopColor(curr.color), t)
    }
  }
  return normalizeStopColor(stops[stops.length - 1].color)
}

// --- Component ---

export function ColorRampEditor({
  nodeId,
  data,
}: {
  nodeId: string
  data: Record<string, unknown>
}) {
  const updateNodeData = useGraphStore((s) => s.updateNodeData)
  const barRef = useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)

  // Read stops from data, fallback to defaults
  const rawStops = data.stops as ColorStop[] | undefined
  const stops: ColorStop[] =
    rawStops && Array.isArray(rawStops) && rawStops.length >= 2
      ? rawStops
      : DEFAULT_STOPS

  // Initialize stops on first render if missing
  useEffect(() => {
    if (!rawStops || !Array.isArray(rawStops) || rawStops.length < 2) {
      updateNodeData(nodeId, {
        params: { ...data, stops: DEFAULT_STOPS },
      })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const sortedStops = [...stops].sort((a, b) => a.position - b.position)

  // Clamp selected index
  const safeIndex = Math.min(selectedIndex, stops.length - 1)
  const selectedStop = stops[safeIndex]

  // --- Store updates ---

  const updateStops = useCallback(
    (newStops: ColorStop[]) => {
      updateNodeData(nodeId, {
        params: { ...data, stops: newStops },
      })
    },
    [nodeId, data, updateNodeData]
  )

  const updateStop = useCallback(
    (index: number, updated: ColorStop) => {
      const newStops = stops.map((s, i) => (i === index ? updated : s))
      updateStops(newStops)
    },
    [stops, updateStops]
  )

  // --- Gradient CSS ---

  const gradientCSS = sortedStops
    .map((s) => `${stopToRgba(s)} ${s.position * 100}%`)
    .join(', ')

  // --- Drag handling ---

  const handleStopPointerDown = useCallback(
    (e: React.PointerEvent, index: number) => {
      e.stopPropagation()
      e.preventDefault()
      setSelectedIndex(index)

      const bar = barRef.current
      if (!bar) return
      const rect = bar.getBoundingClientRect()

      const onMove = (ev: PointerEvent) => {
        const x = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width))
        const newStops = stops.map((s, i) =>
          i === index ? { ...s, position: Math.round(x * 1000) / 1000 } : s
        )
        updateStops(newStops)
      }

      const onUp = () => {
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
      }

      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
    },
    [stops, updateStops]
  )

  // --- Add stop (click on gradient bar) ---

  const handleBarClick = useCallback(
    (e: React.MouseEvent) => {
      const bar = barRef.current
      if (!bar) return
      const rect = bar.getBoundingClientRect()
      const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      const color = colorAtPosition(sortedStops, pos)
      const newStops = [...stops, { position: Math.round(pos * 1000) / 1000, color }]
      updateStops(newStops)
      setSelectedIndex(newStops.length - 1)
    },
    [stops, sortedStops, updateStops]
  )

  // --- Add stop (+ button) ---

  const handleAddStop = useCallback(() => {
    // Insert at midpoint between selected and next stop (or prev)
    const sorted = [...stops].sort((a, b) => a.position - b.position)
    const sortedIndex = sorted.indexOf(stops[safeIndex])
    let pos: number
    if (sortedIndex < sorted.length - 1) {
      pos = (sorted[sortedIndex].position + sorted[sortedIndex + 1].position) / 2
    } else if (sortedIndex > 0) {
      pos = (sorted[sortedIndex - 1].position + sorted[sortedIndex].position) / 2
    } else {
      pos = 0.5
    }
    const color = colorAtPosition(sorted, pos)
    const newStops = [...stops, { position: Math.round(pos * 1000) / 1000, color }]
    updateStops(newStops)
    setSelectedIndex(newStops.length - 1)
  }, [stops, safeIndex, updateStops])

  // --- Remove stop ---

  const handleRemoveStop = useCallback(() => {
    if (stops.length <= 2) return
    const newStops = stops.filter((_, i) => i !== safeIndex)
    updateStops(newStops)
    setSelectedIndex(Math.min(safeIndex, newStops.length - 1))
  }, [stops, safeIndex, updateStops])

  // --- Color change ---

  const handleColorChange = useCallback(
    (rgba: Rgba) => {
      updateStop(safeIndex, { ...selectedStop, color: rgba })
    },
    [safeIndex, selectedStop, updateStop]
  )

  // --- Preset ---

  const handlePreset = useCallback(
    (presetName: string) => {
      const preset = PRESETS.find((p) => p.name === presetName)
      if (preset) {
        updateStops(preset.stops.map((s) => ({ ...s })))
        setSelectedIndex(0)
      }
    },
    [updateStops]
  )

  return (
    <div className={cn(ds.gradientEditor.root, "nodrag nowheel")}>
      {/* Gradient bar (checker behind so transparent stops read as transparent) */}
      <div
        ref={barRef}
        className={cn(ds.gradientEditor.bar, "relative overflow-hidden")}
        style={CHECKER_STYLE}
        onClick={handleBarClick}
      >
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: `linear-gradient(to right, ${gradientCSS})` }}
        />
      </div>

      {/* Stop markers */}
      <div className={ds.gradientEditor.stopMarkers}>
        {stops.map((stop, i) => (
          <button
            key={i}
            className={cn(
              ds.gradientEditor.stopHandle,
              'top-0 -translate-x-1/2 overflow-hidden',
              i === safeIndex && ds.gradientEditor.stopHandleSelected
            )}
            style={{ left: `${stop.position * 100}%` }}
            onPointerDown={(e) => handleStopPointerDown(e, i)}
          >
            <span className="absolute inset-0" style={CHECKER_STYLE} />
            <span className="absolute inset-0" style={{ backgroundColor: stopToRgba(stop) }} />
          </button>
        ))}
      </div>

      {/* Controls row */}
      <div className={ds.gradientEditor.controlsRow}>
        <RgbaColorPicker
          mode="popover"
          value={normalizeStopColor(selectedStop.color)}
          onChange={handleColorChange}
        />
        <span className={ds.gradientEditor.positionText}>
          {Math.round(selectedStop.position * 100)}%
        </span>
        <div className="flex-1" />
        <IconButton
          icon="plus"
          onClick={handleAddStop}
          className={ds.button.solid}
        />
        <IconButton
          icon="minus"
          onClick={handleRemoveStop}
          disabled={stops.length <= 2}
          className={stops.length <= 2
            ? ds.button.solidDisabled
            : ds.button.solid}
        />
      </div>

      {/* Preset dropdown */}
      <Select onValueChange={handlePreset}>
        <SelectTrigger>
          <SelectValue placeholder="Preset" />
        </SelectTrigger>
        <SelectContent>
          {PRESETS.map((preset) => (
            <SelectItem key={preset.name} value={preset.name}>
              {preset.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
