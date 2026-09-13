import type { Edge } from '@xyflow/react'

/**
 * Every node whose output `startNodeId` depends on, restricted to `within`.
 *
 * Used to prune relay passes: a relay computes one source output, so it only
 * needs the lines of the nodes feeding that output. The `within` set confines
 * the walk to a single pass — nodes in earlier passes arrive as textures, not
 * as inline code, and must not be pulled in.
 *
 * Iterative rather than recursive, and `seen`-guarded, so a cyclic graph that
 * arrived from a file (the editor refuses to draw one, but a shared URL can
 * carry one) terminates instead of hanging the worker.
 */
export function nodesFeeding(
  startNodeId: string,
  edgesByTarget: Map<string, Edge[]>,
  within: Set<string>,
): Set<string> {
  const seen = new Set<string>()
  const stack = [startNodeId]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id) || !within.has(id)) continue
    seen.add(id)
    for (const edge of edgesByTarget.get(id) ?? []) stack.push(edge.source)
  }
  return seen
}
