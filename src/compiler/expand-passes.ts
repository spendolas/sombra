/**
 * Multi-pass node expansion.
 *
 * Some effects genuinely cannot be done in one render pass. A separable Gaussian
 * blur is the motivating case: it must filter horizontally, store the result, and
 * filter vertically. Doing it in a single pass means a 2D gather, which measurably
 * fails at useful radii (see docs/research/2026-07-27-blur-algorithm-bakeoff.md),
 * and asking users to wire two nodes is not an acceptable interface.
 *
 * The compiler assigns exactly one pass depth per node, so instead of reworking
 * partitioning, a node that declares `multiPass` is expanded into a chain of
 * virtual nodes BEFORE compilation:
 *
 *     [blur]                ->   [blur] --color--> [blur__p1]
 *       ^ incoming                 ^ incoming        outgoing ^
 *
 * The first sub-pass keeps the authored id so incoming edges and error reporting
 * still line up; outgoing edges move to the last sub-pass. Every downstream stage
 * — partitionPasses, findTextureBoundaries, the renderers — then works unchanged,
 * and nodes without `multiPass` are returned untouched.
 */

import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'

/** Param key carrying the sub-pass index into a node's generator. */
export const SUB_PASS_PARAM = '__subPass'

/**
 * Sub-pass id suffix. Node ids become GLSL identifiers with hyphens turned into
 * underscores, so this must not produce a double underscore — GLSL ES reserves
 * identifiers containing `__`, and the GPU compile fails outright.
 */
const SUFFIX = '-sp'

/** Map a possibly-expanded node id back to the id the user authored. */
export function baseNodeId(id: string): string {
  const i = id.lastIndexOf(SUFFIX)
  if (i < 0) return id
  const tail = id.slice(i + SUFFIX.length)
  return /^\d+$/.test(tail) ? id.slice(0, i) : id
}

/**
 * Expand every multi-pass node into a chain. Returns the original arrays when
 * nothing needs expanding, so the common path allocates nothing.
 */
export function expandMultiPassNodes(
  nodes: Node<NodeData>[],
  edges: Edge<EdgeData>[],
): {
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
  /**
   * Authored id → id of its final sub-pass. Callers that render a specific node
   * (the per-node preview) must retarget through this, or they would render only
   * the first sub-pass — a blur would come out filtered on one axis only.
   */
  lastOf: Map<string, string>
} {
  // Which nodes actually need expansion?
  const plans = new Map<string, { count: number; from: string; to: string }>()
  for (const node of nodes) {
    const def = nodeRegistry.get(node.data.type)
    const mp = def?.multiPass
    if (!mp) continue
    // A node with nothing wired into its chained input has no upstream texture to
    // filter, so extra passes would only re-read a blank target.
    const hasSource = edges.some((e) => e.target === node.id && e.targetHandle === mp.to)
    if (!hasSource) continue
    const count = Math.max(1, Math.floor(mp.count(node.data.params || {})))
    if (count > 1) plans.set(node.id, { count, from: mp.from, to: mp.to })
  }
  if (plans.size === 0) return { nodes, edges, lastOf: new Map() }

  const outNodes: Node<NodeData>[] = []
  const outEdges: Edge<EdgeData>[] = [...edges]
  /** authored id → id of its final sub-pass (what downstream should read) */
  const lastOf = new Map<string, string>()

  for (const node of nodes) {
    const plan = plans.get(node.id)
    if (!plan) {
      outNodes.push(node)
      continue
    }
    let prevId = node.id
    for (let k = 0; k < plan.count; k++) {
      const id = k === 0 ? node.id : `${node.id}${SUFFIX}${k}`
      outNodes.push({
        ...node,
        id,
        data: {
          ...node.data,
          params: { ...(node.data.params || {}), [SUB_PASS_PARAM]: k },
        },
      })
      if (k > 0) {
        outEdges.push({
          id: `${node.id}${SUFFIX}link${k}`,
          source: prevId,
          sourceHandle: plan.from,
          target: id,
          targetHandle: plan.to,
        } as Edge<EdgeData>)
      }
      prevId = id
    }
    lastOf.set(node.id, prevId)
  }

  // Downstream consumers must read the end of the chain, not the head. Only
  // rewire edges that existed before expansion; the internal links are already
  // pointed correctly.
  const rewired = outEdges.map((e) => {
    const last = lastOf.get(e.source)
    if (!last || last === e.source) return e
    if (e.id.startsWith(`${e.source}${SUFFIX}link`)) return e
    return { ...e, source: last }
  })

  return { nodes: outNodes, edges: rewired, lastOf }
}
