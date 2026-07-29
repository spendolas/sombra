/**
 * Resolve the scale a render pass should rasterise at from the nodes it holds.
 *
 * Shared by the GLSL and IR compilers so the two paths cannot disagree about
 * pass geometry — the failure mode this whole feature is most exposed to.
 */
import type { Node } from '@xyflow/react'
import type { NodeData } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'
import { SUB_PASS_PARAM } from './expand-passes'

/**
 * A pass is a DEPTH GROUP, not a single node (see `partitionIntoPasses`), so
 * several nodes can land in one pass and declare different scales. The rule is
 * MAX, because downscaling a pass on one node's behalf would silently degrade
 * every sibling that wanted full resolution. Max can only cost memory: a pyramid
 * whose sibling pins the pass to 1.0 loses its optimisation but still renders
 * correctly, which is the right direction to fail in.
 *
 * Returns `undefined` when no node in the pass declares anything, so an
 * unaffected graph produces a plan with the field absent rather than defaulted.
 */
export function resolvePassResolution(
  passNodeIds: string[],
  nodeMap: Map<string, Node<NodeData>>,
): number | undefined {
  let best: number | undefined
  const declared: number[] = []

  for (const id of passNodeIds) {
    const node = nodeMap.get(id)
    if (!node) continue
    const fn = nodeRegistry.get(node.data.type)?.multiPass?.resolution
    if (!fn) continue

    const params = node.data.params || {}
    const rawIndex = Number(params[SUB_PASS_PARAM] ?? 0)
    const passIndex = Number.isFinite(rawIndex) ? rawIndex : 0

    let scale: number
    try {
      scale = fn(passIndex, params)
    } catch (err) {
      console.warn(`[Sombra] ${node.data.type}.multiPass.resolution threw — ignoring`, err)
      continue
    }
    if (!Number.isFinite(scale) || scale <= 0) continue

    declared.push(scale)
    best = best === undefined ? scale : Math.max(best, scale)
  }

  if (new Set(declared).size > 1) {
    console.warn(
      `[Sombra] one pass declares conflicting resolutions (${declared.join(', ')}) — using ${best}`,
    )
  }
  return best
}
