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
 * several nodes can land in one pass. A node that declares no
 * `multiPass.resolution` wants FULL resolution, and downscaling the pass on a
 * pyramid sibling's behalf would silently degrade it — its `u_resolution`/
 * `u_dpr` would be scaled with no edge connecting it to the pyramid. So **any
 * non-declaring node in the pass pins the whole pass to full resolution**
 * (returns `undefined`): the pyramid loses its optimisation but every node
 * renders correctly, which is the right direction to fail in.
 *
 * Only when every node in the pass declares a scale do we take the MAX of them.
 * Returns `undefined` when nothing declares anything (unaffected graph → field
 * absent) OR when a non-declaring node forces the full-res pin.
 *
 * (Previously the `if (!fn) continue` below skipped non-declaring nodes, so a
 * regular sibling could NOT pin the pass — the exact opposite of this doc —
 * and a pyramid sub-pass dragged edge-unrelated pass-mates to its reduced
 * scale. See docs/research/2026-08-19-entanglement-audit.md finding F2.)
 */
export function resolvePassResolution(
  passNodeIds: string[],
  nodeMap: Map<string, Node<NodeData>>,
): number | undefined {
  let best: number | undefined
  const declared: number[] = []
  let anyFullRes = false

  for (const id of passNodeIds) {
    const node = nodeMap.get(id)
    if (!node) continue
    const fn = nodeRegistry.get(node.data.type)?.multiPass?.resolution
    if (!fn) {
      // A real node with no declared scale demands full resolution.
      anyFullRes = true
      continue
    }

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

  // A non-declaring node cannot be safely downscaled by a sibling → full res.
  if (anyFullRes) return undefined

  if (new Set(declared).size > 1) {
    console.warn(
      `[Sombra] one pass declares conflicting resolutions (${declared.join(', ')}) — using ${best}`,
    )
  }
  return best
}
