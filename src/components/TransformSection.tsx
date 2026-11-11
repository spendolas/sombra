/**
 * TransformSection — wires the signed-off SectionHeader into a live node's
 * framework Transform (SRT) section.
 *
 * No visual decisions here: the header is used exactly as designed (Figma board
 * "Transform — collapsed wires", 994:4107, Option A + drop behaviour 1); this
 * file only maps graph state onto its props.
 *
 *  - Collapsed: the param rows unmount, but every WIRED param keeps a real React
 *    Flow handle, all stacked on the header's gather dot, each with
 *    `id === param id` (saved edges resolve by handle id). So the wires stay
 *    drawn and gather on one dot. Exactly one handle per id is mounted at any
 *    time: the stacked one while collapsed, the row's own while open.
 *  - The stacked handles are neither connection starts nor ends: one dot cannot
 *    say which param a new wire means. New wires use open-on-drag instead.
 *  - Open-on-drag: while a connection is dragged, the drag's pointer position is
 *    hit-tested against the collapsed header (touch/pen drags capture the
 *    pointer, so the header never sees pointerenter) and fed as `dropActive`;
 *    the header opens itself after its dwell.
 *  - Handles move without the node resizing in a way React Flow can see, so its
 *    handle bounds are refreshed whenever the handle layout changes (open state
 *    and the set of wired params) — the StackNodeBody pattern, keyed on a string.
 */

import { useEffect, useRef, type ReactNode } from 'react'
import { Position, useConnection, useUpdateNodeInternals } from '@xyflow/react'
import { SectionHeader } from '@/components/SectionHeader'
import { BaseHandle } from '@/components/base-handle'

export interface TransformWire {
  /** The param id — and so the handle id the saved edge names. */
  id: string
  /** Row label ("Scale"). */
  label: string
  /** "<Node label>.<output>" of the driving node. */
  source: string
  /** Port colour of the param. */
  color: string
}

export interface TransformSectionProps {
  nodeId: string
  open: boolean
  onToggle: (next: boolean) => void
  /** Wired, visible, connectable SRT params, in row order. */
  wired: TransformWire[]
  /** The rows. Rendered only while open. */
  children: ReactNode
}

export function TransformSection({ nodeId, open, onToggle, wired, children }: TransformSectionProps) {
  const updateNodeInternals = useUpdateNodeInternals()
  const headerRef = useRef<HTMLDivElement>(null)

  // Re-measure whenever the handle layout changes. Keyed on a string of the
  // layout (value, not identity — `wired` is a fresh array every render).
  const layout = `${open ? 'open' : 'closed'}|${wired.map((w) => w.id).join(',')}`
  useEffect(() => { updateNodeInternals(nodeId) }, [layout, nodeId, updateNodeInternals])

  const connecting = useConnection((c) => c.inProgress)
  // Selector returns a boolean, so the node re-renders only when the drag
  // enters or leaves the header — not on every pointer move.
  const dragOverHeader = useConnection((c) => {
    if (!c.inProgress || open || !c.pointer) return false
    const el = headerRef.current
    if (!el) return false
    // `pointer` is the raw drag position in px relative to the React Flow
    // container (not flow units, and never snapped to a nearby handle as `to` is).
    const pane = el.closest('.react-flow')?.getBoundingClientRect()
    if (!pane) return false
    const x = pane.left + c.pointer.x, y = pane.top + c.pointer.y
    const r = el.getBoundingClientRect()
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
  })

  const bodyId = `transform-${nodeId}`
  return (
    <>
      <div ref={headerRef}>
        <SectionHeader
          label="Transform"
          open={open}
          onToggle={onToggle}
          wiredParams={wired}
          connecting={connecting}
          dropActive={dragOverHeader}
          controlsId={bodyId}
          className="nodrag"
          renderGatherHandle={() => wired.map((w) => (
            <BaseHandle
              key={w.id}
              type="target"
              position={Position.Left}
              id={w.id}
              handleColor={w.color}
              connected
              isConnectableStart={false}
              isConnectableEnd={false}
              // Centred on the gather box (React Flow's left handle sits on its
              // container's left edge); the box itself is centred on the
              // content edge, where the rows' handles sit.
              style={{ left: '50%' }}
            />
          ))}
        />
      </div>
      {open && <div id={bodyId}>{children}</div>}
    </>
  )
}
