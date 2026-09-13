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
import { resolveParams } from '../nodes/resolve-dynamic'

// Derive semantic key from only structural (recompile-mode) data
export function buildSemanticKey(nodes: Node<NodeData>[], edges: Edge<EdgeData>[]): string {
  const nk = nodes
    .map((n) => {
      const def = nodeRegistry.get(n.data.type)
      const structural: Record<string, unknown> = {}
      let paramCount = 0
      if (def) {
        const params = resolveParams(def, n.data.params)
        paramCount = params.length
        for (const p of params) {
          if (p.updateMode === 'recompile')
            structural[p.id] = n.data.params?.[p.id] ?? p.default
        }
      }
      // Carry the param count alongside `structural` (not folded into it):
      // two instances can share identical recompile-param values while
      // differing in how many params exist (dynamicParams). Without this,
      // adding/removing a param would not change the semantic key and would
      // never trigger a recompile. Keeping the count in a sibling field
      // means a param literally named `__paramCount` can never shadow it.
      return `${n.id}:${n.data.type}:${JSON.stringify({ p: structural, n: paramCount })}`
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
      if (!def) return ''
      const params = resolveParams(def, n.data.params)
      return params
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
      if (!def) return ''
      const params = resolveParams(def, n.data.params)
      return params
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
