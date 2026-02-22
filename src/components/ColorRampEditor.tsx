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
import { cn } from '@/lib/utils'

// --- Types ---

interface ColorStop {
  position: number
  color: [number, number, number]
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

function toHex(v: number): string {
  return Math.round(v * 255).toString(16).padStart(2, '0')
}

function stopToHex(stop: ColorStop): string {
  const [r, g, b] = stop.color
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function stopToRgb(stop: ColorStop): string {
  const [r, g, b] = stop.color
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`
}

function hexToColor(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ]
}

/** Interpolate between two colors at ratio t (0-1) */
function lerpColor(
  a: [number, number, number],
  b: [number, number, number],
  t: number
): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ]
}

/** Get interpolated color at position from sorted stops */
function colorAtPosition(stops: ColorStop[], pos: number): [number, number, number] {
  if (stops.length === 0) return [0, 0, 0]
  if (pos <= stops[0].position) return stops[0].color
  if (pos >= stops[stops.length - 1].position) return stops[stops.length - 1].color

  for (let i = 1; i < stops.length; i++) {
    if (pos <= stops[i].position) {
      const prev = stops[i - 1]
      const curr = stops[i]
      const range = curr.position - prev.position
      const t = range < 0.0001 ? 0 : (pos - prev.position) / range
      return lerpColor(prev.color, curr.color, t)
    }
  }
  return stops[stops.length - 1].color
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
    .map((s) => `${stopToRgb(s)} ${s.position * 100}%`)
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
    (hex: string) => {
      updateStop(safeIndex, { ...selectedStop, color: hexToColor(hex) })
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
    <div className="nodrag nowheel space-y-2">
      {/* Gradient bar */}
      <div
        ref={barRef}
        className="relative h-6 rounded-md border border-edge cursor-crosshair"
        style={{ background: `linear-gradient(to right, ${gradientCSS})` }}
        onClick={handleBarClick}
      />

      {/* Stop markers */}
      <div className="relative h-4">
        {stops.map((stop, i) => (
          <button
            key={i}
            className={cn(
              'absolute top-0 -translate-x-1/2 w-3 h-3 rounded-full border-2 border-surface-elevated',
              i === safeIndex && 'ring-2 ring-indigo'
            )}
            style={{
              left: `${stop.position * 100}%`,
              backgroundColor: stopToRgb(stop),
            }}
            onPointerDown={(e) => handleStopPointerDown(e, i)}
          />
        ))}
      </div>

      {/* Controls row */}
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={stopToHex(selectedStop)}
          onChange={(e) => handleColorChange(e.target.value)}
          className="w-6 h-6 rounded cursor-pointer border border-edge bg-surface-raised"
        />
        <span className="text-[10px] tabular-nums text-fg-dim">
          {Math.round(selectedStop.position * 100)}%
        </span>
        <div className="flex-1" />
        <button
          onClick={handleAddStop}
          className="w-5 h-5 flex items-center justify-center rounded text-xs leading-none border border-edge bg-surface-alt text-fg cursor-pointer"
        >
          +
        </button>
        <button
          onClick={handleRemoveStop}
          disabled={stops.length <= 2}
          className={cn(
            'w-5 h-5 flex items-center justify-center rounded text-xs leading-none border border-edge',
            stops.length <= 2
              ? 'bg-surface-raised text-fg-muted cursor-default'
              : 'bg-surface-alt text-fg cursor-pointer'
          )}
        >
          -
        </button>
      </div>

      {/* Preset dropdown */}
      <Select onValueChange={handlePreset}>
        <SelectTrigger
          size="sm"
          className="w-full h-7 text-xs bg-surface-raised border-edge text-fg"
        >
          <SelectValue placeholder="Preset" />
        </SelectTrigger>
        <SelectContent className="bg-surface-elevated border-edge">
          {PRESETS.map((preset) => (
            <SelectItem key={preset.name} value={preset.name} className="text-xs">
              {preset.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
