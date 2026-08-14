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
import { icons } from '@/components/icons'
import { previewCanvasSize } from '@/utils/preview-canvas-size'
import { useCompilerStore } from '@/stores/compilerStore'
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
const evenDim = (n: number) => Math.max(16, Math.round(n) & ~1)

/** The app exposes the active renderer instance (and its `.backend`) on the dev bridge. */
function readBackend(): 'webgpu' | 'webgl2' | 'unknown' {
  const w = window as unknown as { __sombra?: { renderer?: { backend?: 'webgpu' | 'webgl2' } } }
  const b = w.__sombra?.renderer?.backend
  return b === 'webgpu' || b === 'webgl2' ? b : 'unknown'
}

const LABEL = 'text-[10.5px] font-semibold uppercase tracking-wider text-fg-subtle'
const HINT = 'text-[11px] leading-snug text-fg-muted'

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
    <div className="flex gap-1.5">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          title={o.title}
          disabled={disabled}
          onClick={() => onChange(o.v)}
          className={cn(
            'flex-1 rounded-md border px-0.5 py-1.5 text-xs tabular-nums transition-colors',
            o.v === value
              ? 'border-indigo bg-indigo text-white'
              : 'border-edge-subtle bg-surface-raised text-fg-dim hover:bg-surface-elevated',
            disabled && 'cursor-not-allowed opacity-40',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function ExportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Format
  const [sinks, setSinks] = useState<FrameSink[]>([])
  const [sinkId, setSinkId] = useState<string | null>(null)
  // Controls
  const [quality, setQuality] = useState(2) // High
  const [sizeSrc, setSizeSrc] = useState<SizeSrc>('match')
  const [preset, setPreset] = useState('1920x1080')
  const [customW, setCustomW] = useState(1600)
  const [customH, setCustomH] = useState(900)
  const [framing, setFraming] = useState<FramingMode>('reveal')
  const [fpsChoice, setFpsChoice] = useState('30')
  const [fpsCustom, setFpsCustom] = useState(48)
  const [dur, setDur] = useState(5)
  const [matte, setMatte] = useState(MATTES[0].color)
  // Runtime / gates
  const [backend, setBackend] = useState<'webgpu' | 'webgl2' | 'unknown'>('unknown')
  const hasErrors = useCompilerStore((s) => s.hasErrors)
  const fragmentShader = useCompilerStore((s) => s.fragmentShader)
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
      setSinkId((prev) => prev ?? list.find((s) => s.fileExt === 'mp4')?.id ?? list[0]?.id ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [open])

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
  useExportPreview(previewCanvasRef, previewStateRef)

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

  const fps = fpsChoice === 'custom' ? Math.max(1, fpsCustom || 1) : Number(fpsChoice)

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
  const { text: resultText, framingHidden } = describeResult(src, framing, view)
  // Compare export size against the view's LOGICAL area (matches targetSize's
  // Match = logical). Using device px here made a 1080p preset read as "smaller"
  // than a retina view → the Reveal button mislabeled itself "Crop".
  const viewArea = cssW * cssH
  const bigger = outW * outH >= viewArea

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

  // Feed the live-preview loop the current size / framing / active state.
  previewStateRef.current = {
    active: open && phase === 'config' && webgpuOk && compileOk,
    outW,
    outH,
    framing: computeFraming(framing, view, outW, outH),
    exportW: outW,
  }

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
      framing: computeFraming(framing, view, width, height),
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
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-[800px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-edge bg-surface-alt text-fg shadow-[0_24px_60px_-12px_rgba(0,0,0,0.7)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex flex-none items-center justify-between border-b border-edge-subtle px-[18px] py-3.5">
          <div className="flex items-center gap-2.5 text-[15px] font-semibold">
            <span className="size-2 rounded-full bg-indigo shadow-[0_0_10px_var(--color-indigo)]" />
            Export
          </div>
          <button
            className="rounded px-2 py-1 text-fg-subtle transition-colors hover:bg-surface-elevated hover:text-fg"
            title="Close"
            aria-label="Close"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {/* Body: preview | right column */}
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[330px_minmax(0,1fr)]">
          {/* Preview */}
          <div className="flex min-h-0 min-w-0 flex-col gap-2.5 border-b border-edge-subtle bg-surface p-[18px] md:border-b-0 md:border-r">
            <div className="relative flex min-h-0 flex-1 items-center justify-center">
              <div
                className="relative max-h-full max-w-full overflow-hidden rounded-md border border-edge-card bg-surface"
                style={{
                  aspectRatio: `${outW} / ${outH}`,
                  width: outW >= outH ? '100%' : 'auto',
                  height: outW >= outH ? 'auto' : '100%',
                  ...(selectedSink && !selectedSink.supportsAlpha ? { background: matte } : CHECKER),
                }}
              >
                <canvas ref={previewCanvasRef} className="absolute inset-0 h-full w-full" />
              </div>
            </div>
            <div className="flex-none text-[11.5px] leading-relaxed text-fg-subtle">
              <div className="font-mono tabular-nums text-fg-dim">
                {outW} × {outH} · {aspectStr(outW, outH)}
              </div>
              <div>
                {selectedSink && !selectedSink.supportsAlpha ? 'Opaque — flattened onto the matte.' : 'Transparent background preserved.'}
              </div>
            </div>
          </div>

          {/* Right column: controls OR progress/done */}
          <div className="flex min-h-0 min-w-0">
            {phase === 'config' ? (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden p-[18px] [scrollbar-gutter:stable]">
                {error && (
                  <div className="rounded-md border border-edge-subtle bg-surface-raised px-3 py-2 text-[11.5px] text-red-400">
                    {error}
                  </div>
                )}

                {/* Format */}
                <div className="flex flex-col gap-1.5">
                  <span className={LABEL}>Format</span>
                  <div className="flex flex-col gap-1.5">
                    {sinks.length === 0 && (
                      <div className={HINT}>No export formats available in this browser.</div>
                    )}
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
                            'flex items-center gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors',
                            on
                              ? 'border-indigo bg-indigo/10'
                              : 'border-edge-subtle bg-surface-raised hover:bg-surface-elevated',
                            !webgpuOk && 'cursor-not-allowed opacity-50',
                          )}
                        >
                          <span
                            className={cn(
                              'relative size-[15px] flex-none rounded-full border-2',
                              on ? 'border-indigo' : 'border-fg-muted',
                            )}
                          >
                            {on && <span className="absolute inset-[3px] rounded-full bg-indigo" />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-[13px] font-medium text-fg">{s.label}</span>
                            <span className="block font-mono text-[11px] text-fg-muted">
                              {zip ? 'scene_####.png · .zip' : `scene.${s.fileExt}`}
                            </span>
                          </span>
                          {s.supportsAlpha && (
                            <span className="rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold text-fuchsia-300 bg-fuchsia-500/15">
                              ⍺
                            </span>
                          )}
                          <span
                            className={cn(
                              'rounded px-1.5 py-0.5 text-[10px] font-semibold',
                              zip ? 'bg-green-500/15 text-green-300' : 'bg-indigo/20 text-indigo-300',
                            )}
                          >
                            {zip ? 'editor' : 'web'}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  {gateNote && <span className="text-[11px] leading-snug text-amber-400">{gateNote}</span>}
                </div>

                {/* Quality / lossless */}
                {lossless ? (
                  <div className="flex flex-col gap-1.5">
                    <span className={LABEL}>Quality</span>
                    <span className={HINT}>Lossless — every frame is a full PNG.</span>
                  </div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    <span className={LABEL}>Quality</span>
                    <Seg
                      options={QUALITY_LABELS.map((label, i) => ({ v: String(i), label }))}
                      value={String(quality)}
                      onChange={(v) => setQuality(Number(v))}
                    />
                  </div>
                )}

                {/* Size */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <span className={LABEL}>Size</span>
                    <span className="font-mono text-[11.5px] tabular-nums text-fg-dim">
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
                  {sizeSrc === 'preset' && (
                    <select
                      aria-label="Preset resolution"
                      value={preset}
                      onChange={(e) => setPreset(e.target.value)}
                      className="w-full cursor-pointer rounded-md border border-edge-subtle bg-surface-raised px-2.5 py-2 text-[12.5px] tabular-nums text-fg"
                    >
                      {PRESETS.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  )}
                  {sizeSrc === 'custom' && (
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        aria-label="Width"
                        min={16}
                        max={7680}
                        value={customW}
                        onChange={(e) => setCustomW(Math.max(16, Number(e.target.value) || 16))}
                        className="w-[74px] rounded-md border border-edge-subtle bg-surface-raised px-2.5 py-2 text-[12.5px] tabular-nums text-fg"
                      />
                      <span className="text-fg-muted">×</span>
                      <input
                        type="number"
                        aria-label="Height"
                        min={16}
                        max={7680}
                        value={customH}
                        onChange={(e) => setCustomH(Math.max(16, Number(e.target.value) || 16))}
                        className="w-[74px] rounded-md border border-edge-subtle bg-surface-raised px-2.5 py-2 text-[12.5px] tabular-nums text-fg"
                      />
                    </div>
                  )}
                </div>

                {/* Framing (hidden when target == view) */}
                {!framingHidden && (
                  <div className="flex flex-col gap-1.5">
                    <span className={LABEL}>Framing</span>
                    <Seg
                      options={[
                        {
                          v: 'reveal',
                          label: bigger ? 'Reveal' : 'Crop',
                          title: bigger
                            ? 'The export size sets the shot — a bigger frame reveals more scene. Anchor-relative, never letterboxed.'
                            : 'The export size sets the shot — a smaller frame crops in to a tighter view. Anchor-relative.',
                        },
                        {
                          v: 'fill',
                          label: 'Fill',
                          title: 'Scale your composition to COVER the target aspect; crop the overflow. No bars.',
                        },
                        {
                          v: 'fit',
                          label: 'Fit',
                          title: 'Keep your WHOLE composition; fill the leftover with revealed scene instead of letterbox bars.',
                        },
                      ]}
                      value={framing}
                      onChange={(v) => setFraming(v as FramingMode)}
                    />
                  </div>
                )}

                {/* You'll get */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <span className={LABEL}>You'll get</span>
                    <span className="font-mono text-[12.5px] tabular-nums text-fg">
                      {outW} × {outH} · {aspectStr(outW, outH)}
                    </span>
                  </div>
                  <div className="rounded-md border border-edge-subtle bg-indigo/[0.08] px-3 py-2.5 text-[11.5px] leading-relaxed text-fg-dim">
                    {framingHidden ? 'Exporting your current view exactly, 1:1.' : resultText}
                  </div>
                </div>

                {/* FPS + Duration */}
                <div className="flex items-start gap-4">
                  <div className="flex flex-1 flex-col gap-1.5">
                    <span className={LABEL}>Frame rate</span>
                    <Seg
                      options={[
                        { v: '24', label: '24' },
                        { v: '30', label: '30' },
                        { v: '60', label: '60' },
                        { v: 'custom', label: 'Custom' },
                      ]}
                      value={fpsChoice}
                      onChange={setFpsChoice}
                    />
                    {fpsChoice === 'custom' && (
                      <input
                        type="number"
                        aria-label="Custom fps"
                        min={1}
                        max={120}
                        value={fpsCustom}
                        onChange={(e) => setFpsCustom(Math.max(1, Number(e.target.value) || 1))}
                        className="rounded-md border border-edge-subtle bg-surface-raised px-2.5 py-2 text-[12.5px] tabular-nums text-fg"
                      />
                    )}
                  </div>
                  <div className="flex w-[120px] flex-col gap-1.5">
                    <span className={LABEL}>Duration</span>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        aria-label="Duration seconds"
                        min={0.1}
                        step={0.5}
                        value={dur}
                        onChange={(e) => setDur(Math.max(0.1, Number(e.target.value) || 0.1))}
                        className="w-full rounded-md border border-edge-subtle bg-surface-raised px-2.5 py-2 text-[12.5px] tabular-nums text-fg"
                      />
                      <span className="font-mono text-[11.5px] text-fg-dim">s</span>
                    </div>
                  </div>
                </div>

                {/* Background / matte — only when the format has no alpha */}
                {selectedSink && !selectedSink.supportsAlpha && (
                  <div className="flex flex-col gap-1.5">
                    <span className={LABEL}>Background</span>
                    <span className={HINT}>
                      MP4 / H.264 has no transparency — transparent pixels flatten onto this color.
                    </span>
                    <div className="flex items-center gap-1.5">
                      {MATTES.map((m) => (
                        <button
                          key={m.key}
                          type="button"
                          title={m.label}
                          aria-label={m.label}
                          onClick={() => setMatte(m.color)}
                          className={cn(
                            'size-[26px] rounded-md border border-edge-card',
                            matte === m.color && 'outline outline-2 outline-offset-1 outline-indigo',
                          )}
                          style={{ background: m.color }}
                        />
                      ))}
                      <label
                        className="relative size-[26px] cursor-pointer overflow-hidden rounded-md border border-edge-card"
                        title="Custom"
                        style={{
                          background:
                            'conic-gradient(from 0deg, rgb(255,0,0), rgb(255,255,0), rgb(0,255,0), rgb(0,255,255), rgb(0,0,255), rgb(255,0,255), rgb(255,0,0))',
                        }}
                      >
                        <input
                          type="color"
                          aria-label="Custom background color"
                          className="absolute inset-0 cursor-pointer opacity-0"
                          onChange={(e) => setMatte(e.target.value)}
                        />
                      </label>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col justify-center gap-4 overflow-y-auto p-[18px]">
                {phase === 'running' && (
                  <div>
                    <div className="text-[13px] text-fg-dim">
                      Encoding · <b className="font-semibold text-fg">{selectedSink?.label}</b>
                    </div>
                    <div className="my-3.5 h-2 overflow-hidden rounded bg-edge">
                      <div
                        className="h-full rounded bg-indigo transition-[width] duration-100"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="flex justify-between font-mono text-xs tabular-nums text-fg-subtle">
                      <span>
                        {progress.frame} / {progress.total} frames
                      </span>
                      <span>{pct}%</span>
                    </div>
                    <div className="mt-4 text-right">
                      <button
                        type="button"
                        className="rounded-lg border border-edge px-4 py-2 text-[13px] font-medium text-fg-dim transition-colors hover:bg-surface-elevated hover:text-fg"
                        onClick={() => abortRef.current?.abort()}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {phase === 'done' && done && (
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2.5 text-sm">
                      <icons.check className="size-5 text-green-400" />
                      <span>Exported</span>
                    </div>
                    <div className="font-mono text-[12.5px] tabular-nums text-fg-dim">
                      {done.filename} · {done.sizeLabel}
                    </div>
                    <div className="mt-3.5 flex justify-end gap-2.5">
                      <button
                        type="button"
                        className="rounded-lg border border-edge px-4 py-2 text-[13px] font-medium text-fg-dim transition-colors hover:bg-surface-elevated hover:text-fg"
                        onClick={resetDone}
                      >
                        Close
                      </button>
                      <a
                        href={done.url}
                        download={done.filename}
                        className="rounded-lg bg-indigo px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-indigo-hover"
                      >
                        Download
                      </a>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer (config only) */}
        {phase === 'config' && (
          <div className="flex flex-none items-center justify-between gap-3.5 border-t border-edge-subtle bg-surface-alt px-[18px] py-3">
            <div className="flex min-w-0 items-baseline gap-2 font-mono text-xs tabular-nums text-fg-subtle">
              <span>
                <b className="font-semibold text-fg-dim">{frames}</b> frames
              </span>
              <span className="text-fg-muted">·</span>
              <span>~{estSize}</span>
              <span className="text-fg-muted">·</span>
              <span>~{estTime}</span>
            </div>
            <div className="flex flex-none gap-2.5">
              <button
                type="button"
                className="rounded-lg border border-edge px-[18px] py-2 text-[13px] font-medium text-fg-dim transition-colors hover:bg-surface-elevated hover:text-fg"
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!canExport}
                onClick={startExport}
                title={gateNote ?? undefined}
                className={cn(
                  'rounded-lg px-[18px] py-2 text-[13px] font-medium transition-colors',
                  canExport
                    ? 'bg-indigo text-white hover:bg-indigo-hover'
                    : 'cursor-not-allowed bg-indigo/40 text-white/70',
                )}
              >
                Export
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
