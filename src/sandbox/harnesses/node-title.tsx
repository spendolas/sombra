/**
 * Node title — inline rename.
 *
 * Mounts the real NodeTitle in two places:
 *
 * 1. A LIVE node on a real React Flow canvas, built exactly like ShaderNode's
 *    header (BaseNode min-w-node → BaseNodeHeader → title). The canvas is real so
 *    the things that matter can be checked by hand and by the gate: dragging from
 *    the field must not move the node, double-clicking the title must not zoom,
 *    Backspace in the field must not reach a delete handler. Controls drive every
 *    prop; fixtures set up each Figma board state (some then enter edit mode and
 *    pre-type, waiting for you to press Enter / Esc / click away).
 * 2. A gallery of the board's rest states (A–G) side by side, each live.
 *
 * The "canvas delete key" listener below is deliberately naive — it does NOT
 * skip inputs, the way a careless global shortcut would. The field must stop
 * Backspace/Delete before it gets there.
 *
 * Board: https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=993-3781
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Position,
  applyNodeChanges,
  type Node,
  type NodeChange,
  type NodeProps,
  type Viewport,
} from '@xyflow/react'
import { NodeTitle } from '@/components/NodeTitle'
import { BaseNode, BaseNodeContent, BaseNodeHeader } from '@/components/base-node'
import { LabeledHandle } from '@/components/labeled-handle'
import { cn } from '@/lib/utils'
import { getPortColor } from '@/utils/port-colors'

const LONG_NAME = 'site.hero.background.gradient.balance.value.mixed.primary.layer' // 63 chars
const TYPE_LABELS = ['Number', 'Gradient', 'Brightness/Contrast', 'Polar Coordinates']

type Script = 'edit' | 'clear' | 'typeHue'
interface Fixture { label: string; hint: string; title: string; customName?: string; duplicate?: boolean; script?: Script }

const FIXTURES: Record<string, Fixture> = {
  default: { label: 'A · Default', hint: 'No custom name: the type label, exactly as today.', title: 'Number' },
  hover: { label: 'B · Hover', hint: 'Hover the title: the pencil fades in at the right end.', title: 'Number' },
  editing: { label: 'C · Editing', hint: 'Field in place, whole text selected. Type to replace.', title: 'Number', script: 'edit' },
  custom: { label: 'D · Custom name', hint: 'Name in the title, type as a dim tag on the right.', title: 'Number', customName: 'site.balance' },
  long: { label: 'E · Long name (63)', hint: 'Truncates with an ellipsis; hover for the full name.', title: 'Number', customName: LONG_NAME },
  emptyClear: { label: 'F · Empty → clear', hint: 'Field emptied (type shows as placeholder). Press Enter: back to the type.', title: 'Number', customName: 'site.balance', script: 'clear' },
  escCancel: { label: 'F · Esc → kept', hint: 'Typed "site.hue". Press Esc: the old name stays.', title: 'Number', customName: 'site.balance', script: 'typeHue' },
  clickAway: { label: 'F · Click away → saved', hint: 'Typed "site.hue". Click anywhere else: saved, same as Enter.', title: 'Number', customName: 'site.balance', script: 'typeHue' },
  duplicate: { label: 'G · Duplicate', hint: 'Amber sign by the type tag; hover it for the explanation.', title: 'Number', customName: 'site.balance', duplicate: true },
}

// ── Harness event log, also readable by the browser gate ────────────────────

interface HarnessLog { renames: Array<string | null>; events: string[]; viewport?: Viewport }
declare global { interface Window { __nodeTitleHarness?: HarnessLog } }

function setInputValue(el: HTMLInputElement, value: string) {
  // React tracks the value property; go through the native setter so onChange fires.
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

// ── Node shell: the same structure ShaderNode renders ───────────────────────

interface TitleState { title: string; customName?: string; duplicate: boolean; onRename: (n: string | undefined) => void }
const LiveTitleContext = createContext<TitleState | null>(null)

function TitleNode(_: NodeProps) {
  const t = useContext(LiveTitleContext)!
  return (
    <BaseNode className="min-w-node" data-testid="live-node">
      <BaseNodeHeader>
        <NodeTitle title={t.title} customName={t.customName} duplicate={t.duplicate} onRename={t.onRename} />
      </BaseNodeHeader>
      <BaseNodeContent>
        <LabeledHandle type="source" position={Position.Right} id="value" title="Value" handleColor={getPortColor('float')} />
      </BaseNodeContent>
    </BaseNode>
  )
}
const nodeTypes = { title: TitleNode }
const START_NODES: Node[] = [{ id: 'live', type: 'title', position: { x: 40, y: 40 }, data: {} }]

/** Rest-state shell outside React Flow (no handles there) — for the gallery. */
function GalleryNode({ fixture }: { fixture: Fixture }) {
  const [customName, setCustomName] = useState(fixture.customName)
  return (
    <div className="flex flex-col gap-sm">
      <span className="text-param text-fg-subtle">{fixture.label}</span>
      <BaseNode className="min-w-node w-fit">
        <BaseNodeHeader>
          <NodeTitle title={fixture.title} customName={customName} duplicate={fixture.duplicate} onRename={setCustomName} />
        </BaseNodeHeader>
        <BaseNodeContent>
          <span className="text-handle text-fg-dim text-right">Value</span>
        </BaseNodeContent>
      </BaseNode>
    </div>
  )
}

export default function NodeTitleHarness() {
  const [fixtureKey, setFixtureKey] = useState('default')
  const [loadTick, setLoadTick] = useState(0)
  const [title, setTitle] = useState('Number')
  const [customName, setCustomName] = useState<string | undefined>(undefined)
  const [duplicate, setDuplicate] = useState(false)
  const [nodes, setNodes] = useState<Node[]>(START_NODES)
  const [log, setLog] = useState<string[]>([])
  const harness = useRef<HarnessLog>({ renames: [], events: [] })
  const pendingScript = useRef<Script | undefined>(undefined)
  const canvasRef = useRef<HTMLDivElement>(null)

  const note = useCallback((s: string) => {
    harness.current.events.push(s)
    setLog((l) => [s, ...l].slice(0, 10))
  }, [])

  useEffect(() => { window.__nodeTitleHarness = harness.current }, [])

  const onRename = useCallback((n: string | undefined) => {
    harness.current.renames.push(n ?? null)
    note(n === undefined ? 'onRename(undefined) — custom name cleared' : `onRename("${n}")`)
    setCustomName(n)
  }, [note])

  // A deliberately naive global delete shortcut: it does not skip inputs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Backspace' || e.key === 'Delete') note(`canvas delete key reached (${e.key})`)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [note])

  const load = (key: string) => {
    const f = FIXTURES[key]
    setFixtureKey(key)
    setTitle(f.title)
    setCustomName(f.customName)
    setDuplicate(!!f.duplicate)
    setNodes(START_NODES)
    pendingScript.current = f.script
    setLoadTick((t) => t + 1)
  }

  // Fixture scripts: enter edit mode the way a person would (double-click the
  // title), then pre-type, after the fixture's props have rendered.
  useEffect(() => {
    const script = pendingScript.current
    if (!script) return
    pendingScript.current = undefined
    const root = canvasRef.current
    const name = root?.querySelector<HTMLElement>('[data-slot="node-title-name"]')
    if (!name) return
    name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    requestAnimationFrame(() => {
      const input = root?.querySelector<HTMLInputElement>('[data-slot="node-title-input"]')
      if (!input) return
      if (script === 'clear') setInputValue(input, '')
      if (script === 'typeHue') setInputValue(input, 'site.hue')
    })
  }, [loadTick])

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    for (const c of changes) if (c.type === 'remove') note(`node deleted by React Flow`)
    setNodes((ns) => applyNodeChanges(changes, ns))
  }, [note])

  const titleState = useMemo<TitleState>(() => ({ title, customName, duplicate, onRename }), [title, customName, duplicate, onRename])
  const fixture = FIXTURES[fixtureKey]

  return (
    <div className="flex flex-col gap-xl p-xl bg-surface min-h-screen text-fg">
      <div className="flex flex-col gap-xs">
        <h1 className="text-node-title">Node Title — inline rename</h1>
        <p className="text-param text-fg-subtle max-w-[46rem]">
          The real NodeTitle in a real node on a real canvas. Hover the title for the pencil; click it or
          double-click the title to rename. Enter or click away saves, Esc cancels, empty clears.
        </p>
        <div className="flex flex-wrap gap-sm">
          {Object.entries(FIXTURES).map(([key, f]) => (
            <button
              key={key}
              data-fixture={key}
              onClick={() => load(key)}
              className={cn(
                'text-param px-md py-xs rounded-sm border border-edge cursor-pointer',
                key === fixtureKey ? 'bg-surface-elevated text-fg' : 'bg-surface-alt text-fg-dim',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <p className="text-param text-fg-dim" data-testid="fixture-hint">{fixture.hint}</p>
      </div>

      <div className="flex gap-xl items-start flex-wrap">
        {/* Live canvas */}
        <div ref={canvasRef} data-testid="canvas" className="w-[360px] h-[200px] rounded-md border border-edge overflow-hidden">
          <LiveTitleContext.Provider value={titleState}>
            <ReactFlowProvider>
              <ReactFlow
                nodes={nodes}
                edges={[]}
                nodeTypes={nodeTypes}
                onNodesChange={onNodesChange}
                onNodeDoubleClick={() => note('node double-click handler reached')}
                onMove={(_, vp) => { harness.current.viewport = vp }}
                defaultViewport={{ x: 0, y: 0, zoom: 1 }}
                proOptions={{ hideAttribution: true }}
                style={{ backgroundColor: 'var(--surface)' }}
              />
            </ReactFlowProvider>
          </LiveTitleContext.Provider>
        </div>

        {/* Controls — one per prop */}
        <div className="flex flex-col gap-md text-param text-fg-dim w-[240px]">
          <label className="flex flex-col gap-xs">
            <span>title (type label)</span>
            <select
              data-control="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="bg-surface-raised border border-edge rounded-sm px-sm py-xs text-fg"
            >
              {TYPE_LABELS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-xs">
            <span>customName (empty = none)</span>
            <input
              data-control="customName"
              value={customName ?? ''}
              onChange={(e) => setCustomName(e.target.value || undefined)}
              className="bg-surface-raised border border-edge rounded-sm px-sm py-xs text-fg"
            />
          </label>
          <label className="flex items-center gap-sm">
            <input data-control="duplicate" type="checkbox" checked={duplicate} onChange={(e) => setDuplicate(e.target.checked)} />
            <span>duplicate</span>
          </label>
          <button
            onClick={() => { setNodes(START_NODES); note('canvas reset') }}
            className="text-param px-md py-xs rounded-sm border border-edge bg-surface-alt text-fg-dim cursor-pointer w-fit"
          >
            Reset canvas
          </button>
        </div>

        {/* Log */}
        <div className="flex flex-col gap-xs text-param text-fg-subtle min-w-[200px]" data-testid="log">
          <span className="text-fg-dim">Events (onRename, canvas handlers)</span>
          {log.length === 0 ? <span>—</span> : log.map((l, i) => <span key={i}>{l}</span>)}
        </div>
      </div>

      <div className="flex flex-col gap-md">
        <h2 className="text-section text-fg-subtle uppercase">Board states (each live)</h2>
        <div className="flex gap-xl flex-wrap items-start">
          {(['default', 'custom', 'long', 'duplicate'] as const).map((k) => (
            <GalleryNode key={k} fixture={FIXTURES[k]} />
          ))}
          <GalleryNode fixture={{ ...FIXTURES.custom, label: 'Long type label', title: 'Brightness/Contrast', customName: 'site.contrast' }} />
        </div>
      </div>
    </div>
  )
}
