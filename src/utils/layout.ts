/**
 * Auto-layout utility using dagre for left-to-right DAG positioning.
 * Estimates node dimensions from NodeDefinition port counts.
 */

import Dagre from '@dagrejs/dagre'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'

/** Estimated dimension constants (px) */
const HEADER_H = 36
const ROW_H = 24
const CONNECTABLE_ROW_H = 32
const PARAM_ROW_H = 32
const SECTION_GAP = 8
const NODE_MIN_W = 180
const NODE_PADDING = 16

/**
 * Estimate a node's rendered dimensions from its definition.
 */
function estimateNodeSize(data: NodeData): { width: number; height: number } {
  const def = nodeRegistry.get(data.type)
  if (!def) return { width: NODE_MIN_W, height: 80 }

  const params = data.params || {}
  const inputs = def.dynamicInputs ? def.dynamicInputs(params) : def.inputs
  const connectableParams = (def.params || []).filter((p) => p.connectable)
  const regularParams = (def.params || []).filter((p) => !p.connectable && !p.hidden)

  let h = HEADER_H + NODE_PADDING
  h += def.outputs.length * ROW_H                           // outputs
  if (def.outputs.length > 0 && inputs.length > 0) h += SECTION_GAP
  h += inputs.length * ROW_H                                // inputs
  if (inputs.length > 0 && connectableParams.length > 0) h += SECTION_GAP
  h += connectableParams.length * CONNECTABLE_ROW_H          // connectable params
  h += regularParams.length * PARAM_ROW_H                    // regular params
  if (def.component) h += 48                                 // custom component area (color ramp gradient etc)
  h += NODE_PADDING

  // Wider nodes for those with labels + sliders side by side
  const hasConnectable = connectableParams.length > 0
  const w = hasConnectable ? 200 : NODE_MIN_W

  return { width: w, height: Math.max(h, 70) }
}

/**
 * Apply dagre left-to-right layout to a set of nodes and edges.
 * Returns new nodes array with updated positions.
 */
export function layoutGraph(
  nodes: Node<NodeData>[],
  edges: Edge<EdgeData>[],
  options?: { ranksep?: number; nodesep?: number }
): Node<NodeData>[] {
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  g.setGraph({
    rankdir: 'LR',
    ranksep: options?.ranksep ?? 120,
    nodesep: options?.nodesep ?? 40,
    marginx: 0,
    marginy: 0,
  })

  // Add nodes with estimated dimensions
  for (const node of nodes) {
    const size = estimateNodeSize(node.data)
    g.setNode(node.id, { width: size.width, height: size.height })
  }

  // Add edges
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target)
  }

  Dagre.layout(g)

  // Map dagre positions back (dagre uses center coords, React Flow uses top-left)
  const nodesep = options?.nodesep ?? 40
  const laid = nodes.map((node) => {
    const pos = g.node(node.id)
    const size = estimateNodeSize(node.data)
    return {
      ...node,
      position: {
        x: Math.round(pos.x - size.width / 2),
        y: Math.round(pos.y - size.height / 2),
      },
    }
  })

  // Post-process: reorder siblings sharing a dagre rank & target to match handle order
  return reorderByHandleOrder(laid, edges, nodesep)
}

/**
 * Get ordered handle IDs for the left (input) side of a node:
 * pure inputs first, then connectable params — matching ShaderNode render order.
 */
function getInputHandleOrder(data: NodeData): string[] {
  const def = nodeRegistry.get(data.type)
  if (!def) return []
  const params = data.params || {}
  const inputs = def.dynamicInputs ? def.dynamicInputs(params) : def.inputs
  const connectableParams = (def.params || []).filter((p) => p.connectable)
  return [...inputs.map((p) => p.id), ...connectableParams.map((p) => p.id)]
}

/**
 * After dagre layout, find groups of source nodes in the same rank that all
 * feed into the same target. Reorder them vertically to match the target's
 * input handle order, centered around the group's original centroid.
 */
function reorderByHandleOrder(
  nodes: Node<NodeData>[],
  edges: Edge<EdgeData>[],
  nodesep: number
): Node<NodeData>[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))

  // Group edges by target node
  const edgesByTarget = new Map<string, Edge<EdgeData>[]>()
  for (const edge of edges) {
    if (!edgesByTarget.has(edge.target)) edgesByTarget.set(edge.target, [])
    edgesByTarget.get(edge.target)!.push(edge)
  }

  for (const [targetId, targetEdges] of edgesByTarget) {
    const targetNode = nodeMap.get(targetId)
    if (!targetNode) continue

    const handleOrder = getInputHandleOrder(targetNode.data)
    if (handleOrder.length === 0) continue

    // Collect all source nodes with their handle index
    const sourceInfo = targetEdges
      .map((edge) => {
        const sourceNode = nodeMap.get(edge.source)
        if (!sourceNode) return null
        const handleIdx = handleOrder.indexOf(edge.targetHandle || '')
        return { sourceNode, handleIdx: handleIdx >= 0 ? handleIdx : 999 }
      })
      .filter((s): s is NonNullable<typeof s> => s !== null)

    // Group by approximate x position (same dagre rank)
    const byRank = new Map<number, typeof sourceInfo>()
    for (const info of sourceInfo) {
      const bucket = Math.round(info.sourceNode.position.x / 60) * 60
      if (!byRank.has(bucket)) byRank.set(bucket, [])
      byRank.get(bucket)!.push(info)
    }

    for (const [, group] of byRank) {
      if (group.length < 2) continue

      // Current Y order
      const sorted = [...group].sort((a, b) => a.sourceNode.position.y - b.sourceNode.position.y)

      // Desired order by handle index
      const desired = [...group].sort((a, b) => a.handleIdx - b.handleIdx)

      // Already correct?
      if (desired.every((d, i) => d.sourceNode.id === sorted[i].sourceNode.id)) continue

      // Compute original group centroid (center of bounding box)
      const heights = sorted.map((s) => estimateNodeSize(s.sourceNode.data).height)
      const groupTop = sorted[0].sourceNode.position.y
      const groupBottom = sorted[sorted.length - 1].sourceNode.position.y + heights[heights.length - 1]
      const groupCenterY = (groupTop + groupBottom) / 2

      // Compute total stack height in desired order
      const desiredHeights = desired.map((d) => estimateNodeSize(d.sourceNode.data).height)
      const totalHeight = desiredHeights.reduce((s, h) => s + h, 0) + (desired.length - 1) * nodesep

      // Restack centered on original centroid
      let y = groupCenterY - totalHeight / 2
      for (let i = 0; i < desired.length; i++) {
        desired[i].sourceNode.position.y = Math.round(y)
        y += desiredHeights[i] + nodesep
      }
    }
  }

  return nodes
}
