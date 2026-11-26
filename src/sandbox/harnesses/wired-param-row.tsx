/**
 * Wired Param Row (Option D, "Live indicator").
 *
 * Mounts the real WiredParamRow inside a node-shaped shell at the real node
 * width (212), next to the unwired rows it sits among, with a fixture for every
 * state on the board "Wired param display — options" (999:6139): constant float,
 * time-driven float (a looping fake history at ~10 Hz, the cadence the board
 * asks for), per-pixel float with and without a range, constant colour with
 * alpha < 1, per-pixel colour palette, Stack opacity and mask, a Transform row,
 * hover, and a long source name. Every prop has a control.
 *
 * The handle is a static dot: real React Flow handles exist only inside a canvas
 * node. The component takes it as a slot so this harness can stand it in.
 *
 * Reference rows (`data-ref-row`): the unwired DS row each wired row replaces —
 * the connectable slider row (Transform rows, Stack opacity) and the labelled
 * port row (Stack mask) — so "same height as unwired" can be measured.
 */

import { useEffect, useState, type ReactNode } from 'react'
import {
  WiredParamRow,
  type WiredKind,
  type WiredRgba,
  type WiredValue,
} from '@/components/WiredParamRow'
import { SectionHeader } from '@/components/SectionHeader'
import { FloatSlider } from '@/components/NodeParameters'
import type { NodeParameter } from '@/nodes/types'
import { ds } from '@/generated/ds'
import { cn } from '@/lib/utils'
import { getPortColor } from '@/utils/port-colors'

type Mode = WiredValue['mode']
type Context = 'body' | 'transform' | 'stack'
type Signal = 'sine' | 'ramp'
type Format = 'fixed2' | 'int' | 'deg'
type PaletteKey = 'gradient' | 'noise' | 'none'
type Tri = 'auto' | 'true' | 'false'

const FORMATS: Record<Format, (v: number) => string> = {
  fixed2: (v) => v.toFixed(2),
  int: (v) => String(Math.round(v)),
  deg: (v) => `${Math.round(v)}°`,
}
// Placeholder palettes, as on the board (a readback would supply real samples).
const PALETTES: Record<PaletteKey, string[]> = {
  gradient: ['#6366f1', '#818cf8', '#a78bfa', '#f472b6', '#fbbf24', '#fbbf24'],
  noise: ['#1a1a2e', '#3a3a52', '#5a5a6e', '#88889a', '#b8b8c8', '#e8e8f0', '#88889a', '#3a3a52'],
  none: [],
}
const LONG_NODE = 'Brightness / Contrast (luminance remap)'

interface Fixture {
  label: string
  context: Context
  kind: WiredKind
  paramLabel: string
  node: string
  output: string
  mode: Mode
  constant?: number
  color?: WiredRgba
  signal?: Signal
  min?: number | null
  max?: number | null
  palette?: PaletteKey
  range: [number, number]
  format?: Format
  tooltip?: Tri
}

const FIXTURES: Record<string, Fixture> = {
  constant: { label: '1 · Constant — Scale ← Number', context: 'body', kind: 'float', paramLabel: 'Scale', node: 'Number', output: 'value', mode: 'constant', constant: 1.5, range: [0.1, 4] },
  animated: { label: '2 · Animated — Gap ← Time', context: 'body', kind: 'float', paramLabel: 'Gap', node: 'Time', output: 'time', mode: 'animated', signal: 'sine', range: [0, 10] },
  variesRange: { label: '3 · Per-pixel with range — Gap ← Noise', context: 'body', kind: 'float', paramLabel: 'Gap', node: 'Noise', output: 'value', mode: 'varies', min: 0.12, max: 0.88, range: [0, 1] },
  varies: { label: '3b · Per-pixel, range unknown', context: 'body', kind: 'float', paramLabel: 'Gap', node: 'Noise', output: 'value', mode: 'varies', min: null, max: null, range: [0, 1] },
  colorConstant: { label: '4 · Colour constant, alpha 0.5', context: 'body', kind: 'color', paramLabel: 'Color A', node: 'Color', output: 'color', mode: 'constant', color: [0.984, 0.749, 0.141, 0.5], range: [0, 1] },
  colorVaries: { label: '4b · Colour per-pixel — palette', context: 'body', kind: 'color', paramLabel: 'Color B', node: 'Gradient', output: 'color', mode: 'varies', palette: 'gradient', range: [0, 1] },
  opacity: { label: '5 · Stack opacity ← Number', context: 'stack', kind: 'opacity', paramLabel: 'Opacity', node: 'Number', output: 'value', mode: 'constant', constant: 0.65, range: [0, 1] },
  mask: { label: '5b · Stack mask ← Noise', context: 'stack', kind: 'mask', paramLabel: 'Mask', node: 'Noise', output: 'value', mode: 'varies', min: 0.1, max: 0.82, range: [0, 1] },
  transform: { label: '6 · Transform — Rotate ← Time', context: 'transform', kind: 'float', paramLabel: 'Rotate', node: 'Time', output: 'time', mode: 'animated', signal: 'ramp', range: [-180, 180], format: 'deg' },
  hover: { label: '7 · Hover (tooltip held)', context: 'body', kind: 'float', paramLabel: 'Scale', node: 'Number', output: 'value', mode: 'constant', constant: 1.5, range: [0.1, 4], tooltip: 'true' },
  long: { label: 'Long source name', context: 'body', kind: 'float', paramLabel: 'Scale', node: LONG_NODE, output: 'value', mode: 'constant', constant: 0.25, range: [0, 1] },
}

const HISTORY_LEN = 20 // ~2 s at 10 Hz
const TICK_MS = 100

/** The fake time-driven source: a Time → Sin chain, or Time itself wrapping in the range. */
function sample(signal: Signal, t: number, range: [number, number]): number {
  const [lo, hi] = range
  if (signal === 'ramp') return lo + (((t * 40) % (hi - lo)) + (hi - lo)) % (hi - lo)
  const mid = (lo + hi) / 2, amp = (hi - lo) * 0.3
  return mid + amp * (0.75 * Math.sin(t * 2.1) + 0.25 * Math.sin(t * 5.3))
}

function Dot({ connected, color }: { connected: boolean; color: string }) {
  return (
    <span
      className={cn(ds.handle.root, 'block')}
      style={{ borderColor: color, backgroundColor: connected ? color : 'var(--surface-elevated)', width: 12, height: 12 }}
    />
  )
}
/** Where React Flow puts a left handle: centred on the row's left edge. */
function HandleSlot({ color, connected = true }: { color: string; connected?: boolean }) {
  return (
    <span className="absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2" data-handle="">
      <Dot connected={connected} color={color} />
    </span>
  )
}

const P = (id: string, label: string, def: number, min: number, max: number, step: number): NodeParameter =>
  ({ id, label, type: 'float', default: def, min, max, step, connectable: true, updateMode: 'uniform' })

/** The unwired DS slider row (connectableParamRow) — the reference height. */
function UnwiredRow({ label, value, min, max, step, refRow }: { label: string; value: number; min: number; max: number; step: number; refRow?: string }) {
  const [v, setV] = useState(value)
  return (
    <div className={ds.connectableParamRow.sliderRow} data-ref-row={refRow}>
      <HandleSlot color={getPortColor('float')} connected={false} />
      <div className={ds.connectableParamRow.innerFrame}>
        <FloatSlider param={P(label, label, value, min, max, step)} value={v} onChange={(x) => setV(x as number)} />
      </div>
    </div>
  )
}

// ── Harness chrome ───────────────────────────────────────────────────────────
const chip = (on: boolean) => cn(
  'text-param px-md py-xs rounded-sm border border-edge cursor-pointer',
  on ? 'bg-surface-elevated text-fg' : 'bg-surface-alt text-fg-dim',
)
const field = 'text-param bg-surface-alt text-fg border border-edge rounded-sm px-sm py-2xs'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-md text-param text-fg-dim">
      <span>{label}</span>
      {children}
    </label>
  )
}
function Num({ value, onChange, step = 0.01, control }: { value: number; onChange: (v: number) => void; step?: number; control: string }) {
  return (
    <input
      type="number" step={step} className={cn(field, 'w-[84px]')} value={value}
      onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(n) }}
      data-control={control}
    />
  )
}

function NodeShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={cn(ds.nodeCard.root, 'w-[212px]')}>
      <div className={ds.nodeCard.header}><span className={ds.nodeCard.title}>{title}</span></div>
      <div className={ds.nodeCard.content}>{children}</div>
    </div>
  )
}

export default function WiredParamRowHarness() {
  const [fixture, setFixture] = useState('constant')
  const [context, setContext] = useState<Context>('body')
  const [kind, setKind] = useState<WiredKind>('float')
  const [paramLabel, setParamLabel] = useState('Scale')
  const [node, setNode] = useState('Number')
  const [output, setOutput] = useState('value')
  const [mode, setMode] = useState<Mode>('constant')
  const [constant, setConstant] = useState(1.5)
  const [color, setColor] = useState<WiredRgba>([0.984, 0.749, 0.141, 1])
  const [signal, setSignal] = useState<Signal>('sine')
  const [running, setRunning] = useState(true)
  const [useMin, setUseMin] = useState(true)
  const [useMax, setUseMax] = useState(true)
  const [min, setMin] = useState(0.12)
  const [max, setMax] = useState(0.88)
  const [palette, setPalette] = useState<PaletteKey>('gradient')
  const [range, setRange] = useState<[number, number]>([0.1, 4])
  const [format, setFormat] = useState<Format>('fixed2')
  const [slot, setSlot] = useState(true)
  const [hint, setHint] = useState('Disconnect to edit.')
  const [tooltip, setTooltip] = useState<Tri>('auto')

  // ── The looping fake source (10 Hz, ~2 s window) ──
  const [anim, setAnim] = useState<{ value: number; history: number[] }>({ value: 0, history: [] })
  useEffect(() => {
    if (mode !== 'animated') return
    const t0 = performance.now()
    const seed: number[] = []
    for (let i = HISTORY_LEN - 1; i >= 0; i--) seed.push(sample(signal, -i * (TICK_MS / 1000), range))
    setAnim({ value: seed[seed.length - 1], history: seed })
    if (!running) return
    const id = window.setInterval(() => {
      const t = (performance.now() - t0) / 1000
      const v = sample(signal, t, range)
      setAnim((a) => ({ value: v, history: [...a.history, v].slice(-HISTORY_LEN) }))
    }, TICK_MS)
    return () => window.clearInterval(id)
  }, [mode, signal, running, range])

  const load = (key: string) => {
    const f = FIXTURES[key]
    setFixture(key)
    setContext(f.context)
    setKind(f.kind)
    setParamLabel(f.paramLabel)
    setNode(f.node)
    setOutput(f.output)
    setMode(f.mode)
    if (f.constant != null) setConstant(f.constant)
    if (f.color) setColor(f.color)
    setSignal(f.signal ?? 'sine')
    setUseMin(f.min != null)
    setUseMax(f.max != null)
    if (f.min != null) setMin(f.min)
    if (f.max != null) setMax(f.max)
    setPalette(f.palette ?? 'gradient')
    setRange(f.range)
    setFormat(f.format ?? 'fixed2')
    setTooltip(f.tooltip ?? 'auto')
    setSlot(true)
    setHint('Disconnect to edit.')
    setRunning(true)
  }

  const value: WiredValue =
    mode === 'constant' ? { mode, value: kind === 'color' ? color : constant }
    : mode === 'animated' ? { mode, value: anim.value, history: anim.history }
    : { mode, min: useMin ? min : undefined, max: useMax ? max : undefined, palette: PALETTES[palette] }

  const portColor = getPortColor(kind === 'color' ? 'color' : 'float')
  const wired = (
    <WiredParamRow
      label={paramLabel}
      kind={kind}
      source={{ node, output }}
      value={value}
      range={range}
      formatValue={FORMATS[format]}
      handle={slot ? <HandleSlot color={portColor} /> : undefined}
      hint={hint}
      tooltipOpen={tooltip === 'auto' ? undefined : tooltip === 'true'}
    />
  )

  let stage: ReactNode
  if (context === 'transform') {
    stage = (
      <NodeShell title="Stripes">
        <UnwiredRow label="Width" value={40} min={0} max={100} step={1} />
        <div className={cn(ds.shaderNode.paramDivider, 'mt-xs pt-xs')}>
          <SectionHeader label="Transform" open onToggle={() => {}} wiredParams={[{ label: paramLabel, source: `${node}.${output}` }]} />
          <div className="flex flex-col gap-y-md pt-xs">
            <UnwiredRow label="Scale" value={1} min={0} max={10} step={0.01} refRow="float" />
            <div data-testid="wired-slot">{wired}</div>
            <UnwiredRow label="Offset X" value={0} min={-500} max={500} step={1} />
          </div>
        </div>
      </NodeShell>
    )
  } else if (context === 'stack') {
    stage = (
      <NodeShell title="Stack">
        <div className="flex flex-col gap-md">
          <div className="flex flex-col gap-2xs pl-handle-offset">
            <span className={ds.stackLayer.name}>Layer 2</span>
            <span className={ds.stackLayer.source}>← Checkerboard.color</span>
          </div>
          <UnwiredRow label="Opacity (unwired)" value={1} min={0} max={1} step={0.01} refRow="float" />
          <div className={ds.labeledHandle.root} data-ref-row="mask">
            <HandleSlot color={getPortColor('float')} connected={false} />
            <span className={ds.labeledHandle.label}>Mask (unwired)</span>
          </div>
          <div data-testid="wired-slot">{wired}</div>
        </div>
      </NodeShell>
    )
  } else {
    stage = (
      <NodeShell title={kind === 'color' ? 'Stripes' : 'Warp'}>
        <div className="flex flex-col gap-md">
          <div data-testid="wired-slot">{wired}</div>
          <UnwiredRow label="Strength" value={0.5} min={0} max={1} step={0.01} refRow="float" />
          <div className={ds.labeledHandle.root} data-ref-row="mask">
            <HandleSlot color={getPortColor('float')} connected={false} />
            <span className={ds.labeledHandle.label}>Mask</span>
          </div>
        </div>
      </NodeShell>
    )
  }

  return (
    <div className="flex flex-col gap-xl p-xl bg-surface min-h-screen text-fg">
      <div className="flex flex-col gap-xs">
        <h1 className="text-node-title">Wired Param Row — Option D, live indicator</h1>
        <p className="text-param text-fg-subtle max-w-[52rem]">
          The real component in a 212px node, beside the unwired rows it replaces. What a wired parameter actually
          gets: an exact number with a tick, a ticking number with a sparkline, or “varies” with a min–max range.
          Colours show a swatch and strip, or a sampled palette. Hover a row (or Tab to it) for the tooltip.
        </p>
        <div className="flex flex-wrap gap-sm" data-testid="fixtures">
          {Object.entries(FIXTURES).map(([key, f]) => (
            <button key={key} data-fixture={key} onClick={() => load(key)} className={chip(key === fixture)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-2xl items-start flex-wrap">
        <div className="w-[260px] shrink-0 flex justify-center pt-md" data-testid="stage">{stage}</div>

        {/* Controls — one per prop */}
        <div className="flex flex-col gap-md w-[320px] bg-surface-alt border border-edge-subtle rounded-md p-lg" data-testid="controls">
          <span className="text-category text-fg-subtle uppercase">Props</span>
          <Row label="label">
            <input className={cn(field, 'w-[150px]')} value={paramLabel} onChange={(e) => setParamLabel(e.target.value)} data-control="label" />
          </Row>
          <Row label="kind">
            <select className={field} value={kind} onChange={(e) => setKind(e.target.value as WiredKind)} data-control="kind">
              <option value="float">float</option><option value="color">color</option>
              <option value="opacity">opacity</option><option value="mask">mask</option>
            </select>
          </Row>
          <Row label="source.node">
            <input className={cn(field, 'w-[150px]')} value={node} onChange={(e) => setNode(e.target.value)} data-control="node" />
          </Row>
          <Row label="source.output">
            <input className={cn(field, 'w-[150px]')} value={output} onChange={(e) => setOutput(e.target.value)} data-control="output" />
          </Row>
          <Row label="value.mode">
            <select className={field} value={mode} onChange={(e) => setMode(e.target.value as Mode)} data-control="mode">
              <option value="constant">constant</option><option value="animated">animated</option><option value="varies">varies</option>
            </select>
          </Row>
          {mode === 'constant' && kind !== 'color' && (
            <Row label="value"><Num value={constant} onChange={setConstant} control="constant" /></Row>
          )}
          {mode === 'constant' && kind === 'color' && (
            <div className="flex items-center justify-between gap-xs text-param text-fg-dim">
              <span>value (r g b a)</span>
              {(['r', 'g', 'b', 'a'] as const).map((ch, i) => (
                <input
                  key={ch} type="number" min={0} max={1} step={0.05} className={cn(field, 'w-[52px]')} value={color[i]}
                  onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) setColor((c) => c.map((x, j) => (j === i ? n : x)) as WiredRgba) }}
                  data-control={`color-${ch}`}
                />
              ))}
            </div>
          )}
          {mode === 'animated' && (
            <>
              <Row label="fake source">
                <select className={field} value={signal} onChange={(e) => setSignal(e.target.value as Signal)} data-control="signal">
                  <option value="sine">Time → Sin chain</option><option value="ramp">Time (wraps in range)</option>
                </select>
              </Row>
              <Row label="running (10 Hz)">
                <input type="checkbox" checked={running} onChange={(e) => setRunning(e.target.checked)} data-control="running" />
              </Row>
            </>
          )}
          {mode === 'varies' && kind !== 'color' && (
            <>
              <Row label="min">
                <span className="flex items-center gap-xs">
                  <input type="checkbox" checked={useMin} onChange={(e) => setUseMin(e.target.checked)} data-control="use-min" />
                  <Num value={min} onChange={setMin} control="min" />
                </span>
              </Row>
              <Row label="max">
                <span className="flex items-center gap-xs">
                  <input type="checkbox" checked={useMax} onChange={(e) => setUseMax(e.target.checked)} data-control="use-max" />
                  <Num value={max} onChange={setMax} control="max" />
                </span>
              </Row>
            </>
          )}
          {mode === 'varies' && kind === 'color' && (
            <Row label="palette">
              <select className={field} value={palette} onChange={(e) => setPalette(e.target.value as PaletteKey)} data-control="palette">
                <option value="gradient">gradient (6)</option><option value="noise">noise greys (8)</option><option value="none">none (unknown)</option>
              </select>
            </Row>
          )}
          <Row label="range (param min / max)">
            <span className="flex items-center gap-xs">
              <Num value={range[0]} onChange={(v) => setRange([v, range[1]])} control="range-min" />
              <Num value={range[1]} onChange={(v) => setRange([range[0], v])} control="range-max" />
            </span>
          </Row>
          <Row label="formatValue">
            <select className={field} value={format} onChange={(e) => setFormat(e.target.value as Format)} data-control="format">
              <option value="fixed2">two decimals</option><option value="int">integer</option><option value="deg">degrees</option>
            </select>
          </Row>
          <Row label="handle slot">
            <input type="checkbox" checked={slot} onChange={(e) => setSlot(e.target.checked)} data-control="slot" />
          </Row>
          <Row label="hint">
            <input className={cn(field, 'w-[150px]')} value={hint} onChange={(e) => setHint(e.target.value)} data-control="hint" />
          </Row>
          <Row label="tooltipOpen">
            <select className={field} value={tooltip} onChange={(e) => setTooltip(e.target.value as Tri)} data-control="tooltip">
              <option value="auto">auto (hover / focus)</option><option value="true">true</option><option value="false">false</option>
            </select>
          </Row>
          <Row label="context (harness)">
            <select className={field} value={context} onChange={(e) => setContext(e.target.value as Context)} data-control="context">
              <option value="body">node body</option><option value="transform">Transform section</option><option value="stack">Stack layer</option>
            </select>
          </Row>
        </div>
      </div>
    </div>
  )
}
