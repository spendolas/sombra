/**
 * Topological sort for shader node graphs
 * Orders nodes from Fragment Output backward to ensure dependencies are met
 */

import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../nodes/types'

/**
 * Perform topological sort on the node graph
 * Starts from Fragment Output and works backward through dependencies
 *
 * @param nodes All nodes in the graph
 * @param edges All edges in the graph
 * @returns Ordered array of node IDs (Fragment Output is last)
 * @throws Error if graph has cycles or multiple output nodes
 */
export function topologicalSort(
  nodes: Node<NodeData>[],
  edges: Edge<EdgeData>[],
  startNodeId?: string,
): string[] {
  let startId: string

  if (startNodeId) {
    // Start from the specified node
    const node = nodes.find(n => n.id === startNodeId)
    if (!node) throw new Error(`Start node "${startNodeId}" not found.`)
    startId = node.id
  } else {
    // Find the Fragment Output node (should be exactly one)
    const outputNodes = nodes.filter((node) => node.data.type === 'fragment_output')

    if (outputNodes.length === 0) {
      throw new Error('No Fragment Output node found. Add one to complete the graph.')
    }

    if (outputNodes.length > 1) {
      throw new Error('Multiple Fragment Output nodes found. Only one is allowed.')
    }

    startId = outputNodes[0].id
  }

  // Build adjacency lists for reverse traversal (target -> sources)
  const incomingEdges = new Map<string, string[]>()

  edges.forEach((edge) => {
    if (!incomingEdges.has(edge.target)) {
      incomingEdges.set(edge.target, [])
    }
    incomingEdges.get(edge.target)!.push(edge.source)
  })

  // DFS to collect all reachable nodes in reverse dependency order
  const visited = new Set<string>()
  const result: string[] = []

  function visit(nodeId: string) {
    if (visited.has(nodeId)) {
      return
    }

    visited.add(nodeId)

    // Visit all nodes that feed into this one
    const sources = incomingEdges.get(nodeId) || []
    sources.forEach((sourceId) => visit(sourceId))

    // Add this node after its dependencies
    result.push(nodeId)
  }

  visit(startId)

  return result
}

/**
 * Check for cycles in the graph
 * @param nodes All nodes
 * @param edges All edges
 * @returns True if graph has cycles
 */
export function hasCycles(
  nodes: Node<NodeData>[],
  edges: Edge<EdgeData>[]
): boolean {
  const adjacency = new Map<string, string[]>()

  // Build adjacency list
  edges.forEach((edge) => {
    if (!adjacency.has(edge.source)) {
      adjacency.set(edge.source, [])
    }
    adjacency.get(edge.source)!.push(edge.target)
  })

  const visiting = new Set<string>()
  const visited = new Set<string>()

  function visit(nodeId: string): boolean {
    if (visiting.has(nodeId)) {
      return true // Cycle detected
    }
    if (visited.has(nodeId)) {
      return false
    }

    visiting.add(nodeId)

    const neighbors = adjacency.get(nodeId) || []
    for (const neighbor of neighbors) {
      if (visit(neighbor)) {
        return true
      }
    }

    visiting.delete(nodeId)
    visited.add(nodeId)
    return false
  }

  // Check all nodes as starting points
  for (const node of nodes) {
    if (visit(node.id)) {
      return true
    }
  }

  return false
}

/**
 * Would adding this connection put a cycle in the graph?
 *
 * Cycles were diagnosed but never prevented: every compile entry point calls
 * `hasCycles` and surfaces "Graph contains cycles", while `topologicalSort`
 * itself has no cycle detection and returns a silently mis-ordered list. This
 * is the check that stops one being drawn — `isValidConnection` on the canvas
 * refuses the wire.
 *
 * `source → target` closes a loop if and only if `target` can ALREADY reach
 * `source`, so this is a forward walk from `target` that stops the moment it
 * finds `source` — not `hasCycles` over a speculative copy of the whole graph.
 * `isValidConnection` fires continuously while a wire is being dragged, and
 * the walk only touches the component downstream of `target`, where the whole-
 * graph check visits every node and edge on every call regardless.
 *
 * Asking "can target reach source" — rather than "does any node get visited
 * twice" — is what keeps convergence legal: `A→B`, `A→C`, `B→D`, `C→D` reaches
 * D by two paths and is a DAG, not a cycle. Rejecting that shape would be far
 * worse than the bug being fixed, since fan-out-and-converge is the topology
 * every multi-input node is made of.
 *
 * `visited` is not what makes that answer correct — it is what makes the walk
 * TERMINATE. A cyclic graph can still arrive by file load or share URL (those
 * paths are deliberately not validated; they load and fail at compile), and
 * hovering a handle over one would otherwise walk the loop forever and hang
 * the tab. It also stops a dense DAG being re-explored along every path.
 *
 * Edges into connectable params are ordinary edges and carry cycles like any
 * other, which is why this looks only at `source`/`target` and ignores handles.
 */
export function wouldCreateCycle(
  edges: ReadonlyArray<{ source: string; target: string }>,
  candidate: { source: string; target: string },
): boolean {
  if (candidate.source === candidate.target) return true

  const outgoing = new Map<string, string[]>()
  for (const edge of edges) {
    const from = outgoing.get(edge.source)
    if (from) from.push(edge.target)
    else outgoing.set(edge.source, [edge.target])
  }

  const visited = new Set<string>([candidate.target])
  const stack = [candidate.target]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (id === candidate.source) return true
    for (const next of outgoing.get(id) ?? []) {
      if (visited.has(next)) continue
      visited.add(next)
      stack.push(next)
    }
  }
  return false
}
