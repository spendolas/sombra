/**
 * Pure change-detection key builders, extracted from the `useMemo` bodies in
 * `use-live-compiler.ts` so they can be tested without rendering the hook.
 *
 * These are copied verbatim — no behaviour change. See use-live-compiler.ts
 * for how they're used (semantic → recompile, uniform → fast-path GPU upload,
 * renderer → renderer-only settings).
 */

import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'

// Derive semantic key from only structural (recompile-mode) data
export function buildSemanticKey(nodes: Node<NodeData>[], edges: Edge<EdgeData>[]): string {
  const nk = nodes
    .map((n) => {
      const def = nodeRegistry.get(n.data.type)
      const structural: Record<string, unknown> = {}
      if (def?.params) {
        for (const p of def.params) {
          if (p.updateMode === 'recompile')
            structural[p.id] = n.data.params?.[p.id] ?? p.default
        }
      }
      return `${n.id}:${n.data.type}:${JSON.stringify(structural)}`
    })
    .join('|')
  const ek = edges
    .map(
      (e) =>
        `${e.source}:${e.sourceHandle}->${e.target}:${e.targetHandle}`
    )
    .join('|')
  return nk + '||' + ek
}

// Derive uniform key from uniform-mode param values only
export function buildUniformKey(nodes: Node<NodeData>[]): string {
  return nodes
    .map((n) => {
      const def = nodeRegistry.get(n.data.type)
      if (!def?.params) return ''
      return def.params
        .filter((p) => p.updateMode === 'uniform')
        .map(
          (p) =>
            `${n.id}:${p.id}:${JSON.stringify(n.data.params?.[p.id] ?? p.default)}`
        )
        .join(',')
    })
    .filter(Boolean)
    .join('|')
}

// Derive renderer key from renderer-mode param values only
export function buildRendererKey(nodes: Node<NodeData>[]): string {
  return nodes
    .map((n) => {
      const def = nodeRegistry.get(n.data.type)
      if (!def?.params) return ''
      return def.params
        .filter((p) => p.updateMode === 'renderer')
        .map(
          (p) =>
            `${n.id}:${p.id}:${JSON.stringify(n.data.params?.[p.id] ?? p.default)}`
        )
        .join(',')
    })
    .filter(Boolean)
    .join('|')
}
