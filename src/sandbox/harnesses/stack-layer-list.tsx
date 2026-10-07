/**
 * Stack layer list.
 *
 * Mounts the real StackLayerList inside a node-shaped shell at the real node
 * width (212), with fixtures for every state the Figma boards cover: rest,
 * hidden middle, hidden bottom (greying by effect), a single layer, empty, and
 * a source label long enough to truncate. Every handler is live, so add / remove / hide
 * / reorder / blend / opacity all work and can be checked against the design.
 *
 * Handles are static dots here — real React Flow handles only exist inside a
 * canvas node, and the Stack node definition does not exist yet. The component
 * takes them as a slot precisely so this harness can stand them in.
 */

import { useCallback, useState } from 'react'
import { StackLayerList, type StackLayerItem, type StackPort } from '@/components/StackLayerList'
import { ds } from '@/generated/ds'
import { cn } from '@/lib/utils'
import { getPortColor } from '@/utils/port-colors'

const BLEND_MODES = [
  'Normal', 'Darken', 'Multiply', 'Colour Burn', 'Linear Burn', 'Lighten', 'Screen', 'Colour Dodge',
  'Linear Dodge (Add)', 'Overlay', 'Soft Light', 'Hard Light', 'Vivid Light', 'Linear Light', 'Pin Light',
  'Hard Mix', 'Difference', 'Exclusion', 'Subtract', 'Divide', 'Hue', 'Saturation', 'Colour', 'Luminosity',
].map((label) => ({ value: label.toLowerCase().replace(/[^a-z]+/g, '-'), label }))

const L = (id: string, over: Partial<StackLayerItem>): StackLayerItem =>
  ({ id, name: `Layer ${id}`, blendMode: 'normal', opacity: 1, visible: true, ...over })

const FIXTURES: Record<string, { label: string; layers: StackLayerItem[] }> = {
  rest: { label: 'Three layers', layers: [
    L('3', { blendMode: 'screen', opacity: 0.8, source: 'Gradient.color' }),
    L('2', { blendMode: 'multiply', opacity: 0.65, source: 'Checkerboard.color', maskSource: 'Noise.value' }),
    L('1', { source: 'Image.color' }),
  ] },
  hiddenMiddle: { label: 'Middle layer hidden', layers: [
    L('3', { blendMode: 'screen', opacity: 0.8, source: 'Gradient.color' }),
    L('2', { blendMode: 'multiply', opacity: 0.65, source: 'Checkerboard.color', visible: false }),
    L('1', { source: 'Image.color' }),
  ] },
  hiddenBottom: { label: 'Bottom layer hidden (Layer 2 greys too)', layers: [
    L('3', { blendMode: 'screen', opacity: 0.8, source: 'Gradient.color' }),
    L('2', { blendMode: 'multiply', opacity: 0.65, source: 'Checkerboard.color' }),
    L('1', { source: 'Image.color', visible: false }),
  ] },
  wired: { label: 'Opacity and mask wired', layers: [
    L('2', { blendMode: 'overlay', source: 'Gradient.color', opacitySource: 'LFO.value', maskSource: 'Noise.value' }),
    L('1', { source: 'Image.color' }),
  ] },
  // Layer names are always "Layer N" — there is no rename. What can run long is the
  // SOURCE: the wired node's own label plus its output. Brightness/Contrast is the
  // longest node label in the library.
  longSource: { label: 'Long source (truncates, full on hover)', layers: [
    L('2', { source: 'Brightness/Contrast.color', maskSource: 'Polar Coordinates.color' }),
    L('1', { source: 'Image.color' }),
  ] },
  single: { label: 'One layer', layers: [L('1', { source: 'Image.color' })] },
  newLayer: { label: 'Fresh layer, nothing wired', layers: [L('2', {}), L('1', { source: 'Image.color' })] },
  empty: { label: 'Empty', layers: [] },
}

function Dot({ port, connected }: { port: StackPort; connected: boolean }) {
  const color = getPortColor(port === 'opacity' ? 'float' : 'color')
  return (
    <div
      className={ds.handle.root}
      style={{ borderColor: color, backgroundColor: connected ? color : 'var(--surface-elevated)', width: 12, height: 12 }}
    />
  )
}

export default function StackLayerListHarness() {
  const [fixture, setFixture] = useState('rest')
  const [layers, setLayers] = useState<StackLayerItem[]>(FIXTURES.rest.layers)
  const [nextId, setNextId] = useState(4)
  const [log, setLog] = useState<string[]>([])
  const note = (s: string) => setLog((l) => [s, ...l].slice(0, 6))

  const load = (key: string) => {
    setFixture(key)
    setLayers(FIXTURES[key].layers)
    setNextId(FIXTURES[key].layers.reduce((m, l) => Math.max(m, Number(l.id) || 0), 0) + 1)
  }

  const update = (id: string, patch: Partial<StackLayerItem>) =>
    setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)))

  const onReorder = useCallback((from: number, to: number) => {
    setLayers((ls) => { const next = [...ls]; const [m] = next.splice(from, 1); next.splice(to, 0, m); return next })
    note(`reorder ${from} → ${to}`)
  }, [])

  return (
    <div className="flex flex-col gap-xl p-xl bg-surface min-h-screen text-fg">
      <div className="flex flex-col gap-xs">
        <h1 className="text-node-title">Stack Layer List</h1>
        <p className="text-param text-fg-subtle max-w-[46rem]">
          The real component at node width. Hover a layer for its remove button, drag the grip to reorder,
          click the eye to hide. A layer&apos;s blend greys when nothing visible sits below it.
        </p>
        <div className="flex flex-wrap gap-sm">
          {Object.entries(FIXTURES).map(([key, f]) => (
            <button
              key={key}
              onClick={() => load(key)}
              className={cn(
                'text-param px-md py-xs rounded-sm border border-edge cursor-pointer',
                key === fixture ? 'bg-surface-elevated text-fg' : 'bg-surface-alt text-fg-dim',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-xl items-start">
        {/* Node-shaped shell, real width */}
        <div className={cn(ds.nodeCard.root, 'w-[212px]')}>
          <div className={ds.nodeCard.header}><span className={ds.nodeCard.title}>Stack</span></div>
          <div className={ds.nodeCard.content}>
            <StackLayerList
              layers={layers}
              blendModes={BLEND_MODES}
              onAdd={() => {
                setLayers((ls) => [L(String(nextId), {}), ...ls])
                setNextId((n) => n + 1)
                note(`add Layer ${nextId}`)
              }}
              onRemove={(id) => { setLayers((ls) => ls.filter((l) => l.id !== id)); note(`remove ${id}`) }}
              onToggleVisible={(id) => { setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l))); note(`toggle ${id}`) }}
              onBlendChange={(id, blendMode) => { update(id, { blendMode }); note(`blend ${id} = ${blendMode}`) }}
              onOpacityChange={(id, opacity) => update(id, { opacity })}
              onReorder={onReorder}
              renderHandle={({ port, connected }) => <Dot port={port} connected={connected} />}
            />
          </div>
        </div>

        <div className="flex flex-col gap-xs text-param text-fg-subtle">
          <span className="text-fg-dim">Last actions</span>
          {log.length === 0 ? <span>—</span> : log.map((l, i) => <span key={i}>{l}</span>)}
        </div>
      </div>
    </div>
  )
}
