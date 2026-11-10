/**
 * Section header (Transform, collapsed wires — Option A + open on drag).
 *
 * Mounts the real SectionHeader inside a node-shaped shell at the real node
 * width (212), under two real-looking param rows, with fixtures for every board
 * state (A1–A4, 1A/1B) plus 0/1/2/5 wires, a long source and all params wired.
 * Every prop has a control. Wires are drawn by the harness (SVG) from fake source
 * dots to wherever their param's handle is — the gathered dot while collapsed,
 * the row while open — so "wires return to their rows" can be checked by eye.
 *
 * The gathered handle is a static dot here: real React Flow handles only exist
 * inside a canvas node. The component takes it as a slot so this harness can
 * stand it in.
 *
 * Drag-over has two simulations, neither with a countdown:
 *  - "Simulate drag-over": sets the controlled `dropActive`; the header lights up
 *    and opens after `openDelay`.
 *  - "Wire in hand": sets `connecting`; then move the pointer onto the collapsed
 *    header — the same dwell runs off real pointer events.
 */

import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { SectionHeader, type SectionWire } from '@/components/SectionHeader'
import { FloatSlider } from '@/components/NodeParameters'
import type { NodeParameter } from '@/nodes/types'
import { ds } from '@/generated/ds'
import { cn } from '@/lib/utils'
import { getPortColor } from '@/utils/port-colors'

// ── Param sets (the framework SRT params: getSpatialParams) ──────────────────
const P = (id: string, label: string, def: number, min: number, max: number, step: number): NodeParameter =>
  ({ id, label, type: 'float', default: def, min, max, step, connectable: true, updateMode: 'uniform' })

const UNIFORM = [
  P('srt_scale', 'Scale', 1, 0, 10, 0.01),
  P('srt_rotate', 'Rotate', 0, -180, 180, 1),
  P('srt_translateX', 'Offset X', 0, -500, 500, 1),
  P('srt_translateY', 'Offset Y', 0, -500, 500, 1),
]
const SCALE_XY = [
  P('srt_scaleX', 'Scale X', 1, 0, 10, 0.01),
  P('srt_scaleY', 'Scale Y', 1, 0, 10, 0.01),
  ...UNIFORM.slice(1),
]
type ParamSet = 'uniform' | 'scaleXY'
const PARAM_SETS: Record<ParamSet, NodeParameter[]> = { uniform: UNIFORM, scaleXY: SCALE_XY }

const SOURCES = ['Noise.value', 'Time.time', 'Random.value', 'Number.value', 'LFO.value', 'Polar Coordinates.angle']
const LONG_SOURCE = 'Brightness/Contrast.luminance'

type Tri = 'auto' | 'true' | 'false'
const tri = (t: Tri): boolean | undefined => (t === 'auto' ? undefined : t === 'true')

interface Fixture {
  label: string
  open: boolean
  set: ParamSet
  wired: Record<string, string>
  dropActive?: Tri
  popoverOpen?: Tri
  openDelay?: number
}

const FIXTURES: Record<string, Fixture> = {
  a1: { label: 'A1 · collapsed, no wires', open: false, set: 'uniform', wired: {} },
  a2: { label: 'A2 · collapsed, 2 wires', open: false, set: 'uniform', wired: { srt_scale: 'Noise.value', srt_rotate: 'Time.time' } },
  a3: { label: 'A3 · hover the handle', open: false, set: 'uniform', wired: { srt_scale: 'Noise.value', srt_rotate: 'Time.time' }, popoverOpen: 'true' },
  a4: { label: 'A4 · expanded', open: true, set: 'uniform', wired: { srt_scale: 'Noise.value', srt_rotate: 'Time.time' } },
  d1a: { label: '1A · drop target (dwell held)', open: false, set: 'uniform', wired: {}, dropActive: 'true', openDelay: 3_600_000 },
  one: { label: '1 wire', open: false, set: 'uniform', wired: { srt_rotate: 'Time.time' } },
  five: { label: '5 wires (Scale X/Y)', open: false, set: 'scaleXY', wired: { srt_scaleX: 'Noise.value', srt_scaleY: 'LFO.value', srt_rotate: 'Time.time', srt_translateX: 'Random.value', srt_translateY: 'Number.value' } },
  long: { label: 'Long source name', open: false, set: 'uniform', wired: { srt_scale: LONG_SOURCE, srt_rotate: 'Time.time' }, popoverOpen: 'true' },
  all: { label: 'Every param wired', open: false, set: 'uniform', wired: { srt_scale: 'Noise.value', srt_rotate: 'Time.time', srt_translateX: 'Random.value', srt_translateY: 'Number.value' } },
}

const FLOAT = getPortColor('float')

function Dot({ connected, testId }: { connected: boolean; testId?: string }) {
  return (
    <div
      data-testid={testId}
      className={ds.handle.root}
      style={{ borderColor: FLOAT, backgroundColor: connected ? FLOAT : 'var(--surface-elevated)', width: 12, height: 12 }}
    />
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

interface Wire { id: string; from: { x: number; y: number }; to: { x: number; y: number }; source: string }

export default function SectionHeaderHarness() {
  const [fixture, setFixture] = useState('a2')
  const [label, setLabel] = useState('Transform')
  const [open, setOpen] = useState(false)
  const [set, setSet] = useState<ParamSet>('uniform')
  const [wired, setWired] = useState<Record<string, string>>(FIXTURES.a2.wired)
  const [connecting, setConnecting] = useState(false)
  const [dropActive, setDropActive] = useState<Tri>('auto')
  const [popoverOpen, setPopoverOpen] = useState<Tri>('auto')
  const [openDelay, setOpenDelay] = useState(400)
  const [slot, setSlot] = useState(true)
  const [values, setValues] = useState<Record<string, number>>({})
  const [wiresHot, setWiresHot] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const note = useCallback((s: string) => setLog((l) => [`${new Date().toISOString().slice(17, 23)}  ${s}`, ...l].slice(0, 8)), [])

  const load = (key: string) => {
    const f = FIXTURES[key]
    setFixture(key)
    setOpen(f.open)
    setSet(f.set)
    setWired(f.wired)
    setDropActive(f.dropActive ?? 'auto')
    setPopoverOpen(f.popoverOpen ?? 'auto')
    setOpenDelay(f.openDelay ?? 400)
    setConnecting(false)
    setLabel('Transform')
    setSlot(true)
    setLog([])
  }

  const params = PARAM_SETS[set]
  const wiredParams: SectionWire[] = params.filter((p) => wired[p.id]).map((p) => ({ label: p.label, source: wired[p.id] }))

  const onToggle = useCallback((next: boolean) => {
    setOpen(next)
    note(`onToggle(${next})`)
    // A finished drag: the wire is no longer over the header.
    setDropActive((d) => (d === 'true' && next ? 'auto' : d))
  }, [note])

  // ── Wires (harness-drawn) ──────────────────────────────────────────────────
  const stageRef = useRef<HTMLDivElement>(null)
  const [wires, setWires] = useState<Wire[]>([])
  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const measure = () => {
      const s = stage.getBoundingClientRect()
      const centre = (el: Element | null) => {
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.left + r.width / 2 - s.left, y: r.top + r.height / 2 - s.top }
      }
      const gather = centre(stage.querySelector('[data-gather]'))
      const ids = params.filter((p) => wired[p.id]).map((p) => p.id)
      const next: Wire[] = []
      ids.forEach((id, i) => {
        const to = open ? centre(stage.querySelector(`[data-row-dot="${id}"]`)) : gather
        if (!to) return
        next.push({ id, to, source: wired[id], from: { x: 12, y: 150 + i * 56 } })
      })
      setWires(next)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(stage)
    return () => ro.disconnect()
  }, [open, wired, params, slot, label])

  return (
    <div className="flex flex-col gap-xl p-xl bg-surface min-h-screen text-fg">
      <div className="flex flex-col gap-xs">
        <h1 className="text-node-title">Section Header</h1>
        <p className="text-param text-fg-subtle max-w-[52rem]">
          The real component in a 212px node. Collapsed with wires: one gathered dot and a count; hover the dot for
          the popover (or Tab to the header). Click the header or the dot to open. Simulate drag-over to watch the
          header light up and open after the dwell.
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
        {/* Stage: fake sources on the left, node shell on the right */}
        <div ref={stageRef} className="relative w-[340px] min-h-[460px] shrink-0" data-testid="stage">
          <svg className="absolute inset-0 w-full h-full pointer-events-none overflow-visible">
            {wires.map((w) => {
              const mx = (w.from.x + w.to.x) / 2
              return (
                <path
                  key={w.id}
                  data-wire={w.id}
                  d={`M ${w.from.x} ${w.from.y} C ${mx} ${w.from.y}, ${mx} ${w.to.y}, ${w.to.x} ${w.to.y}`}
                  fill="none"
                  stroke={FLOAT}
                  strokeWidth={!open && (wiresHot || popoverOpen === 'true') ? 2.5 : 1.5}
                />
              )
            })}
          </svg>
          {wires.map((w) => (
            <div key={w.id} className="absolute flex flex-col gap-2xs" style={{ left: 6, top: w.from.y - 6 }}>
              <Dot connected />
              <span className="text-param text-fg-muted whitespace-nowrap">{w.source}</span>
            </div>
          ))}

          {/* nodeCard.root is `relative`; the absolute placement lives on a wrapper */}
          <div className="absolute right-0 top-0">
          <div className={cn(ds.nodeCard.root, 'w-[212px]')}>
            <div className={ds.nodeCard.header}><span className={ds.nodeCard.title}>Stripes</span></div>
            <div className={ds.nodeCard.content}>
              {['Width', 'Gap'].map((l) => (
                <div key={l} className={ds.connectableParamRow.root}>
                  <span className="absolute left-0 -translate-x-1/2"><Dot connected={false} /></span>
                  <div className={ds.connectableParamRow.innerFrame}>
                    <FloatSlider param={P(l, l, 40, 0, 100, 1)} value={40} onChange={() => {}} />
                  </div>
                </div>
              ))}

              <div className={cn(ds.shaderNode.paramDivider, 'mt-xs pt-xs')}>
                <SectionHeader
                  label={label}
                  open={open}
                  onToggle={onToggle}
                  wiredParams={wiredParams}
                  connecting={connecting}
                  dropActive={tri(dropActive)}
                  openDelay={openDelay}
                  popoverOpen={tri(popoverOpen)}
                  onGatherHoverChange={(h) => { setWiresHot(h); note(`onGatherHoverChange(${h})`) }}
                  renderGatherHandle={slot ? () => <Dot connected testId="gather-dot" /> : undefined}
                  controlsId="sandbox-transform-body"
                />
                {open && (
                  <div id="sandbox-transform-body" className="flex flex-col gap-y-md pt-xs">
                    {params.map((p) => (
                      <div key={p.id} className={ds.connectableParamRow.root}>
                        <span className="absolute left-0 -translate-x-1/2" data-row-dot={p.id}>
                          <Dot connected={!!wired[p.id]} />
                        </span>
                        <div className={ds.connectableParamRow.innerFrame}>
                          {wired[p.id] ? (
                            <div className={cn(ds.nodeParameters.connectedHeader, 'py-2xs')}>
                              <span className={ds.shaderNode.connectedLabel}>{p.label}</span>
                              <span className={ds.shaderNode.connectedSource}>{'← ' + wired[p.id]}</span>
                            </div>
                          ) : (
                            <FloatSlider
                              param={p}
                              value={values[p.id] ?? (p.default as number)}
                              onChange={(v) => setValues((s) => ({ ...s, [p.id]: v as number }))}
                            />
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
          </div>
        </div>

        {/* Controls — one per prop */}
        <div className="flex flex-col gap-md w-[300px] bg-surface-alt border border-edge-subtle rounded-md p-lg" data-testid="controls">
          <span className="text-category text-fg-subtle uppercase">Props</span>
          <Row label="label">
            <input className={cn(field, 'w-[150px]')} value={label} onChange={(e) => setLabel(e.target.value)} data-control="label" />
          </Row>
          <Row label="open">
            <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} data-control="open" />
          </Row>
          <Row label="param set">
            <select className={field} value={set} onChange={(e) => { setSet(e.target.value as ParamSet); setWired({}) }} data-control="set">
              <option value="uniform">Scale · Rotate · Offset (4)</option>
              <option value="scaleXY">Scale X/Y · Rotate · Offset (5)</option>
            </select>
          </Row>
          <div className="flex flex-col gap-xs">
            <span className="text-param text-fg-dim">wiredParams ({wiredParams.length})</span>
            {params.map((p, i) => (
              <div key={p.id} className="flex items-center gap-sm text-param text-fg-dim">
                <input
                  type="checkbox"
                  checked={!!wired[p.id]}
                  data-control={`wire-${p.id}`}
                  onChange={(e) => setWired((w) => {
                    const n = { ...w }
                    if (e.target.checked) n[p.id] = SOURCES[i % SOURCES.length]
                    else delete n[p.id]
                    return n
                  })}
                />
                <span className="w-[56px]">{p.label}</span>
                {wired[p.id] && (
                  <input
                    className={cn(field, 'flex-1 min-w-0')}
                    value={wired[p.id]}
                    onChange={(e) => setWired((w) => ({ ...w, [p.id]: e.target.value }))}
                  />
                )}
              </div>
            ))}
          </div>
          <Row label="connecting (wire in hand)">
            <input type="checkbox" checked={connecting} onChange={(e) => setConnecting(e.target.checked)} data-control="connecting" />
          </Row>
          <Row label="dropActive">
            <select className={field} value={dropActive} onChange={(e) => setDropActive(e.target.value as Tri)} data-control="dropActive">
              <option value="auto">auto (pointer)</option><option value="true">true</option><option value="false">false</option>
            </select>
          </Row>
          <Row label="openDelay (ms)">
            <input
              type="number" min={0} step={50} className={cn(field, 'w-[110px]')} value={openDelay}
              onChange={(e) => setOpenDelay(Math.max(0, Number(e.target.value) || 0))} data-control="openDelay"
            />
          </Row>
          <Row label="popoverOpen">
            <select className={field} value={popoverOpen} onChange={(e) => setPopoverOpen(e.target.value as Tri)} data-control="popoverOpen">
              <option value="auto">auto (dot hover / focus)</option><option value="true">true</option><option value="false">false</option>
            </select>
          </Row>
          <Row label="renderGatherHandle slot">
            <input type="checkbox" checked={slot} onChange={(e) => setSlot(e.target.checked)} data-control="slot" />
          </Row>
          <div className="flex flex-wrap gap-sm pt-xs">
            <button
              className={chip(false)}
              data-action="simulate-drag"
              onClick={() => { setOpen(false); setDropActive('true'); note('drag-over started') }}
            >
              Simulate drag-over
            </button>
            <button className={chip(false)} data-action="end-drag" onClick={() => { setDropActive('auto'); setConnecting(false); note('drag ended') }}>
              End drag
            </button>
          </div>
          <div className="flex flex-col gap-2xs text-param text-fg-subtle pt-xs" data-testid="log">
            <span className="text-fg-dim">Callbacks (wires {wiresHot ? 'highlighted' : 'normal'})</span>
            {log.length === 0 ? <span>—</span> : log.map((l, i) => <span key={i} className="text-mono-id">{l}</span>)}
          </div>
        </div>
      </div>
    </div>
  )
}
