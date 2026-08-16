/**
 * ExportModal — the user-facing entry point to client-side video / image-sequence
 * export. Wires together the pieces built in Tasks 2-6:
 *   - getAvailableSinks (T3, registry)     → the Format list
 *   - targetSize / computeFraming /
 *     describeResult (T6, framing)         → Size + Framing → export-frame params
 *   - runExport (T4, export-engine)        → the offline render/encode loop
 *
 * Shell/portal mirrors EmbedModal. Layout, controls, copy and behavior reproduce
 * the approved mockup at docs/superpowers/specs/2026-08-07-export-modal-mockup.html,
 * translated from its raw CSS/hex into Sombra design-system token classes.
 *
 * v1 is WebGPU-only: the export engine acquires its own GPUDevice and throws when
 * WebGPU is unavailable, so the whole Format list is gated on the active renderer
 * backend being 'webgpu'.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { ds } from '@/generated/ds'
import { RgbaColorPicker, type Rgba } from '@/components/RgbaColorPicker'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { icons } from '@/components/icons'
import { previewCanvasSize } from '@/utils/preview-canvas-size'
import { useCompilerStore } from '@/stores/compilerStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { isWebGL2Forced } from '@/renderer/create-renderer'
import { getAvailableSinks } from './registry'
import { runExport, type ExportJob } from './export-engine'
import { useExportPreview, type ExportPreviewState } from './use-export-preview'
import {
  targetSize,
  computeFraming,
  describeResult,
  type SizeSource,
  type FramingMode,
  type ViewInfo,
} from './framing'
import type { FrameSink } from './frame-sink'
// Side effect: registers the 3 built-in sinks so getAvailableSinks returns them.
import './sinks/index'

type SizeSrc = 'match' | '2x' | '4x' | 'preset' | 'custom'
type Phase = 'config' | 'running' | 'done'

const QUALITY_LABELS = ['Draft', 'Good', 'High', 'Max'] as const

const PRESETS: { value: string; label: string }[] = [
  { value: '1280x720', label: '720p — 1280 × 720' },
  { value: '1920x1080', label: '1080p — 1920 × 1080' },
  { value: '3840x2160', label: '4K — 3840 × 2160' },
  { value: '1080x1920', label: 'Vertical — 1080 × 1920' },
  { value: '1080x1080', label: 'Square — 1080 × 1080' },
]

// Matte presets expressed in rgb() (never hex literals — CLAUDE.md "no raw hex").
// The custom <input type="color"> yields a runtime hex value, which is fine.
const MATTES: { key: string; label: string; color: string }[] = [
  { key: 'black', label: 'Black', color: 'rgb(0, 0, 0)' },
  { key: 'white', label: 'White', color: 'rgb(255, 255, 255)' },
  { key: 'grey', label: 'Grey', color: 'rgb(128, 128, 128)' },
  { key: 'chroma', label: 'Chroma green', color: 'rgb(0, 177, 64)' },
]
// The background is a choice between swatches. Presets have fixed colours; the
// 'custom' swatch is a *dynamic preset* whose colour resolves live to the user's
// override, or the preview-window background when there's no override.
type MatteKey = 'black' | 'white' | 'grey' | 'chroma' | 'custom'

// Transparency checker — decorative rgba-over-token-surface pattern (no hex).
const CHECKER: React.CSSProperties = {
  backgroundImage:
    'conic-gradient(rgba(255,255,255,0.06) 0.25turn, transparent 0 0.5turn, rgba(255,255,255,0.06) 0 0.75turn, transparent 0)',
  backgroundSize: '14px 14px',
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
const aspectStr = (w: number, h: number) => {
  const g = gcd(Math.round(w), Math.round(h)) || 1
  const rw = Math.round(w / g)
  const rh = Math.round(h / g)
  // Clean ratios read as "16:9"; odd sizes reduce to ugly numbers (508:135) —
  // show a decimal "3.76:1" instead.
  if (rw > 21 || rh > 21) return `${(w / h).toFixed(2)}:1`
  return `${rw}:${rh}`
}
// Video codecs need even dimensions. Round UP to even (never down) so an odd
// source size can't silently crop a pixel row/column — Match stays lossless.
const evenDim = (n: number) => Math.max(16, (Math.round(n) + 1) & ~1)

// The matte is a CSS colour string in the same `rgb(r, g, b)` shape as the
// presets (MATTES), so preset equality checks and the export job both work.
// Sombra's picker speaks normalized Rgba floats, so the custom colour lives in
// its own Rgba state (below) and only projects into the matte through this.
const to255 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255)
const rgbaToCss = ([r, g, b]: Rgba): string => `rgb(${to255(r)}, ${to255(g)}, ${to255(b)})`

// Parse the preview-window background colour (hex or rgb()/rgba()) into the
// picker's Rgba so the export matte can be seeded from it on launch. Alpha is
// dropped (an opaque matte); unknown formats fall back to white.
function cssToRgba(css: string): Rgba {
  const s = css.trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s)
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1]
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255, 1]
  }
  const m = /^rgba?\(\s*([\d.]+)\D+([\d.]+)\D+([\d.]+)/i.exec(s)
  if (m) return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255, 1]
  return [1, 1, 1, 1]
}

/** The app exposes the active renderer instance (and its `.backend`) on the dev bridge. */
function readBackend(): 'webgpu' | 'webgl2' | 'unknown' {
  const w = window as unknown as { __sombra?: { renderer?: { backend?: 'webgpu' | 'webgl2' } } }
  const b = w.__sombra?.renderer?.backend
  return b === 'webgpu' || b === 'webgl2' ? b : 'unknown'
}

const LABEL = 'text-param font-semibold uppercase tracking-wider text-fg-subtle'
const HINT = 'text-param text-fg-muted'
// One field shape/height for every input & select, so they align (DS tokens only).
const FIELD =
  'h-select-h rounded-sm border border-edge bg-surface-raised px-md text-mono-value text-fg outline-none transition-colors focus:border-active'
// Consistent selectable states — bg fills only, no stroke (DS buttons are borderless).
const SEG_ON = 'bg-indigo text-fg'
const SEG_OFF = 'bg-surface-raised text-fg-dim hover:bg-highlight'
const CARD_ON = 'bg-indigo text-fg'
const CARD_OFF = 'bg-surface-raised text-fg-dim hover:bg-highlight'
// Footer / action buttons.
const BTN =
  'inline-flex items-center justify-center rounded-sm border border-edge px-lg py-xs text-body font-medium text-fg-dim transition-colors hover:bg-hover hover:text-fg'
const BTN_PRIMARY =
  'inline-flex items-center justify-center rounded-sm bg-indigo px-lg py-xs text-body font-medium text-fg transition-colors hover:bg-indigo-hover'
const BTN_PRIMARY_OFF =
  'inline-flex cursor-not-allowed items-center justify-center rounded-sm bg-surface-raised px-lg py-xs text-body font-medium text-fg-muted'

// ── small internal segmented control ───────────────────────────────────────
function Seg({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { v: string; label: string; title?: string }[]
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}) {
  return (
    <div className="flex gap-sm">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          title={o.title}
          disabled={disabled}
          onClick={() => onChange(o.v)}
          className={cn(
            'flex h-select-h flex-1 items-center justify-center rounded-sm text-mono-value transition-colors',
            o.v === value ? SEG_ON : SEG_OFF,
            disabled && 'cursor-not-allowed opacity-40',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// Sentence-case the first character (framing/format descriptions).
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

// Human-readable duration with the unit inside the field: "5s", "1m 10s".
function formatDur(s: number): string {
  const n = Math.max(1, Math.round(s))
  if (n < 60) return `${n}s`
  const m = Math.floor(n / 60)
  const r = n % 60
  return r ? `${m}m ${r}s` : `${m}m`
}

const clampInt = (v: number, min: number, max: number, fallback: number) =>
  Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback

// Evaluate a basic arithmetic expression (+ − × ÷ and parentheses) so the size
// fields accept things like "1920/2" or "1080*2". Hand-rolled recursive descent
// — never eval()/Function() (CSP-safe). Returns null on any malformed input.
function evalMath(input: string): number | null {
  const s = input.trim()
  if (s === '' || !/^[\d+\-*/(). ]+$/.test(s)) return null
  let i = 0
  const skip = () => {
    while (s[i] === ' ') i++
  }
  const factor = (): number => {
    skip()
    if (s[i] === '(') {
      i++
      const v = expr()
      skip()
      if (s[i] === ')') i++
      return v
    }
    if (s[i] === '-') {
      i++
      return -factor()
    }
    if (s[i] === '+') {
      i++
      return factor()
    }
    let num = ''
    while (i < s.length && /[\d.]/.test(s[i])) num += s[i++]
    return num === '' ? NaN : parseFloat(num)
  }
  const term = (): number => {
    let v = factor()
    skip()
    while (s[i] === '*' || s[i] === '/') {
      const op = s[i++]
      const r = factor()
      v = op === '*' ? v * r : v / r
      skip()
    }
    return v
  }
  function expr(): number {
    let v = term()
    skip()
    while (s[i] === '+' || s[i] === '-') {
      const op = s[i++]
      const r = term()
      v = op === '+' ? v + r : v - r
      skip()
    }
    return v
  }
  const result = expr()
  skip()
  return i === s.length && Number.isFinite(result) ? result : null
}

// A number field that never fights the typist: it shows raw text while focused
// and only validates (round + clamp) on blur / Enter. type=text + inputMode
// avoids the native spin arrows entirely.
function NumberField({
  value,
  onCommit,
  ariaLabel,
  min,
  max,
  className,
  allowMath,
}: {
  value: number
  onCommit: (n: number) => void
  ariaLabel: string
  min: number
  max: number
  className?: string
  /** Accept arithmetic expressions ("1920/2") — evaluated on commit. */
  allowMath?: boolean
}) {
  const [text, setText] = useState<string | null>(null)
  const commit = () => {
    if (text === null) return
    const parsed = allowMath ? evalMath(text) : Number(text)
    onCommit(clampInt(parsed ?? NaN, min, max, value))
    setText(null)
  }
  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label={ariaLabel}
      value={text !== null ? text : String(value)}
      onFocus={() => setText(String(value))}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setText(null)
          e.currentTarget.blur()
        }
      }}
      className={cn(FIELD, className)}
    />
  )
}

// Duration stepper: − / value / +, with the unit shown inside and durations over
// a minute rendered human-readable ("1m 10s"). Validates on blur like NumberField.
function DurationField({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const [text, setText] = useState<string | null>(null)
  const step = (d: number) => {
    setText(null)
    onChange(clampInt(Math.round(value) + d, 1, 3600, value))
  }
  const commit = () => {
    if (text === null) return
    onChange(clampInt(Number(text), 1, 3600, value))
    setText(null)
  }
  const stepBtn =
    'flex h-full flex-none items-center justify-center px-sm text-fg-subtle transition-colors hover:text-fg'
  return (
    <div className={cn(FIELD, 'flex items-center gap-0 px-0')}>
      <button type="button" aria-label="Decrease duration" onClick={() => step(-1)} className={stepBtn}>
        <icons.minus className="size-3.5" />
      </button>
      <input
        aria-label="Duration"
        value={text !== null ? text : formatDur(value)}
        onFocus={() => setText(String(Math.round(value)))}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setText(null)
            e.currentTarget.blur()
          }
        }}
        className="min-w-0 flex-1 bg-transparent text-center text-mono-value text-fg outline-none"
      />
      <button type="button" aria-label="Increase duration" onClick={() => step(1)} className={stepBtn}>
        <icons.plus className="size-3.5" />
      </button>
    </div>
  )
}

// Persisted export choices — restored on next launch (localStorage). The
// background stores the *selected swatch* + the custom override (not a resolved
// colour), so the custom swatch keeps tracking the preview whenever it has no
// override, while an explicit pick still persists. No conflict either way.
const SETTINGS_KEY = 'sombra.export.settings.v1'
type SavedSettings = {
  quality: number
  sizeSrc: SizeSrc
  preset: string
  customW: number
  customH: number
  framing: FramingMode
  fpsChoice: string
  dur: number
  sinkId: string | null
  selectedMatte: MatteKey
  customOverride: Rgba | null
}
function loadExportSettings(): Partial<SavedSettings> {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    return raw ? (JSON.parse(raw) as Partial<SavedSettings>) : {}
  } catch {
    return {}
  }
}

export function ExportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [initial] = useState(loadExportSettings)
  // Format
  const [sinks, setSinks] = useState<FrameSink[]>([])
  const [sinkId, setSinkId] = useState<string | null>(null)
  // Controls
  const [quality, setQuality] = useState(initial.quality ?? 2) // High
  const [sizeSrc, setSizeSrc] = useState<SizeSrc>(initial.sizeSrc ?? 'match')
  const [preset, setPreset] = useState(initial.preset ?? '1920x1080')
  const [customW, setCustomW] = useState(initial.customW ?? 1600)
  const [customH, setCustomH] = useState(initial.customH ?? 900)
  const [framing, setFraming] = useState<FramingMode>(initial.framing ?? 'fill')
  const [fpsChoice, setFpsChoice] = useState(initial.fpsChoice ?? '30')
  const [dur, setDur] = useState(initial.dur ?? 5)
  // Background = which swatch is selected + the custom swatch's override colour
  // (null = track the preview). See the "dynamic preset" note above.
  const [selectedMatte, setSelectedMatte] = useState<MatteKey>(initial.selectedMatte ?? 'black')
  const [customOverride, setCustomOverride] = useState<Rgba | null>(initial.customOverride ?? null)
  // Runtime / gates
  const [backend, setBackend] = useState<'webgpu' | 'webgl2' | 'unknown'>('unknown')
  const hasErrors = useCompilerStore((s) => s.hasErrors)
  const fragmentShader = useCompilerStore((s) => s.fragmentShader)
  const previewBgColor = useSettingsStore((s) => s.previewBackground.color)
  // The custom swatch's live colour, and the resolved active matte (CSS string).
  const customRgba: Rgba = customOverride ?? cssToRgba(previewBgColor)
  const matte =
    selectedMatte === 'custom'
      ? rgbaToCss(customRgba)
      : (MATTES.find((m) => m.key === selectedMatte)?.color ?? MATTES[0].color)
  // Export flow
  const [phase, setPhase] = useState<Phase>('config')
  const [progress, setProgress] = useState({ frame: 0, total: 0 })
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ url: string; filename: string; sizeLabel: string; label: string } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const urlRef = useRef<string | null>(null)

  // Load the available sinks once per open, and pick a default (prefer MP4).
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setBackend(readBackend())
    void getAvailableSinks({ pro: false }).then((list) => {
      if (cancelled) return
      setSinks(list)
      setSinkId((prev) => {
        if (prev) return prev
        if (initial.sinkId && list.some((s) => s.id === initial.sinkId)) return initial.sinkId
        return list.find((s) => s.fileExt === 'mp4')?.id ?? list[0]?.id ?? null
      })
    })
    return () => {
      cancelled = true
    }
  }, [open, initial.sinkId])

  // Persist the export choices so they're re-applied next launch.
  useEffect(() => {
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          quality,
          sizeSrc,
          preset,
          customW,
          customH,
          framing,
          fpsChoice,
          dur,
          sinkId,
          selectedMatte,
          customOverride,
        } satisfies SavedSettings),
      )
    } catch {
      /* storage unavailable / quota — non-fatal */
    }
  }, [quality, sizeSrc, preset, customW, customH, framing, fpsChoice, dur, sinkId, selectedMatte, customOverride])

  // Reset transient state + revoke any object URL whenever the modal closes.
  useEffect(() => {
    if (open) return
    setPhase('config')
    setError(null)
    setDone(null)
    abortRef.current?.abort()
    abortRef.current = null
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }, [open])

  // Final safety net: revoke on unmount.
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    },
    [],
  )

  // Esc closes the modal — unless a field is mid-edit (there Esc cancels the
  // edit via the field's own handler) so a stray Esc while typing won't bail.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // An open colour-picker popover owns Escape (it closes itself) — don't also
      // tear down the whole modal on the same keypress.
      if (document.querySelector('[data-color-popover]')) return
      // Read the event's own target, not document.activeElement: a focused
      // field's Esc handler blur()s first, which would otherwise move focus to
      // <body> before this runs and defeat the guard.
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Live WYSIWYG export preview — renders an actual export frame into the canvas.
  // Ref-driven so these hooks stay above the `if (!open)` early return; the ref
  // is updated with current size/framing/active below (after they're derived).
  const previewCanvasRef = useRef<HTMLCanvasElement>(null)
  const previewStateRef = useRef<ExportPreviewState>({
    active: false,
    outW: 1,
    outH: 1,
    framing: { uDpr: 1, anchor: [0.5, 0.5] },
    exportW: 1,
  })
  // Whether the shader's output is ever translucent — read straight off the
  // preview frames we already render (a colour-typed source like hsv_to_rgb or
  // blur can't be told apart from a transparent one without the actual pixels).
  // Default hidden so the common opaque case never flashes the matte control.
  const [shaderHasAlpha, setShaderHasAlpha] = useState(false)
  useExportPreview(previewCanvasRef, previewStateRef, setShaderHasAlpha)

  // Draggable panel — offset from the centred position. Window listeners so the
  // drag survives pointer-capture loss (per the repo's pointer-drag rule).
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const dragOrigin = useRef({ px: 0, py: 0, ox: 0, oy: 0 })
  useEffect(() => {
    if (!dragging) return
    const move = (e: PointerEvent) => {
      const o = dragOrigin.current
      setDragOffset({ x: o.ox + (e.clientX - o.px), y: o.oy + (e.clientY - o.py) })
    }
    const up = () => setDragging(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [dragging])
  const startDrag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return // let header buttons work
    e.preventDefault()
    dragOrigin.current = { px: e.clientX, py: e.clientY, ox: dragOffset.x, oy: dragOffset.y }
    setDragging(true)
  }

  if (!open) return null

  // ── derived values ────────────────────────────────────────────────────────
  const selectedSink = sinks.find((s) => s.id === sinkId) ?? null
  const isZip = selectedSink?.output === 'zip'
  const isWebm = selectedSink?.fileExt === 'webm'
  const lossless = !!isZip

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const cssW = previewCanvasSize.width || 1280
  const cssH = previewCanvasSize.height || 720
  const view: ViewInfo = { cssW, cssH, deviceDpr: dpr }

  const fps = Number(fpsChoice)

  const sizeSource = (): SizeSource => {
    switch (sizeSrc) {
      case 'match':
        return { kind: 'match' }
      case '2x':
        return { kind: 'mul', factor: 2 }
      case '4x':
        return { kind: 'mul', factor: 4 }
      case 'preset': {
        const [w, h] = preset.split('x').map(Number)
        return { kind: 'preset', w, h }
      }
      case 'custom':
        return { kind: 'custom', w: Math.max(16, customW || 16), h: Math.max(16, customH || 16) }
    }
  }

  const src = sizeSource()
  const raw = targetSize(src, view)
  const outW = evenDim(raw.width)
  const outH = evenDim(raw.height)
  const { framingHidden } = describeResult(src, framing, view)
  // Compare export size against the view's LOGICAL area (matches targetSize's
  // Match = logical). Using device px here made a 1080p preset read as "smaller"
  // than a retina view → the Reveal button mislabeled itself "Crop".
  const viewArea = cssW * cssH
  const bigger = outW * outH >= viewArea
  // When the export aspect matches the view's, Fit and Fill are identical (both
  // just scale the same composition) — so Fit is redundant. Disable it, and
  // treat a stale 'fit' selection as 'fill' for rendering.
  const aspectMatches = Math.abs(outW / outH - cssW / cssH) < 0.01
  const effFraming: FramingMode = aspectMatches && framing === 'fit' ? 'fill' : framing

  // Per-mode framing card copy (title + short body; the mode-name prefix is
  // stripped so the card title doesn't repeat it).
  const framingModes = (['fill', 'fit', 'reveal'] as const).map((m) => {
    const label = m === 'reveal' ? (bigger ? 'Reveal' : 'Crop') : m === 'fill' ? 'Fill' : 'Fit'
    const raw = describeResult(src, m, view).text
    const prefix = `${label} — `
    return { v: m, label, body: raw.startsWith(prefix) ? raw.slice(prefix.length) : raw }
  })

  const frames = Math.max(1, Math.round(dur * fps))
  const areaK = (outW * outH) / 1000
  let sizeMB: number
  let timeS: number
  if (isZip) {
    sizeMB = frames * areaK * 0.0016
    timeS = frames * (areaK / 900)
  } else {
    const mbps = [3.5, 8, 16, 34][quality] * (areaK / 2073)
    sizeMB = (mbps * dur) / 8
    timeS = frames / (isWebm ? 70 : 240)
  }
  const estSize = sizeMB < 1 ? `${(sizeMB * 1000).toFixed(0)} KB` : `${sizeMB.toFixed(1)} MB`
  const estTime = timeS < 1 ? '1 s' : `${Math.ceil(timeS)} s`

  const webgpuOk =
    backend === 'webgpu' ||
    (backend === 'unknown' && typeof navigator !== 'undefined' && !!navigator.gpu && !isWebGL2Forced())
  const compileOk = !hasErrors && fragmentShader !== null
  const canExport = webgpuOk && compileOk && !!selectedSink && phase === 'config'

  const framingChoice = computeFraming(effFraming, view, outW, outH)
  // Feed the live-preview loop the current size / framing / active state.
  previewStateRef.current = {
    active: open && phase === 'config' && webgpuOk && compileOk,
    outW,
    outH,
    framing: framingChoice,
    exportW: outW,
  }

  // Blue guide: where the current view maps inside the export frame. The view
  // occupies (cssW·uDpr / outW) × (cssH·uDpr / outH) of the frame, centred — so
  // Reveal shows it smaller (reveals around it) and Fill shows it overflowing
  // (the excess is cropped). Only meaningful when the frame differs from the view.
  const guideW = (cssW * framingChoice.uDpr) / outW
  const guideH = (cssH * framingChoice.uDpr) / outH
  const showGuide = !framingHidden && Number.isFinite(guideW) && Number.isFinite(guideH)

  const gateNote = !webgpuOk
    ? 'Video export requires WebGPU.'
    : !compileOk
      ? 'Graph has no valid compile — fix errors to export.'
      : null

  // ── actions ───────────────────────────────────────────────────────────────
  const resetDone = () => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
    setDone(null)
    setPhase('config')
  }

  const startExport = async () => {
    if (!selectedSink || !canExport) return
    setError(null)
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
    setDone(null)

    const width = evenDim(raw.width)
    const height = evenDim(raw.height)
    const job: ExportJob = {
      sink: selectedSink,
      width,
      height,
      fps,
      durationSec: dur,
      alpha: selectedSink.supportsAlpha,
      matte: selectedSink.supportsAlpha ? undefined : matte,
      quality: (['draft', 'good', 'high', 'max'] as const)[quality],
      framing: computeFraming(effFraming, view, width, height),
    }

    const ac = new AbortController()
    abortRef.current = ac
    setProgress({ frame: 0, total: frames })
    setPhase('running')
    try {
      const blob = await runExport(job, (frame, total) => setProgress({ frame, total }), ac.signal)
      const url = URL.createObjectURL(blob)
      urlRef.current = url
      const sizeLabel =
        blob.size < 1024 * 1024
          ? `${(blob.size / 1024).toFixed(0)} KB`
          : `${(blob.size / (1024 * 1024)).toFixed(1)} MB`
      setDone({ url, filename: `scene.${selectedSink.fileExt}`, sizeLabel, label: selectedSink.label })
      setPhase('done')
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        setPhase('config')
        return
      }
      setError(e instanceof Error ? e.message : String(e))
      setPhase('config')
    } finally {
      abortRef.current = null
    }
  }

  const pct = progress.total ? Math.round((progress.frame / progress.total) * 100) : 0

  // ── render ──────────────────────────────────────────────────────────────────
  // Portal to <body> so the overlay escapes React Flow's transformed stacking context.
  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-overlay-scrim"
      onClick={onClose}
    >
      <div
        className="flex h-[702px] max-h-[92vh] max-w-[92vw] overflow-hidden rounded-lg border border-edge bg-surface text-fg shadow-[0_24px_60px_-12px_rgba(0,0,0,0.7)]"
        style={{ transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)` }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left: square panel (side == modal height); the export-aspect preview frame fits centred inside it */}
        <div className="hidden h-full w-[700px] flex-none flex-col bg-surface p-xl md:flex">
          <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden">
            {/* Frame box (not clipped) so the guide can overflow it when the view
                extends past the output (Fill/crop) — bounded by the panel above. */}
            <div
              className="relative max-h-full max-w-full"
              style={{
                aspectRatio: `${outW} / ${outH}`,
                width: outW >= outH ? '100%' : 'auto',
                height: outW >= outH ? 'auto' : '100%',
              }}
            >
              <div
                className="absolute inset-0 overflow-hidden rounded-sm"
                style={selectedSink && !selectedSink.supportsAlpha ? { background: matte } : CHECKER}
              >
                <canvas ref={previewCanvasRef} className="absolute inset-0 h-full w-full" />
              </div>
              {showGuide && (
                <div
                  className="pointer-events-none absolute rounded-sm border-2 border-dotted border-blue-400"
                  style={{
                    left: `${(1 - guideW) * 50}%`,
                    top: `${(1 - guideH) * 50}%`,
                    width: `${guideW * 100}%`,
                    height: `${guideH * 100}%`,
                  }}
                />
              )}
            </div>
          </div>
          <div className="mt-lg flex-none text-fg-subtle">
            <div className="text-mono-value text-fg-dim">
              {outW} × {outH} · {aspectStr(outW, outH)}
            </div>
            <div className="text-param">
              {selectedSink && !selectedSink.supportsAlpha
                ? shaderHasAlpha
                  ? 'Opaque — flattened onto the matte.'
                  : 'Fully opaque — no transparency to flatten.'
                : 'Transparent background preserved.'}
            </div>
          </div>
        </div>

        {/* Right: fixed-width controls panel (its own header + footer) */}
        <div className="flex min-h-0 w-[460px] max-w-[92vw] flex-none flex-col bg-surface-alt md:border-l md:border-edge">
          {/* Header (drag handle) */}
          <div
            onPointerDown={startDrag}
            className={cn(
              'flex flex-none select-none items-center justify-between border-b border-edge-subtle px-xl py-lg',
              dragging ? 'cursor-grabbing' : 'cursor-grab',
            )}
          >
            <span className="text-node-title font-semibold text-fg">Export</span>
            <button
              className="rounded-sm px-sm py-2xs text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
              title="Close"
              aria-label="Close"
              onClick={onClose}
            >
              ✕
            </button>
          </div>

          {/* Content: config controls OR progress/done */}
          <div className="flex min-h-0 min-w-0 flex-1">
            {phase === 'config' ? (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-xl overflow-y-auto overflow-x-hidden p-xl [scrollbar-gutter:stable]">
                {error && (
                  <div className="rounded-sm border border-edge-subtle bg-surface-raised px-md py-xs text-param text-red-400">
                    {error}
                  </div>
                )}

                {/* Size */}
                <div className="flex flex-col gap-sm">
                  <div className="flex items-center justify-between">
                    <span className={LABEL}>Size</span>
                    <span className="text-mono-value text-fg-dim">
                      current view {Math.round(cssW)} × {Math.round(cssH)}
                    </span>
                  </div>
                  <Seg
                    options={[
                      { v: 'match', label: 'Match' },
                      { v: '2x', label: '2×' },
                      { v: '4x', label: '4×' },
                      { v: 'preset', label: 'Preset' },
                      { v: 'custom', label: 'Custom' },
                    ]}
                    value={sizeSrc}
                    onChange={(v) => setSizeSrc(v as SizeSrc)}
                  />
                  <div className="flex items-center gap-sm">
                    {/* Always visible so the row never reflows; shows a placeholder
                        until a preset is chosen (which switches Size to Preset). */}
                    <Select
                      value={sizeSrc === 'preset' ? preset : ''}
                      onValueChange={(v) => {
                        setPreset(v)
                        setSizeSrc('preset')
                      }}
                    >
                      <SelectTrigger className="min-w-0 flex-1">
                        <SelectValue placeholder="Select a preset" />
                      </SelectTrigger>
                      <SelectContent className="z-[1001]">
                        {PRESETS.map((p) => (
                          <SelectItem key={p.value} value={p.value}>
                            {p.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <NumberField
                      ariaLabel="Width"
                      min={16}
                      max={7680}
                      allowMath
                      value={outW}
                      onCommit={(n) => {
                        if (sizeSrc !== 'custom') setCustomH(outH)
                        setCustomW(n)
                        setSizeSrc('custom')
                      }}
                      className="w-16 flex-none text-center"
                    />
                    <span className="text-fg-muted">×</span>
                    <NumberField
                      ariaLabel="Height"
                      min={16}
                      max={7680}
                      allowMath
                      value={outH}
                      onCommit={(n) => {
                        if (sizeSrc !== 'custom') setCustomW(outW)
                        setCustomH(n)
                        setSizeSrc('custom')
                      }}
                      className="w-16 flex-none text-center"
                    />
                  </div>
                </div>

                {/* Framing (cards; hidden when target == view) */}
                {!framingHidden && (
                  <div className="flex flex-col gap-sm">
                    <span className={LABEL}>Framing</span>
                    <div className="grid grid-cols-3 gap-sm">
                      {framingModes.map((m) => {
                        const on = effFraming === m.v
                        // Fit ≡ Fill when the aspect already matches → disable it.
                        const disabled = m.v === 'fit' && aspectMatches
                        return (
                          <button
                            key={m.v}
                            type="button"
                            disabled={disabled}
                            title={disabled ? 'Same as Fill — the aspect ratio already matches' : undefined}
                            onClick={() => setFraming(m.v)}
                            className={cn(
                              'flex h-full flex-col justify-between gap-lg rounded-sm p-lg text-left transition-colors',
                              on ? CARD_ON : CARD_OFF,
                              disabled && 'cursor-not-allowed opacity-40 hover:bg-surface-raised',
                            )}
                          >
                            <span className={cn('text-body', on ? 'text-fg' : 'text-fg-dim')}>
                              {m.label}
                            </span>
                            <span className={cn('text-param', on ? 'text-fg-dim' : 'text-fg-muted')}>
                              {cap(m.body)}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* FPS + Duration */}
                <div className="flex items-start gap-md">
                  <div className="flex flex-1 flex-col gap-sm">
                    <span className={LABEL}>Frame rate</span>
                    <Seg
                      options={[
                        { v: '24', label: '24' },
                        { v: '30', label: '30' },
                        { v: '60', label: '60' },
                        { v: '120', label: '120' },
                      ]}
                      value={fpsChoice}
                      onChange={setFpsChoice}
                    />
                  </div>
                  <div className="flex w-[136px] flex-col gap-sm">
                    <span className={LABEL}>Duration</span>
                    <DurationField value={dur} onChange={setDur} />
                  </div>
                </div>

                {/* Format (cards) */}
                <div className="flex flex-col gap-sm">
                  <span className={LABEL}>Format</span>
                  {sinks.length === 0 && (
                    <div className={HINT}>No export formats available in this browser.</div>
                  )}
                  <div className="grid grid-cols-3 gap-sm">
                    {sinks.map((s) => {
                      const on = s.id === sinkId
                      const zip = s.output === 'zip'
                      return (
                        <button
                          key={s.id}
                          type="button"
                          disabled={!webgpuOk}
                          onClick={() => setSinkId(s.id)}
                          className={cn(
                            'relative flex h-full flex-col justify-between gap-lg rounded-sm p-lg text-left transition-colors',
                            on ? CARD_ON : CARD_OFF,
                            !webgpuOk && 'cursor-not-allowed opacity-40',
                          )}
                        >
                          <span className={cn('pr-md text-body', on ? 'text-fg' : 'text-fg-dim')}>
                            {s.label}
                          </span>
                          <span className={cn('text-param', on ? 'text-fg-dim' : 'text-fg-muted')}>
                            {zip ? 'scene_####.png' : `scene.${s.fileExt}`}
                          </span>
                          {s.supportsAlpha && (
                            <span className="absolute right-xs top-xs rounded-xs bg-surface-elevated px-xs text-mono-value text-fg-dim">
                              α
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                  {gateNote && <span className="text-param text-red-400">{gateNote}</span>}
                </div>

                {/* Quality / lossless */}
                {lossless ? (
                  <div className="flex flex-col gap-sm">
                    <span className={LABEL}>Quality</span>
                    <span className={HINT}>Lossless — every frame is a full PNG.</span>
                  </div>
                ) : (
                  <div className="flex flex-col gap-sm">
                    <span className={LABEL}>Quality</span>
                    <Seg
                      options={QUALITY_LABELS.map((label, i) => ({ v: String(i), label }))}
                      value={String(quality)}
                      onChange={(v) => setQuality(Number(v))}
                    />
                  </div>
                )}

                {/* Background / matte — only when the format has no alpha AND the
                    shader actually produces transparency to flatten. */}
                {selectedSink && !selectedSink.supportsAlpha && shaderHasAlpha && (
                  <div className="flex flex-col gap-sm">
                    <span className={LABEL}>Background</span>
                    <div className="flex items-center gap-md">
                      <div className="flex flex-none items-center gap-sm">
                        {MATTES.map((m) => (
                          <button
                            key={m.key}
                            type="button"
                            title={m.label}
                            aria-label={m.label}
                            onClick={() => setSelectedMatte(m.key as MatteKey)}
                            className={cn(ds.colorSwatch.root, selectedMatte === m.key && 'ring-2 ring-indigo')}
                            style={{ background: m.color }}
                          />
                        ))}
                        {/* Custom swatch = a dynamic preset: colour resolves to the
                            override, else the preview background. Clicking selects it;
                            picking a colour sets the override (both persist). */}
                        <div onClick={() => setSelectedMatte('custom')}>
                          <RgbaColorPicker
                            mode="popover"
                            showAlpha={false}
                            triggerIcon="pipette"
                            value={customRgba}
                            onChange={(rgba) => {
                              setCustomOverride(rgba)
                              setSelectedMatte('custom')
                            }}
                            className={cn('rounded-sm', selectedMatte === 'custom' && 'ring-2 ring-indigo')}
                          />
                        </div>
                      </div>
                      <span className={cn(HINT, 'flex-1')}>
                        MP4 / H.264 has no transparency — transparent pixels flatten onto this color.
                      </span>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col justify-center gap-xl overflow-y-auto p-xl">
                {phase === 'running' && (
                  <div>
                    <div className="text-body text-fg-dim">
                      Encoding · <b className="font-semibold text-fg">{selectedSink?.label}</b>
                    </div>
                    <div className="my-md h-2 overflow-hidden rounded-xs bg-edge">
                      <div
                        className="h-full rounded-xs bg-indigo transition-[width] duration-100"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-mono-value tabular-nums text-fg-subtle">
                      <span>
                        {progress.frame} / {progress.total} frames
                      </span>
                      <span>{pct}%</span>
                    </div>
                    <div className="mt-md text-right">
                      <button type="button" className={BTN} onClick={() => abortRef.current?.abort()}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {phase === 'done' && done && (
                  <div className="flex flex-col gap-2xs">
                    <div className="flex items-center gap-sm text-body">
                      <icons.check className="size-5 text-success" />
                      <span>Exported</span>
                    </div>
                    <div className="text-mono-value tabular-nums text-fg-dim">
                      {done.filename} · {done.sizeLabel}
                    </div>
                    <div className="mt-md flex justify-end gap-sm">
                      <button type="button" className={BTN} onClick={resetDone}>
                        Close
                      </button>
                      <a href={done.url} download={done.filename} className={BTN_PRIMARY}>
                        Download
                      </a>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer (config only) */}
          {phase === 'config' && (
            <div className="flex flex-none items-center justify-between gap-md border-t border-edge-subtle bg-surface-alt px-xl py-lg">
              <div className="flex min-w-0 items-baseline gap-xs text-mono-value tabular-nums text-fg-subtle">
                <span>
                  <b className="font-semibold text-fg-dim">{frames}</b> frames
                </span>
                <span className="text-fg-muted">·</span>
                <span>~{estSize}</span>
                <span className="text-fg-muted">·</span>
                <span>~{estTime}</span>
              </div>
              <div className="flex flex-none gap-sm">
                <button type="button" className={BTN} onClick={onClose}>
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!canExport}
                  onClick={startExport}
                  title={gateNote ?? undefined}
                  className={canExport ? BTN_PRIMARY : BTN_PRIMARY_OFF}
                >
                  Export
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
