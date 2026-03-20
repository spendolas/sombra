/**
 * .sombra file format utilities — export, import, download, and open
 *
 * File format: { sombra: 1, nodes: [...], edges: [...] }
 * The `sombra` field is the file format version (distinct from GRAPH_SCHEMA_VERSION).
 */

import pako from 'pako'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'

export const SOMBRA_FILE_VERSION = 2

export interface SombraFile {
  sombra: number
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
}

/**
 * Wrap nodes/edges in a versioned .sombra envelope.
 */
export function exportToFile(
  nodes: Node<NodeData>[],
  edges: Edge<EdgeData>[],
): SombraFile {
  return { sombra: SOMBRA_FILE_VERSION, nodes, edges }
}

/**
 * v1 → v2 migration: invert scale values (new convention: coords /= scale)
 * and remap old param IDs to _srt_* framework params.
 */
function migrateV1ToV2(nodes: Node<NodeData>[]): Node<NodeData>[] {
  return nodes.map(node => {
    const params = { ...(node.data.params || {}) }
    const type = node.data.type

    // Noise / FBM: scale → _srt_scale (inverted)
    if (type === 'noise' || type === 'fbm') {
      if ('scale' in params) {
        const old = Number(params.scale) || 5.0
        params.srt_scale = old !== 0 ? 1 / old : 1.0
        delete params.scale
      }
    }

    // Domain Warp: frequency → _srt_scale (inverted)
    if (type === 'warp_uv' || type === 'domain_warp') {
      if ('frequency' in params) {
        const old = Number(params.frequency) || 4.0
        params.srt_scale = old !== 0 ? 1 / old : 1.0
        delete params.frequency
      }
    }

    // Pattern nodes: scale → _srt_scale (inverted)
    if (type === 'checkerboard' || type === 'dots') {
      if ('scale' in params) {
        const old = Number(params.scale) || 8.0
        params.srt_scale = old !== 0 ? 1 / old : 1.0
        delete params.scale
      }
    }

    // Stripes: scale → _srt_scale (inverted), angle → _srt_rotate (deg→rad)
    if (type === 'stripes') {
      if ('scale' in params) {
        const old = Number(params.scale) || 8.0
        params.srt_scale = old !== 0 ? 1 / old : 1.0
        delete params.scale
      }
      if ('angle' in params) {
        params.srt_rotate = Number(params.angle)  // already degrees, new SRT rotate is also degrees
        delete params.angle
      }
    }

    // UV Coordinates: scaleX/Y → _srt_scaleX/Y (inverted), rotate/offset → _srt_*
    if (type === 'uv_transform' || type === 'uv_coords') {
      if ('scaleX' in params) {
        const old = Number(params.scaleX) || 1.0
        params.srt_scaleX = old !== 0 ? 1 / old : 1.0
        delete params.scaleX
      }
      if ('scaleY' in params) {
        const old = Number(params.scaleY) || 1.0
        params.srt_scaleY = old !== 0 ? 1 / old : 1.0
        delete params.scaleY
      }
      if ('rotate' in params) {
        params.srt_rotate = Math.round(Number(params.rotate) * 180 / Math.PI)  // radians → degrees
        delete params.rotate
      }
      if ('offsetX' in params) {
        // Old offsets were in UV space; multiply by ~1000 for approximate pixel conversion
        params.srt_translateX = Math.round(Number(params.offsetX) * 1000)
        delete params.offsetX
      }
      if ('offsetY' in params) {
        params.srt_translateY = Math.round(Number(params.offsetY) * 1000)
        delete params.offsetY
      }
    }

    // Reeded Glass: slices → ribWidth, strength/edge → ior/curvature
    if (type === 'reeded_glass') {
      if ('slices' in params) {
        const old = Number(params.slices) || 12
        params.ribWidth = old > 0 ? Math.round(1000 / old) : 80
        delete params.slices
      }
      if ('strength' in params) {
        // Old strength (0-1 cosine mix) → approximate IOR
        params.ior = 1.0 + Math.abs(Number(params.strength) || 0.5)
        delete params.strength
      }
      if ('edge' in params) {
        // Old edge (0-1 compression) → approximate curvature
        params.curvature = Math.abs(Number(params.edge) || 0.3) * 2.0
        delete params.edge
      }
    }

    return { ...node, data: { ...node.data, params } }
  })
}

/**
 * Validate and unwrap a .sombra file (or bare { nodes, edges }).
 * Throws on invalid input.
 */
export function importFromFile(json: unknown): {
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
} {
  if (!json || typeof json !== 'object') {
    throw new Error('Invalid file: expected a JSON object')
  }

  const obj = json as Record<string, unknown>

  // Handle versioned envelope
  if ('sombra' in obj) {
    if (typeof obj.sombra !== 'number' || obj.sombra < 1) {
      throw new Error('Invalid file: "sombra" field must be a positive integer')
    }
    if (obj.sombra > SOMBRA_FILE_VERSION) {
      throw new Error(
        `Unsupported file version: ${obj.sombra} (max supported: ${SOMBRA_FILE_VERSION}). Update Sombra to open this file.`,
      )
    }
  }

  // Validate nodes and edges arrays
  if (!Array.isArray(obj.nodes) || !Array.isArray(obj.edges)) {
    throw new Error('Invalid file: expected "nodes" and "edges" arrays')
  }

  // Validate each node
  for (const node of obj.nodes) {
    if (!node || typeof node !== 'object') {
      throw new Error('Invalid file: each node must be an object')
    }
    const n = node as Record<string, unknown>
    if (typeof n.id !== 'string') throw new Error('Invalid file: node missing "id"')
    if (!n.position || typeof n.position !== 'object') {
      throw new Error(`Invalid file: node "${n.id}" missing "position"`)
    }
    if (!n.data || typeof n.data !== 'object') {
      throw new Error(`Invalid file: node "${n.id}" missing "data"`)
    }
    const d = n.data as Record<string, unknown>
    if (typeof d.type !== 'string') {
      throw new Error(`Invalid file: node "${n.id}" missing "data.type"`)
    }
    if (!nodeRegistry.get(d.type)) {
      throw new Error(`Invalid file: unknown node type "${d.type}" in node "${n.id}"`)
    }
  }

  // Validate each edge
  for (const edge of obj.edges) {
    if (!edge || typeof edge !== 'object') {
      throw new Error('Invalid file: each edge must be an object')
    }
    const e = edge as Record<string, unknown>
    if (typeof e.id !== 'string') throw new Error('Invalid file: edge missing "id"')
    if (typeof e.source !== 'string') throw new Error(`Invalid file: edge "${e.id}" missing "source"`)
    if (typeof e.target !== 'string') throw new Error(`Invalid file: edge "${e.id}" missing "target"`)
  }

  let nodes = obj.nodes as Node<NodeData>[]
  const edges = obj.edges as Edge<EdgeData>[]

  // v1 → v2 migration: scale convention flip + SRT param remapping
  const fileVersion = typeof obj.sombra === 'number' ? obj.sombra : 1
  if (fileVersion < 2) {
    nodes = migrateV1ToV2(nodes)
  }

  return { nodes, edges }
}

/**
 * Trigger a browser download of a .sombra file.
 */
export function downloadSombraFile(
  file: SombraFile,
  filename = 'graph.sombra',
): void {
  const blob = new Blob([JSON.stringify(file, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * Open a file picker and read a .sombra/.json file.
 * Returns the parsed JSON content.
 */
/**
 * Compress a graph into a URL-safe base64url string (legacy full format).
 */
export function encodeGraphToHash(
  nodes: Node<NodeData>[],
  edges: Edge<EdgeData>[],
): string {
  const file = exportToFile(nodes, edges)
  const json = JSON.stringify(file)
  const compressed = pako.deflate(new TextEncoder().encode(json))
  // base64url: replace +/ with -_, strip = padding
  const base64 = btoa(String.fromCharCode(...compressed))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return base64
}

/**
 * Decode a base64url-compressed graph hash back into nodes and edges (legacy full format).
 */
export function decodeGraphFromHash(hash: string): {
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
} {
  // Restore standard base64 from base64url
  let base64 = hash.replace(/-/g, '+').replace(/_/g, '/')
  // Re-add padding
  while (base64.length % 4 !== 0) base64 += '='
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const json = new TextDecoder().decode(pako.inflate(bytes))
  const parsed = JSON.parse(json)
  return importFromFile(parsed)
}

/* ------------------------------------------------------------------ */
/*  Compact URL format — strips positions, RF metadata, default params */
/* ------------------------------------------------------------------ */

interface CompactNode {
  i: string                     // id
  t: string                     // node type (e.g. 'noise')
  p?: Record<string, unknown>   // non-default params (omitted if empty)
}

interface CompactEdge {
  s: string   // source node id
  sh: string  // source handle
  t: string   // target node id
  th: string  // target handle
}

interface CompactGraph {
  v: 1
  n: CompactNode[]
  e: CompactEdge[]
}

/** Deep equality for param values (numbers, strings, arrays, plain objects) */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as Record<string, unknown>)
    const kb = Object.keys(b as Record<string, unknown>)
    if (ka.length !== kb.length) return false
    return ka.every(k => deepEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    ))
  }
  return false
}

/**
 * Encode a graph into a compact URL-safe base64url string.
 * Strips positions, RF metadata, and params that match definition defaults.
 */
export function encodeCompactHash(
  nodes: Node<NodeData>[],
  edges: Edge<EdgeData>[],
): string {
  const compactNodes: CompactNode[] = nodes.map(node => {
    const cn: CompactNode = { i: node.id, t: node.data.type }
    const params = node.data.params
    if (params && Object.keys(params).length > 0) {
      // Strip params that match definition defaults
      const def = nodeRegistry.get(node.data.type)
      const nonDefault: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(params)) {
        const paramDef = def?.params?.find(p => p.id === key)
        if (!paramDef || !deepEqual(value, paramDef.default)) {
          nonDefault[key] = value
        }
      }
      if (Object.keys(nonDefault).length > 0) {
        cn.p = nonDefault
      }
    }
    return cn
  })

  const compactEdges: CompactEdge[] = edges.map(edge => ({
    s: edge.source,
    sh: edge.sourceHandle!,
    t: edge.target,
    th: edge.targetHandle!,
  }))

  const compact: CompactGraph = { v: 1, n: compactNodes, e: compactEdges }
  const json = JSON.stringify(compact)
  const compressed = pako.deflate(new TextEncoder().encode(json))
  const base64 = btoa(String.fromCharCode(...compressed))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return base64
}

/**
 * Decode a compact base64url hash back into full React Flow nodes and edges.
 */
export function decodeCompactHash(hash: string): {
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
} {
  let base64 = hash.replace(/-/g, '+').replace(/_/g, '/')
  while (base64.length % 4 !== 0) base64 += '='
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const json = new TextDecoder().decode(pako.inflate(bytes))
  const compact = JSON.parse(json) as CompactGraph

  if (compact.v !== 1) {
    throw new Error(`Unsupported compact format version: ${compact.v}`)
  }

  // Reconstruct full nodes
  const nodes: Node<NodeData>[] = compact.n.map(cn => {
    const def = nodeRegistry.get(cn.t)
    if (!def) throw new Error(`Unknown node type "${cn.t}"`)

    // Merge definition defaults with stored non-default params
    const params: Record<string, unknown> = {}
    if (def.params) {
      for (const p of def.params) {
        if (p.default !== undefined) params[p.id] = p.default
      }
    }
    if (cn.p) Object.assign(params, cn.p)

    return {
      id: cn.i,
      type: 'shaderNode',
      position: { x: 0, y: 0 },
      data: { type: cn.t, params },
    }
  })

  // Reconstruct full edges
  const edges: Edge<EdgeData>[] = compact.e.map(ce => {
    // Resolve source port type for edge coloring
    const sourceNode = nodes.find(n => n.id === ce.s)
    let sourcePortType: string | undefined
    if (sourceNode) {
      const def = nodeRegistry.get(sourceNode.data.type)
      const port = def?.outputs.find(p => p.id === ce.sh)
      sourcePortType = port?.type
    }

    return {
      id: `${ce.s}-${ce.sh}-${ce.t}-${ce.th}`,
      source: ce.s,
      target: ce.t,
      sourceHandle: ce.sh,
      targetHandle: ce.th,
      type: 'typed',
      data: {
        sourcePort: ce.sh,
        targetPort: ce.th,
        sourcePortType,
      },
    }
  })

  return { nodes, edges }
}

export function openSombraFile(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.sombra,.json'
    input.style.display = 'none'

    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) {
        reject(new Error('No file selected'))
        return
      }

      const reader = new FileReader()
      reader.onload = () => {
        try {
          const json = JSON.parse(reader.result as string)
          resolve(json)
        } catch {
          reject(new Error('Failed to parse file as JSON'))
        }
      }
      reader.onerror = () => reject(new Error('Failed to read file'))
      reader.readAsText(file)
    })

    // Handle cancel (no file selected)
    input.addEventListener('cancel', () => {
      reject(new Error('File selection cancelled'))
    })

    document.body.appendChild(input)
    input.click()
    document.body.removeChild(input)
  })
}
