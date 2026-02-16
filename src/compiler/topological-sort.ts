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
  edges: Edge<EdgeData>[]
): string[] {
  // Find the Fragment Output node (should be exactly one)
  const outputNodes = nodes.filter((node) => node.data.type === 'fragment_output')

  if (outputNodes.length === 0) {
    throw new Error('No Fragment Output node found. Add one to complete the graph.')
  }

  if (outputNodes.length > 1) {
    throw new Error('Multiple Fragment Output nodes found. Only one is allowed.')
  }

  const outputNode = outputNodes[0]

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

  visit(outputNode.id)

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
