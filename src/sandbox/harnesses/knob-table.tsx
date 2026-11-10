/**
 * Knob table.
 *
 * Mounts the real KnobTable on the Embed modal's own surface at the modal's
 * content width (680 inside a 720 modal), with a fixture for every state on
 * the Figma board "Embed modal — knob table" (993:3778): the 13-knob site
 * scene, the name clash, no knobs, plus a translucent palette (alpha shows the
 * checkerboard), every knob type, a very long key, and 60 rows to prove the
 * scroll and the fixed header.
 *
 * URL parameters set the initial state so the browser gate can drive the same
 * harness a person reviews: ?fixture=<key>&copy=<clipboard|log|fail>&copiedMs=<n>
 * &notice=0|1&footnote=0|1&width=<px>. In "log" mode every copied key is pushed
 * onto window.__knobCopies.
 */

import { useState } from 'react'
import { KnobTable, COPIED_MS, type KnobTableItem } from '@/components/KnobTable'
import { cn } from '@/lib/utils'

const hex = (h: string, a = 1): number[] => {
  const n = parseInt(h.replace('#', ''), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a]
}
const f = (key: string, d: number, min?: number, max?: number, named = false): KnobTableItem =>
  ({ key, type: 'float', default: d, min, max, named })
const c = (key: string, h: string, a = 1, named = false): KnobTableItem =>
  ({ key, type: 'color', default: hex(h, a), named })

// The site scene from the board (B · With knob table), in graph order. Named
// knobs carry named: true; the component sorts them first. Graph order is
// deliberately interleaved here so the sort has something to do.
const SITE: KnobTableItem[] = [
  f('site-clock-speed', 0.05, 0, 2, true),
  f('pixelate-pixel-size', 64, 2, 256),
  f('site-seed-value', 123, -10, 10, true),
  f('site-balance-value', 0, -10, 10, true),
  f('fbm-octaves', 4, 1, 8),
  f('site-dots-pixel-size', 8, 2, 64, true),
  c('site-palette-stop-0', '#160709', 1, true),
  c('site-palette-stop-1', '#F2B33D', 1, true),
  c('site-palette-stop-2', '#4FC3C9', 1, true),
  c('site-palette-stop-3', '#E8638F', 1, true),
  f('fbm-lacunarity', 2, 1, 4),
  f('fragment-output-alpha', 1, 0, 1, true),
  f('fbm-gain', 0.5, 0.1, 0.9),
]

const CLASH_NOTICE =
  'Two nodes are named “site.balance”. The second one publishes as site-balance-value-2. ' +
  'Rename one of them so each key stays the one you meant.'

const withClash = (() => {
  const out = [...SITE]
  const i = out.findIndex((k) => k.key === 'site-balance-value')
  out.splice(i + 1, 0, { ...f('site-balance-value-2', 0.25, -10, 10, true), clash: true })
  return out
})()

const SIXTY: KnobTableItem[] = Array.from({ length: 60 }, (_, i) =>
  i < 6
    ? f(`site-knob-${i}`, i * 0.5, 0, 10, true)
    : f(`noise-${i - 5}-scale`, 1 + (i % 7) * 0.25, 0, 20),
)

const FIXTURES: Record<string, { label: string; knobs: KnobTableItem[]; notice?: string }> = {
  site: { label: 'Site scene (13)', knobs: SITE },
  clash: { label: 'Name clash', knobs: withClash, notice: CLASH_NOTICE },
  empty: { label: 'No knobs', knobs: [] },
  translucent: { label: 'Translucent colours', knobs: [
    c('site-tint', '#E8638F', 0.5, true),
    c('site-glass', '#4FC3C9', 0.25, true),
    c('site-solid', '#F2B33D', 1, true),
    c('gradient-stop-1', '#160709', 0),
  ] },
  types: { label: 'Every type', knobs: [
    f('site-speed', -0.125, -1, 1, true),
    { key: 'transform-offset', type: 'vec2', default: [0.5, -0.25] },
    { key: 'light-direction', type: 'vec3', default: [0, 1, 0.3333333] },
    c('color-constant-color', '#4FC3C9'),
    f('noise-scale', 3),
  ] },
  longKey: { label: 'Very long key', knobs: [
    f('site-hero-background-gradient-secondary-palette-stop-position-offset-2', 0.75, 0, 1, true),
    f('site-clock-speed', 0.05, 0, 2, true),
    { ...f('site-hero-background-gradient-secondary-palette-stop-position-offset-3', 0.8, 0, 1, true), clash: true },
    f('polar-coordinates-2-radial-distortion-strength', 1.5, 0, 4),
  ] },
  allAuto: { label: 'Nothing named', knobs: SITE.map((k) => ({ ...k, named: false })) },
  sixty: { label: '60 rows', knobs: SIXTY },
}

const FOOTNOTE = 'Named nodes come first and keep their key in every scene. Double-click a node’s title to name it.'
const WIDTHS = [680, 480, 360]
type CopyMode = 'clipboard' | 'log' | 'fail'

declare global {
  interface Window { __knobCopies?: string[] }
}

const params = new URLSearchParams(location.search)
const initialFixture = params.get('fixture') && FIXTURES[params.get('fixture')!] ? params.get('fixture')! : 'site'

export default function KnobTableHarness() {
  const [fixture, setFixture] = useState(initialFixture)
  const [copyMode, setCopyMode] = useState<CopyMode>((params.get('copy') as CopyMode) ?? 'clipboard')
  const [copiedMs, setCopiedMs] = useState(Number(params.get('copiedMs') ?? COPIED_MS))
  const [showNotice, setShowNotice] = useState(params.get('notice') === '1' || (params.get('notice') !== '0' && !!FIXTURES[initialFixture].notice))
  const [noticeText, setNoticeText] = useState(FIXTURES[initialFixture].notice ?? CLASH_NOTICE)
  const [showFootnote, setShowFootnote] = useState(params.get('footnote') !== '0')
  const [width, setWidth] = useState(Number(params.get('width') ?? 680))
  const [log, setLog] = useState<string[]>([])

  const fx = FIXTURES[fixture]
  const load = (key: string) => {
    setFixture(key)
    setShowNotice(!!FIXTURES[key].notice)
    if (FIXTURES[key].notice) setNoticeText(FIXTURES[key].notice!)
  }

  const onCopy =
    copyMode === 'clipboard' ? undefined
    : copyMode === 'fail' ? (key: string) => { setLog((l) => [`refused ${key}`, ...l].slice(0, 6)); return Promise.reject(new Error('refused')) }
    : (key: string) => {
        ;(window.__knobCopies ??= []).push(key)
        setLog((l) => [`copied ${key}`, ...l].slice(0, 6))
      }

  const chip = (active: boolean) =>
    cn('text-param px-md py-xs rounded-sm border border-edge cursor-pointer', active ? 'bg-surface-elevated text-fg' : 'bg-surface-alt text-fg-dim')

  return (
    <div className="flex flex-col gap-xl p-xl bg-surface h-screen overflow-y-auto text-fg">
      <div className="flex flex-col gap-sm">
        <h1 className="text-node-title">Knob Table</h1>
        <p className="text-param text-fg-subtle max-w-[46rem]">
          The real component on the Embed modal&apos;s surface. Hover a row for the copy icon; click to copy its key.
          Named knobs list first, then a divider, then the auto-named rest. Past about eleven rows the body scrolls under the header.
        </p>
        <div className="flex flex-wrap gap-sm" data-harness="fixtures">
          {Object.entries(FIXTURES).map(([key, x]) => (
            <button key={key} onClick={() => load(key)} className={chip(key === fixture)}>{x.label}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-sm text-param text-fg-dim">
          <span>onCopy</span>
          {(['log', 'clipboard', 'fail'] as const).map((m) => (
            <button key={m} onClick={() => setCopyMode(m)} className={chip(m === copyMode)}>
              {m === 'log' ? 'harness log' : m === 'clipboard' ? 'default (clipboard)' : 'refused'}
            </button>
          ))}
          <span className="ml-md">copied for</span>
          <input
            type="number" min={100} step={100} value={copiedMs}
            onChange={(e) => setCopiedMs(Math.max(100, Number(e.target.value) || COPIED_MS))}
            className="w-[72px] bg-surface-raised border border-edge rounded-sm px-sm py-2xs text-fg"
          />
          <span>ms</span>
          <span className="ml-md">width</span>
          {WIDTHS.map((w) => (
            <button key={w} onClick={() => setWidth(w)} className={chip(w === width)}>{w}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-sm text-param text-fg-dim">
          <label className="flex items-center gap-xs cursor-pointer">
            <input type="checkbox" checked={showNotice} onChange={(e) => setShowNotice(e.target.checked)} /> notice
          </label>
          <input
            value={noticeText} onChange={(e) => setNoticeText(e.target.value)}
            className="flex-1 min-w-[240px] bg-surface-raised border border-edge rounded-sm px-sm py-2xs text-fg"
          />
          <label className="flex items-center gap-xs cursor-pointer">
            <input type="checkbox" checked={showFootnote} onChange={(e) => setShowFootnote(e.target.checked)} /> footnote
          </label>
        </div>
      </div>

      <div className="flex gap-xl items-start">
        {/* The Embed modal's surface; the table fills the modal's content column. */}
        <div className="bg-surface-alt rounded-lg p-xl shrink-0" style={{ width: width + 32 }}>
          <div className="text-body text-fg-dim">Control it from JavaScript (optional — same embed)</div>
          <KnobTable
            key={fixture}
            knobs={fx.knobs}
            onCopy={onCopy}
            notice={showNotice ? noticeText : undefined}
            footnote={showFootnote ? FOOTNOTE : undefined}
            copiedMs={copiedMs}
          />
        </div>
        <div className="flex flex-col gap-xs text-param text-fg-subtle">
          <span className="text-fg-dim">Last actions</span>
          {log.length === 0 ? <span>—</span> : log.map((l, i) => <span key={i}>{l}</span>)}
        </div>
      </div>
    </div>
  )
}
