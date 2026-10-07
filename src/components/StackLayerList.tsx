/**
 * StackLayerList — the layer list inside a Stack node's body.
 *
 * Presentational: it owns hover and drag interaction state only; the layer data
 * and every change go through props. Designed in Figma first (Components page,
 * Molecules row "Stack": Stack Layer 982:5693, Stack Empty 982:5702, Stack Drop
 * Slot 982:5703) and styled entirely from `ds.stackLayer` / `ds.stackEmpty` /
 * `ds.stackDropSlot`, plus the existing select, slider, labelled-handle and icon
 * button pieces it reuses.
 *
 * Handles are a slot (`renderHandle`), not built in: the node passes real React
 * Flow handles, the sandbox passes static dots. Either way each handle is centred
 * on the content edge of its line, as in every other node.
 *
 * Rules the design settled, enforced here:
 *  - Top of the list is the topmost layer (Photoshop order).
 *  - A layer's blend mode is greyed when nothing VISIBLE sits below it — the
 *    blend then has nothing to act on, mathematically a no-op.
 *  - A hidden layer stays editable; its content dims and its card sinks.
 *  - Removing the last layer is allowed; the list then shows the add-layer hole.
 *  - Reorder is a pointer-driven drag on the grip: captured pointer + window
 *    listeners, so pen and touch behave like a mouse (never a native range).
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ds } from '@/generated/ds'
import { cn } from '@/lib/utils'
import { icons } from '@/components/icons'
import { IconButton } from '@/components/IconButton'
import { FloatSlider } from '@/components/NodeParameters'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { NodeParameter } from '@/nodes/types'

export interface StackLayerItem {
  /** Stable id — never reused; ports derive from it. */
  id: string
  /** Assigned at creation ("Layer 3"), travels with the layer when reordered. */
  name: string
  blendMode: string
  opacity: number
  visible: boolean
  /** Label of the node wired into the layer's image input, e.g. "Gradient.color". */
  source?: string
  /** Label of what drives opacity, when wired. */
  opacitySource?: string
  /** Label of what drives the mask, when wired. */
  maskSource?: string
}

export type StackPort = 'source' | 'opacity' | 'mask'

export interface StackLayerListProps {
  /** Topmost layer first. */
  layers: StackLayerItem[]
  blendModes: { value: string; label: string }[]
  onAdd: () => void
  onRemove: (id: string) => void
  onToggleVisible: (id: string) => void
  onBlendChange: (id: string, blendMode: string) => void
  onOpacityChange: (id: string, opacity: number) => void
  /** Move the layer at `from` to `to` (indices into `layers`, top-first). */
  onReorder: (from: number, to: number) => void
  renderHandle?: (h: { layerId: string; port: StackPort; connected: boolean }) => ReactNode
}

const OPACITY_PARAM: NodeParameter = {
  id: 'opacity', label: 'Opacity', type: 'float', default: 1, min: 0, max: 1, step: 0.01, updateMode: 'uniform',
}

/** Index of the lowest visible layer; layers at or below it have nothing visible beneath. */
function blendDisabledFrom(layers: StackLayerItem[]): (index: number) => boolean {
  return (index) => !layers.slice(index + 1).some((l) => l.visible)
}

interface DragState {
  from: number
  to: number
  pointerId: number
  /** Pointer offset from the dragged card's top edge, kept while it follows the pointer. */
  grabOffset: number
  height: number
  /** Current top of the floating card, relative to the list. */
  top: number
}

export function StackLayerList(props: StackLayerListProps) {
  const { layers, onAdd, onReorder } = props
  const listRef = useRef<HTMLDivElement>(null)
  const layerRefs = useRef(new Map<string, HTMLDivElement>())
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  dragRef.current = drag

  const beginDrag = useCallback((index: number, e: React.PointerEvent) => {
    e.preventDefault()
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId) } catch { /* capture can fail mid-gesture */ }
    const el = layerRefs.current.get(layers[index].id)
    const list = listRef.current
    if (!el || !list) return
    const r = el.getBoundingClientRect()
    const lr = list.getBoundingClientRect()
    setDrag({ from: index, to: index, pointerId: e.pointerId, grabOffset: e.clientY - r.top, height: r.height, top: r.top - lr.top })
  }, [layers])

  // Window listeners survive capture loss while the button is held.
  useEffect(() => {
    if (!drag) return
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current
      const list = listRef.current
      if (!d || !list || e.pointerId !== d.pointerId) return
      const lr = list.getBoundingClientRect()
      const top = e.clientY - lr.top - d.grabOffset
      // Target slot: count the other layers whose midpoint the card's centre has passed.
      const centre = e.clientY - d.grabOffset + d.height / 2
      let to = 0
      layers.forEach((l, i) => {
        if (i === d.from) return
        const el = layerRefs.current.get(l.id)
        if (!el) return
        const r = el.getBoundingClientRect()
        if (centre > r.top + r.height / 2) to++
      })
      setDrag({ ...d, top, to })
    }
    const onEnd = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d || e.pointerId !== d.pointerId) return
      setDrag(null)
      if (e.type !== 'pointercancel' && d.to !== d.from) onReorder(d.from, d.to)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
    }
  }, [drag !== null, layers, onReorder]) // eslint-disable-line react-hooks/exhaustive-deps

  const isBlendDisabled = blendDisabledFrom(layers)

  // While dragging, the list shows the others in order with the hole at the target slot.
  const flow: Array<{ kind: 'layer'; index: number } | { kind: 'slot' }> = []
  if (drag) {
    const others = layers.map((_, i) => i).filter((i) => i !== drag.from)
    others.forEach((i, k) => {
      if (k === drag.to) flow.push({ kind: 'slot' })
      flow.push({ kind: 'layer', index: i })
    })
    if (drag.to >= others.length) flow.push({ kind: 'slot' })
  } else {
    layers.forEach((_, i) => flow.push({ kind: 'layer', index: i }))
  }

  return (
    <div ref={listRef} className="relative flex flex-col gap-md">
      <div className={ds.stackLayer.header}>
        <span className={cn(ds.categoryHeader.root, 'pb-0')}>Layers</span>
        <IconButton icon="plus" onClick={onAdd} aria-label="Add layer" />
      </div>

      {layers.length === 0 ? (
        <EmptyHole onAdd={onAdd} />
      ) : (
        flow.map((item) =>
          item.kind === 'slot' ? (
            <div key="__slot" className={cn(ds.stackDropSlot.slot, 'ml-1.5')} style={{ height: drag!.height }} />
          ) : (
            <LayerCard
              key={layers[item.index].id}
              {...props}
              layer={layers[item.index]}
              index={item.index}
              blendDisabled={isBlendDisabled(item.index)}
              cardRef={(el) => { if (el) layerRefs.current.set(layers[item.index].id, el); else layerRefs.current.delete(layers[item.index].id) }}
              onGripDown={beginDrag}
            />
          ),
        )
      )}

      {drag && (
        <div className="absolute inset-x-0 z-10" style={{ top: drag.top }}>
          <LayerCard
            {...props}
            layer={layers[drag.from]}
            index={drag.from}
            blendDisabled={isBlendDisabled(drag.from)}
            dragging
          />
        </div>
      )}
    </div>
  )
}

interface LayerCardProps extends StackLayerListProps {
  layer: StackLayerItem
  index: number
  blendDisabled: boolean
  dragging?: boolean
  cardRef?: (el: HTMLDivElement | null) => void
  onGripDown?: (index: number, e: React.PointerEvent) => void
}

function LayerCard({
  layer, index, blendDisabled, dragging, cardRef, onGripDown,
  blendModes, onRemove, onToggleVisible, onBlendChange, onOpacityChange, renderHandle,
}: LayerCardProps) {
  const [hovered, setHovered] = useState(false)
  const lifted = hovered || dragging
  const hidden = !layer.visible
  const Grip = icons.gripVertical
  const handle = (port: StackPort, connected: boolean) =>
    renderHandle ? <span className="absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 flex">{renderHandle({ layerId: layer.id, port, connected })}</span> : null

  return (
    <div
      ref={cardRef}
      className={ds.stackLayer.root}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      {/* Card surface. Dragging stacks the opaque body under the hover tint, as Figma's two fills do. */}
      {hidden ? <div className={ds.stackLayer.cardHidden} />
        : dragging ? <><div className={ds.stackLayer.cardDragging} /><div className={ds.stackLayer.cardHover} /></>
        : <div className={lifted ? ds.stackLayer.cardHover : ds.stackLayer.card} />}

      {/* 1 · the layer: its image input, name, source, remove and visibility */}
      <div className={ds.stackLayer.layerLine}>
        {handle('source', !!layer.source)}
        <div className={cn(ds.stackLayer.lineContent, 'flex-1 min-w-0')}>
          <Grip
            className={cn(ds.stackLayer.grip, 'size-icon-sm', hidden && ds.stackLayer.dimmed)}
            onPointerDown={(e) => onGripDown?.(index, e)}
            aria-label={`Reorder ${layer.name}`}
          />
          <div className={cn(ds.stackLayer.nameStack, 'flex-1 min-w-0', hidden && ds.stackLayer.dimmed)}>
            <span className={cn(ds.stackLayer.name, 'truncate')} title={layer.name}>{layer.name}</span>
            <span className={cn(ds.stackLayer.source, 'truncate')} title={layer.source ? `← ${layer.source}` : undefined}>
              {layer.source ? `← ${layer.source}` : 'No source'}
            </span>
          </div>
          {hovered && !dragging && (
            <IconButton icon="minus" onClick={() => onRemove(layer.id)} aria-label={`Remove ${layer.name}`} />
          )}
          <IconButton
            icon={hidden ? 'eyeOff' : 'eye'}
            onClick={() => onToggleVisible(layer.id)}
            aria-label={hidden ? `Show ${layer.name}` : `Hide ${layer.name}`}
          />
        </div>
      </div>

      {/* 2 · blend mode — a fixed choice, so no handle; greyed when nothing visible is below */}
      <div className={ds.stackLayer.blendLine}>
        <div className={cn(ds.stackLayer.lineContent, 'flex-1 min-w-0', hidden && ds.stackLayer.dimmed)}>
          <div className={cn('flex-1 min-w-0', blendDisabled && ds.stackLayer.blendDisabled)}>
            <Select value={layer.blendMode} onValueChange={(v) => onBlendChange(layer.id, v)} disabled={blendDisabled}>
              <SelectTrigger aria-label={`${layer.name} blend mode`}><SelectValue /></SelectTrigger>
              <SelectContent>
                {blendModes.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* 3 · opacity — the same slider / "← source" pair every connectable parameter uses */}
      <div className={ds.connectableParamRow.root}>
        {handle('opacity', !!layer.opacitySource)}
        <div className={cn(ds.connectableParamRow.innerFrame, hidden && ds.stackLayer.dimmed)}>
          {layer.opacitySource ? (
            <div className={cn(ds.nodeParameters.connectedHeader, 'py-2xs')}>
              <span className={ds.shaderNode.connectedLabel}>Opacity</span>
              <span className={ds.shaderNode.connectedSource}>{'← ' + layer.opacitySource}</span>
            </div>
          ) : (
            <FloatSlider param={OPACITY_PARAM} value={layer.opacity} onChange={(v) => onOpacityChange(layer.id, v)} />
          )}
        </div>
      </div>

      {/* 4 · mask — a port, labelled like any input port */}
      <div className={cn(ds.labeledHandle.root, 'flex-row')}>
        {handle('mask', !!layer.maskSource)}
        <span className={cn(ds.labeledHandle.label, hidden && ds.stackLayer.dimmed)} title={layer.maskSource ? `Mask ← ${layer.maskSource}` : undefined}>Mask</span>
      </div>
    </div>
  )
}

function EmptyHole({ onAdd }: { onAdd: () => void }) {
  const [hovered, setHovered] = useState(false)
  const Plus = icons.plus
  return (
    <button
      type="button"
      className={hovered ? ds.stackEmpty.rootHover : ds.stackEmpty.root}
      onClick={onAdd}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <span className={cn(hovered ? ds.stackEmpty.labelHover : ds.stackEmpty.label, 'flex flex-col items-center gap-xs')}>
        <Plus className="size-icon-sm" />
        Add a layer
      </span>
    </button>
  )
}
