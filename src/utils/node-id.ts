/**
 * Unique node-id generation and repair.
 *
 * Node ids MUST be globally unique for the lifetime of a graph. Every
 * downstream identifier is derived from the node id:
 *   - preview-store key (`previews[nodeId]`, ShaderNode.tsx)
 *   - generated GLSL/WGSL uniform names (`u_<sanitizedId>_<param>`) and
 *     variable names (`node_<sanitizedId>_<port>`, `srt_<sanitizedId>`)
 *   - the fast-path uniform routing key and the renderer's uniform
 *     location / buffer-offset maps
 *
 * Two nodes sharing an id therefore collapse to ONE everywhere: the compiler's
 * `topologicalSort` visited-set and both codegen paths'
 * `new Map(nodes.map(n => [n.id, n]))` keep only the last node with that id, so
 * one node silently drives the other's math (entanglement) and both node cards
 * read the same `previews[id]` bitmap (wrong-preview). It is silent — not a
 * compile error — because the pair is collapsed before any identifier is
 * emitted.
 *
 * The old scheme `${type}-${Date.now()}` collided whenever two same-type nodes
 * were minted within the same millisecond (rapid add, programmatic/loop
 * creation, or a graph persisted before this fix). This module replaces it with
 * a uuid suffix.
 */

import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../nodes/types'

let _fallbackCounter = 0

/** A collision-proof unique token. Prefers crypto.randomUUID; falls back to a
 *  timestamp + monotonic counter + random suffix for environments without it
 *  (e.g. non-secure contexts, older Safari). */
function uniqueToken(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `${Date.now().toString(36)}-${(++_fallbackCounter).toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`
}

/**
 * Mint a unique id for a new node of the given type.
 *
 * Format `${type}-${uuid}`: the readable type prefix is kept because it flows
 * into generated shader variable names and the node-id ↔ shader-error mapping,
 * while the uuid guarantees uniqueness. The uuid's hyphens are sanitized to
 * underscores downstream (`id.replace(/-/g, '_')`), which stays a valid
 * identifier.
 */
export function makeNodeId(type: string): string {
  return `${type}-${uniqueToken()}`
}

/**
 * Repair a graph that already contains duplicate node ids (produced by the old
 * `${type}-${Date.now()}` scheme before the uuid fix, and persisted to
 * localStorage / a `.sombra` file / a share URL).
 *
 * Keeps the FIRST node seen at each id and reassigns every later duplicate a
 * fresh unique id. Edges are left untouched: they bind to the surviving first
 * occurrence (the compiler already collapsed a pre-fix duplicate pair to a
 * single node, so there is no distinct edge set to recover — the reassigned
 * node simply becomes a clean, unconnected copy that the user can rewire).
 *
 * Returns the SAME array references when there is nothing to repair, so callers
 * can cheaply detect a no-op (`result.nodes === nodes`).
 */
export function dedupeNodeIds(
  nodes: Node<NodeData>[],
  edges: Edge<EdgeData>[],
): { nodes: Node<NodeData>[]; edges: Edge<EdgeData>[]; repaired: number } {
  const seen = new Set<string>()
  let repaired = 0
  const out = nodes.map((n) => {
    if (!seen.has(n.id)) {
      seen.add(n.id)
      return n
    }
    // Duplicate id — reassign. Guard against the (astronomically unlikely)
    // event that a freshly-minted id also collides.
    let newId = makeNodeId(n.data.type)
    while (seen.has(newId)) newId = makeNodeId(n.data.type)
    seen.add(newId)
    repaired++
    return { ...n, id: newId }
  })
  return repaired ? { nodes: out, edges, repaired } : { nodes, edges, repaired: 0 }
}

/**
 * Ids and port handles are spliced into generated shader text
 * (`node_<id>_<port>`, `u_<id>_<param>`), and the compilers only replace `-`
 * with `_`. An id from untrusted input (share link, .sombra file) containing
 * `;`, `}`, `//` etc. would therefore inject arbitrary code into the shader.
 * This is the single allow-list every entry point enforces.
 */
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && SAFE_ID_RE.test(id)
}

/** Throws if any node id or edge endpoint/handle is not shader-identifier safe. */
export function assertSafeGraphIds(
  nodes: readonly { id: string }[],
  edges: readonly { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }[],
): void {
  for (const n of nodes) {
    if (!isSafeId(n.id)) throw new Error(`Unsafe node id: ${JSON.stringify(String(n.id)).slice(0, 60)}`)
  }
  for (const e of edges) {
    if (!isSafeId(e.source) || !isSafeId(e.target)) throw new Error('Unsafe edge endpoint id')
    for (const h of [e.sourceHandle, e.targetHandle]) {
      if (h != null && !isSafeId(h)) throw new Error(`Unsafe port handle: ${JSON.stringify(String(h)).slice(0, 60)}`)
    }
  }
}
