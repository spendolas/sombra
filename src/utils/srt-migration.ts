/**
 * One-storage Offset Space migration (see ir/srt.ts + the SRT design spec).
 *
 * The shader now has exactly ONE translate semantic: srt_translateX/Y always
 * store the WORLD-frame offset. Before this (the whole pre-branch era), the
 * framework-injected SRT applied translate inside the node's scaled+rotated
 * frame ("node" semantics) — so stored offsets from older saves mean something
 * different and would render shifted wherever scale≠1 or rotate≠0.
 *
 * This repairs a loaded graph in place (same pattern as dedupeNodeIds):
 *  - params with NO srt_translateSpace key → pre-param save, authored under
 *    node semantics → convert offsets t_world = S·R(−θ)·t_node, stamp 'world'.
 *  - 'local' (QA-era branch save, node shader semantics) → convert offsets,
 *    keep the user's chosen view as canonical 'node'.
 *  - 'screen' (QA-era, world shader semantics) → values already world; just
 *    canonicalize the name to 'world'.
 *  - 'world' / 'node' → already one-storage; untouched. Idempotent.
 *
 * MODE — the missing-key case is ambiguous for non-exposed spatial nodes
 * (image, warp, uv_transform, gradient never carry the key), so the caller
 * says where the graph came from:
 *  - 'convert' (.sombra files, imports, share URLs): treat missing as a
 *    main-era node-semantics save and convert — faithful to what was authored.
 *  - 'stamp-only' (localStorage persist): the working graph has rendered under
 *    the branch's world semantics all along — what's on screen IS what the
 *    user has been seeing; stamp 'world' without touching values so the render
 *    doesn't shift on reload.
 *
 * Only FRAMEWORK-spatial nodes migrate (their translate routed through
 * emitSRT). Hand-rolled SRT (reeded_glass; warp's internal noise-coords copy)
 * never followed the framework semantics and is untouched — warp itself IS
 * framework-spatial for its `coords` input, so it migrates.
 * verify-srt cross-checks this list against the registry so it cannot drift.
 */
import type { Node } from '@xyflow/react'
import type { NodeData } from '../nodes/types'
import { nodeOffsetToWorld } from '../compiler/ir/srt'

/** Node types whose SRT is framework-injected AND includes translate. */
export const FRAMEWORK_SPATIAL_TRANSLATE_TYPES: ReadonlySet<string> = new Set([
  'uv_transform', 'image', 'noise', 'fbm', 'stripes', 'checkerboard', 'dots',
  'gradient', 'warp',
])

export function migrateOffsetSpace(
  nodes: Node<NodeData>[],
  mode: 'convert' | 'stamp-only',
): { nodes: Node<NodeData>[]; migrated: number } {
  let migrated = 0
  const out = nodes.map((node) => {
    if (!FRAMEWORK_SPATIAL_TRANSLATE_TYPES.has(node.data.type)) return node
    const p = node.data.params
    if (!p) return node
    if (!('srt_translateX' in p) && !('srt_translateY' in p)) return node

    const space = p.srt_translateSpace
    if (space === 'world' || space === 'node') return node // already one-storage

    const needsConvert = space === 'local' || (space === undefined && mode === 'convert')
    const newSpace = space === 'local' ? 'node' : 'world' // preserve chosen view; 'screen'/missing → 'world'

    let tx = (p.srt_translateX as number) ?? 0
    let ty = (p.srt_translateY as number) ?? 0
    if (needsConvert && (tx !== 0 || ty !== 0)) {
      const rotate = (p.srt_rotate as number) ?? 0
      const sx = (p.srt_scaleX as number) ?? (p.srt_scale as number) ?? 1
      const sy = (p.srt_scaleY as number) ?? (p.srt_scale as number) ?? 1
      const w = nodeOffsetToWorld(tx, ty, rotate, sx, sy)
      tx = w.tx
      ty = w.ty
    }

    migrated++
    return {
      ...node,
      data: {
        ...node.data,
        params: { ...p, srt_translateX: tx, srt_translateY: ty, srt_translateSpace: newSpace },
      },
    }
  })
  return { nodes: migrated > 0 ? out : nodes, migrated }
}
