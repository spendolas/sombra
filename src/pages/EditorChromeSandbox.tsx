/**
 * EditorChromeSandbox — local dev harness for the floaty Nodes panel + top-left
 * control cluster prototype. View at /editor-chrome-sandbox.html on the dev
 * server. Primitives only — no React Flow / real nodes / compiler. Not shipped.
 *
 * Validates, before touching App.tsx / FlowCanvas:
 *   - Nodes toggle pill sitting LEFT of the actions pill (mirrors PreviewToolbar
 *     wrapper's two-group layout), anchored top-left of the CANVAS region.
 *   - Pinned-open floaty Nodes card: rounded, padded all sides, canvas bg shows
 *     around/under it.
 *   - When the preview is docked LEFT, the whole cluster lands to the RIGHT of
 *     the preview — because it's anchored to the canvas region, not the window.
 */

import { useState } from 'react'
import { IconButton } from '@/components/IconButton'
import { ds } from '@/generated/ds'
import { cn } from '@/lib/utils'

// ── Dummy palette data (stands in for nodeRegistry categories) ──────────────
const CATEGORIES: Array<{ name: string; items: string[] }> = [
  { name: 'Sources', items: ['Gradient', 'Image', 'Noise', 'Shape'] },
  { name: 'Math', items: ['Add', 'Multiply', 'Mix', 'Clamp'] },
  { name: 'Effects', items: ['Blur', 'Pixelate', 'Dither', 'Frost'] },
  { name: 'Color', items: ['Hue Shift', 'Levels', 'Invert'] },
]

const DOT_GRID: React.CSSProperties = {
  backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.05) 1px, transparent 1px)',
  backgroundSize: '22px 22px',
}

// ── Fake node on the canvas — lets us eyeball overlay vs. the panel ─────────
function NodeChip({ title, className }: { title: string; className?: string }) {
  return (
    <div className={cn('absolute w-[132px] rounded-md bg-surface-raised border border-edge shadow-lg overflow-hidden', className)}>
      <div className="px-md py-xs text-category-meta text-fg-dim bg-surface-elevated border-b border-edge-subtle">{title}</div>
      <div className="flex flex-col gap-1.5 p-md">
        <div className="h-1.5 w-full rounded-full bg-surface-elevated" />
        <div className="h-1.5 w-2/3 rounded-full bg-surface-elevated" />
      </div>
    </div>
  )
}

// ── The floaty Nodes card (the thing under review) ──────────────────────────
function NodesCard() {
  return (
    <div className="w-[212px] max-h-full bg-surface-raised rounded-xl border border-edge-card shadow-2xl p-lg flex flex-col gap-lg overflow-hidden">
      <div className="shrink-0 flex items-center gap-xs pb-md border-b border-edge-subtle">
        <span className="text-category text-fg-subtle uppercase tracking-wider">Nodes</span>
      </div>
      <div className="flex flex-col gap-lg overflow-y-auto min-h-0">
        {CATEGORIES.map((cat) => (
          <div key={cat.name} className="flex flex-col gap-xs">
            <h3 className={ds.categoryHeader.root}>{cat.name}</h3>
            <div className={ds.nodePalette.itemList}>
              {cat.items.map((item) => (
                <div key={item} className={cn(ds.paletteItem.root, 'rounded-sm')} title={`Drag ${item} onto the canvas`}>
                  {item}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Segmented control (borrowed from ColorPickerSandbox) ────────────────────
function Seg({ value, options, onChange }: { value: string; options: Array<{ v: string; label: string }>; onChange: (v: string) => void }) {
  return (
    <div className="inline-flex bg-surface-alt border border-edge rounded-md p-0.5">
      {options.map((o) => (
        <button key={o.v} type="button" onClick={() => onChange(o.v)}
          className={`text-[12px] px-3 py-1.5 rounded-sm cursor-pointer transition-colors ${value === o.v ? 'bg-indigo text-white' : 'text-fg-subtle hover:text-fg-dim'}`}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ── The editor-chrome mock: a canvas region with the top-left cluster ───────
function CanvasRegion({ nodesOpen, onToggleNodes }: { nodesOpen: boolean; onToggleNodes: () => void }) {
  return (
    <div className="relative h-full w-full bg-surface overflow-hidden" style={DOT_GRID}>
      {/* Fake nodes living on the canvas (so overlay behaviour is visible).
          The first sits under where the card floats — proving nodes/canvas stay
          BELOW the panel (the card occludes it). */}
      <NodeChip title="Gradient" className="top-[26%] left-[3%]" />
      <NodeChip title="Blur" className="top-[58%] left-[34%]" />
      <NodeChip title="Output" className="top-[38%] left-[62%]" />

      {/* Top-left control cluster — anchored to the CANVAS region, not the window.
          Full-bleed overlay (pointer-events-none) so the canvas stays clickable
          around it; only the pills + card capture events. p-xl gives the inset
          on every side, so the card floats with padding all round. */}
      <div className="absolute inset-0 p-xl flex flex-col gap-md items-start z-10 pointer-events-none">
        <div className={cn(ds.previewToolbar.wrapper, 'pointer-events-auto')}>
          {/* Nodes toggle pill (its own group, LEFT of actions) */}
          <div className={ds.previewToolbar.root}>
            <IconButton
              icon="squareMousePointer"
              title="Toggle nodes panel"
              className={nodesOpen ? ds.button.ghostActive : ds.button.ghost}
              onClick={onToggleNodes}
            />
          </div>
          {/* Main actions pill (dummy — mirrors GraphToolbar) */}
          <div className={ds.graphToolbar.root}>
            <IconButton icon="download" title="Save" className={ds.button.ghost} />
            <IconButton icon="folderOpen" title="Open" className={ds.button.ghost} />
            <IconButton icon="share" title="Share" className={ds.button.ghost} />
            <IconButton icon="code" title="Embed" className={ds.button.ghost} />
            <IconButton icon="film" title="Export" className={ds.button.ghost} />
          </div>
        </div>

        {/* Floaty Nodes card — pinned open, canvas bg shows around/under it.
            min-h-0 lets it shrink; the card scrolls internally past the fold. */}
        {nodesOpen && (
          <div className="pointer-events-auto min-h-0 flex">
            <NodesCard />
          </div>
        )}
      </div>
    </div>
  )
}

export function EditorChromeSandbox() {
  const [nodesOpen, setNodesOpen] = useState(true)
  const [previewDock, setPreviewDock] = useState<'none' | 'left' | 'right'>('none')

  const preview = (
    <div className="h-full w-full bg-black/40 border border-edge-subtle flex items-center justify-center">
      <span className="text-fg-muted text-[12px] tracking-wider uppercase">Preview</span>
    </div>
  )
  const canvas = <CanvasRegion nodesOpen={nodesOpen} onToggleNodes={() => setNodesOpen((v) => !v)} />

  return (
    <div className="h-screen flex flex-col bg-surface text-fg" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>
      {/* Harness header */}
      <div className="shrink-0 px-2xl py-lg border-b border-edge-subtle">
        <p className="text-[11px] tracking-[0.14em] uppercase text-fg-muted font-semibold mb-1">Sombra · Design Sandbox</p>
        <div className="flex items-center justify-between gap-xl flex-wrap">
          <h1 className="text-[22px] font-semibold tracking-tight m-0">
            Editor Chrome
            <span className="ml-2 align-middle text-[10px] tracking-wider uppercase font-bold text-indigo-hover border border-indigo px-1.5 py-0.5 rounded-full">Prototype</span>
          </h1>
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] text-fg-subtle">Preview dock (proves the cluster follows the canvas region)</span>
            <Seg
              value={previewDock}
              onChange={(v) => setPreviewDock(v as 'none' | 'left' | 'right')}
              options={[{ v: 'none', label: 'No preview' }, { v: 'left', label: 'Dock left' }, { v: 'right', label: 'Dock right' }]}
            />
          </label>
        </div>
        <p className="text-fg-subtle mt-2 max-w-[80ch] text-[13px]">
          The Nodes pill sits left of the actions pill and is anchored to the <em>canvas</em> region. Dock the preview left and the whole cluster lands to its right. The floaty card is pinned open (click the pointer icon to toggle) and overlays the canvas — the dot-grid shows around and under it. Fake nodes sit on the canvas so you can judge the overlay.
        </p>
      </div>

      {/* Editor active area */}
      <div className="flex-1 min-h-0 p-lg">
        <div className="h-full w-full rounded-lg overflow-hidden border border-edge flex">
          {previewDock === 'left' && <div className="w-2/5 shrink-0 min-w-0">{preview}</div>}
          <div className="flex-1 min-w-0">{canvas}</div>
          {previewDock === 'right' && <div className="w-2/5 shrink-0 min-w-0">{preview}</div>}
        </div>
      </div>
    </div>
  )
}
