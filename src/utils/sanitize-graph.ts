/**
 * Structural validation of a DECODED graph (security audit F3). Runs after the
 * id allow-list, on every untrusted entry point (share link, .sombra file).
 *
 * Deliberately conservative so real saved graphs never break:
 *  - hard caps on node/edge counts (a link could carry 20,000 nodes);
 *  - `__proto__` / `constructor` / `prototype` keys are never copied;
 *  - a VISIBLE param whose declared type is plainly wrong (a string in a float, an
 *    object in a bool/vec) falls back to its default; hidden storage params (image
 *    data/name, stack layers, ramp stops), unknown keys and enums are left untouched;
 *  - `imageData` that is not a safe, sane-sized image data URL is dropped.
 */
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData, NodeParameter } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'
import { isSafeImageDataUrl } from '../embed/image-guard'

export const MAX_GRAPH_NODES = 2000
export const MAX_GRAPH_EDGES = 8000

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype'])
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isNumArray = (v: unknown): v is number[] => Array.isArray(v) && v.length >= 2 && v.length <= 4 && v.every(isNum)

function fitsDeclaredType(p: NodeParameter, v: unknown): boolean {
  // Hidden params are internal storage whose declared type is a placeholder (the image
  // node keeps its picture and filename in `float`-typed hidden slots): never reset them.
  if (p.hidden) return true
  const d = p.default
  if (p.type === 'float' && typeof d === 'number') return isNum(v)
  if (p.type === 'bool' && typeof d === 'boolean') return typeof v === 'boolean'
  if ((p.type === 'vec2' || p.type === 'vec3' || p.type === 'color') && Array.isArray(d) && d.every(isNum)) return isNumArray(v)
  return true // enum, hidden/structured, anything else: leave alone
}

export function sanitizeGraph<N extends Node<NodeData>, E extends Edge<EdgeData>>(
  nodes: N[], edges: E[],
): { nodes: N[]; edges: E[] } {
  if (nodes.length > MAX_GRAPH_NODES) throw new Error(`Graph has too many nodes (${nodes.length} > ${MAX_GRAPH_NODES})`)
  if (edges.length > MAX_GRAPH_EDGES) throw new Error(`Graph has too many connections (${edges.length} > ${MAX_GRAPH_EDGES})`)
  const clean = nodes.map((n) => {
    const raw = (n.data?.params ?? {}) as Record<string, unknown>
    const def = nodeRegistry.get(n.data?.type)
    const byId = new Map((def?.params ?? []).map((p) => [p.id, p as NodeParameter]))
    const params: Record<string, unknown> = {}
    for (const key of Object.keys(raw)) {
      if (FORBIDDEN.has(key)) continue
      let v = raw[key]
      if (key === 'imageData' && v !== '' && v != null && !isSafeImageDataUrl(v)) continue
      const p = byId.get(key)
      if (p && !fitsDeclaredType(p, v)) v = Array.isArray(p.default) ? [...p.default] : p.default
      params[key] = v
    }
    return { ...n, data: { ...n.data, params } } as N
  })
  return { nodes: clean, edges }
}
