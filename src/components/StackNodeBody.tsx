/**
 * StackNodeBody — wires the signed-off StackLayerList into a live Stack node.
 *
 * No visual decisions here: the list is used exactly as designed; this file
 * only maps graph state onto its props and its callbacks onto store actions.
 *
 *  - Order: the store keeps `layers` bottom-first; the list wants top-first.
 *    Both directions go through stack-edit.ts (`toTopFirst` for display, the
 *    `reorder` edit for moves), so the flip lives in exactly one module.
 *  - Structure edits (add, remove, reorder, visibility, blend) go through the
 *    single atomic `editStackLayers` action — params and wires together, one
 *    undo step. Opacity is a uniform param and takes the ordinary param path,
 *    so a slider drag stays on the no-recompile fast path and coalesces.
 *  - Handles are real React Flow handles whose ids equal the port / param ids
 *    (`layer_<id>`, `opacity_<id>`, `mask_<id>`), or edges drop on reload.
 *  - Reorder moves handles without resizing the node, which a size-based
 *    re-measure cannot see — so the node's handle bounds are refreshed
 *    whenever the handle layout changes.
 */

import { useCallback, useEffect, useMemo } from 'react'
import { Position, useUpdateNodeInternals } from '@xyflow/react'
import { StackLayerList, type StackLayerItem, type StackPort } from '@/components/StackLayerList'
import { BaseHandle } from '@/components/base-handle'
import { useGraphStore } from '@/stores/graphStore'
import { nodeRegistry } from '@/nodes/registry'
import { getLayers, layerPortId, maskParamId, opacityParamId, STACK_BLEND_OPTIONS } from '@/nodes/color/stack'
import { toTopFirst } from '@/nodes/color/stack-edit'
import { isBlendMode } from '@/nodes/shared/blend-modes'
import { getPortColor } from '@/utils/port-colors'

const handleId = (layerId: string, port: StackPort) =>
  port === 'source' ? layerPortId(layerId) : port === 'opacity' ? opacityParamId(layerId) : maskParamId(layerId)

export function StackNodeBody({ nodeId, data }: { nodeId: string; data: Record<string, unknown> }) {
  const edges = useGraphStore((s) => s.edges)
  const nodes = useGraphStore((s) => s.nodes)
  const editStackLayers = useGraphStore((s) => s.editStackLayers)
  const updateNodeData = useGraphStore((s) => s.updateNodeData)
  const updateNodeInternals = useUpdateNodeInternals()

  const layers = useMemo(() => getLayers(data), [data])

  /** "Node.output" for whatever drives `handle` on this node, if anything. */
  const sourceOf = useCallback((handle: string): string | undefined => {
    const edge = edges.find((e) => e.target === nodeId && e.targetHandle === handle)
    if (!edge) return undefined
    const src = nodes.find((n) => n.id === edge.source)
    const label = src ? nodeRegistry.get(src.data.type)?.label ?? src.data.type : edge.source
    return `${label}.${edge.sourceHandle}`
  }, [edges, nodes, nodeId])

  const items: StackLayerItem[] = useMemo(() => toTopFirst(layers).map((l) => ({
    id: l.id,
    name: l.name,
    blendMode: l.blendMode,
    visible: l.visible,
    opacity: typeof data[opacityParamId(l.id)] === 'number' ? (data[opacityParamId(l.id)] as number) : 1,
    source: sourceOf(layerPortId(l.id)),
    opacitySource: sourceOf(opacityParamId(l.id)),
    maskSource: sourceOf(maskParamId(l.id)),
  })), [layers, data, sourceOf])

  // Re-measure handle bounds whenever the handle layout changes — including a
  // pure reorder, which leaves the node's size untouched.
  const handleLayout = items.map((l) => `${l.id}:${l.visible ? 1 : 0}`).join(',')
  useEffect(() => { updateNodeInternals(nodeId) }, [handleLayout, nodeId, updateNodeInternals])

  return (
    <StackLayerList
      layers={items}
      blendModes={STACK_BLEND_OPTIONS}
      onAdd={() => editStackLayers(nodeId, { kind: 'add' })}
      onRemove={(id) => editStackLayers(nodeId, { kind: 'remove', id })}
      onToggleVisible={(id) => editStackLayers(nodeId, { kind: 'toggleVisible', id })}
      onBlendChange={(id, mode) => { if (isBlendMode(mode)) editStackLayers(nodeId, { kind: 'blend', id, blendMode: mode }) }}
      onOpacityChange={(id, opacity) => updateNodeData(nodeId, { params: { ...data, [opacityParamId(id)]: opacity } })}
      onReorder={(from, to) => editStackLayers(nodeId, { kind: 'reorder', from, to })}
      renderHandle={({ layerId, port, connected }) => (
        <BaseHandle
          type="target"
          position={Position.Left}
          id={handleId(layerId, port)}
          // Same colours the signed-off sandbox uses: opacity is the float port.
          handleColor={getPortColor(port === 'opacity' ? 'float' : 'color')}
          connected={connected}
        />
      )}
    />
  )
}
