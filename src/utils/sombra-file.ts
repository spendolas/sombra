/**
 * .sombra file format utilities — export, package, import, download, and open
 *
 * Disk format: `SOMBRA\0` magic + package version byte + deflated JSON payload.
 * Payload: { sombra: 2, nodes: [...], edges: [...] }
 * The package version and `sombra` schema version are independent; both are
 * distinct from GRAPH_SCHEMA_VERSION. Legacy plain-JSON files remain readable.
 */

import pako from 'pako'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'

export const SOMBRA_FILE_VERSION = 2
export const SOMBRA_PACKAGE_VERSION = 1

const SOMBRA_PACKAGE_MAGIC = new Uint8Array([
  0x53, 0x4f, 0x4d, 0x42, 0x52, 0x41, 0x00, // `SOMBRA\0`
])
const SOMBRA_PACKAGE_HEADER_SIZE = SOMBRA_PACKAGE_MAGIC.length + 1

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

function hasPackageMagic(bytes: Uint8Array): boolean {
  return bytes.length >= SOMBRA_PACKAGE_MAGIC.length
    && SOMBRA_PACKAGE_MAGIC.every((byte, index) => bytes[index] === byte)
}

/** Encode an editable graph as the binary on-disk `.sombra` package. */
export function encodeSombraPackage(file: SombraFile): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(file))
  const payload = pako.deflate(json)
  const packaged = new Uint8Array(SOMBRA_PACKAGE_HEADER_SIZE + payload.length)
  packaged.set(SOMBRA_PACKAGE_MAGIC)
  packaged[SOMBRA_PACKAGE_MAGIC.length] = SOMBRA_PACKAGE_VERSION
  packaged.set(payload, SOMBRA_PACKAGE_HEADER_SIZE)
  return packaged
}

/**
 * Decode a binary `.sombra` package. Plain UTF-8 JSON is accepted as a legacy
 * fallback so every file saved before the package layer remains importable.
 */
export function decodeSombraPackage(data: ArrayBuffer | Uint8Array): unknown {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)

  if (hasPackageMagic(bytes)) {
    if (bytes.length < SOMBRA_PACKAGE_HEADER_SIZE) {
      throw new Error('Invalid .sombra package: truncated header')
    }
    const packageVersion = bytes[SOMBRA_PACKAGE_MAGIC.length]
    if (packageVersion !== SOMBRA_PACKAGE_VERSION) {
      throw new Error(
        `Unsupported .sombra package version: ${packageVersion} (max supported: ${SOMBRA_PACKAGE_VERSION})`,
      )
    }
    if (bytes.length === SOMBRA_PACKAGE_HEADER_SIZE) {
      throw new Error('Invalid .sombra package: missing payload')
    }

    try {
      const json = pako.inflate(bytes.subarray(SOMBRA_PACKAGE_HEADER_SIZE), { to: 'string' })
      return JSON.parse(json)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Invalid .sombra package payload: ${detail}`)
    }
  }

  try {
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return JSON.parse(json)
  } catch {
    throw new Error('Invalid file: expected a .sombra package or JSON document')
  }
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

    // Domain Warp / Warp: frequency → _srt_scale (inverted)
    if (type === 'warp_uv' || type === 'domain_warp' || type === 'warp') {
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
        params.srt_rotate = Number(params.angle) || 0  // already degrees, new SRT rotate is also degrees
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

  // Migrate renamed node types before validation
  const TYPE_RENAMES: Record<string, string> = {
    'warp_uv': 'warp',
    'domain_warp': 'warp',
    'quantize_uv': 'pixelate',
    'quantize': 'pixelate',
    'uv_coords': 'uv_transform',
    'pixel_grid': 'dither',
  }
  for (const node of obj.nodes) {
    if (node && typeof node === 'object') {
      const d = (node as Record<string, unknown>).data as Record<string, unknown> | undefined
      if (d && typeof d.type === 'string' && d.type in TYPE_RENAMES) {
        d.type = TYPE_RENAMES[d.type]
      }
    }
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

  // Merge definition defaults for params added after the file was saved —
  // mirrors decodeCompactHash; without this a missing param arrives undefined
  // and bakes NaN/fallback garbage into generated shaders.
  nodes = nodes.map((node) => {
    const def = nodeRegistry.get(node.data.type)
    if (!def) return node
    const params = { ...(node.data.params || {}) }
    for (const p of def.params ?? []) {
      if (!(p.id in params)) params[p.id] = p.default
    }
    return { ...node, data: { ...node.data, params } }
  })

  // Strip edges pointing at handles that no longer exist (mirrors the
  // localStorage migrate path — old files may reference removed ports).
  const validEdges = edges.filter((e) => {
    const src = nodes.find((n) => n.id === e.source)
    const tgt = nodes.find((n) => n.id === e.target)
    if (!src || !tgt) return false
    const srcDef = nodeRegistry.get(src.data.type)
    const tgtDef = nodeRegistry.get(tgt.data.type)
    if (!srcDef || !tgtDef) return false
    const srcOk = !e.sourceHandle || srcDef.outputs.some((p) => p.id === e.sourceHandle)
    const tgtInputs = tgtDef.dynamicInputs ? tgtDef.dynamicInputs(tgt.data.params || {}) : tgtDef.inputs
    const tgtOk = !e.targetHandle
      || tgtInputs.some((p) => p.id === e.targetHandle)
      || (tgtDef.params ?? []).some((p) => p.connectable && p.id === e.targetHandle)
    return srcOk && tgtOk
  })

  return { nodes, edges: validEdges }
}

/**
 * Trigger a browser download of a .sombra file.
 */
export function downloadSombraFile(
  file: SombraFile,
  filename = 'graph.sombra',
): void {
  const blob = new Blob([encodeSombraPackage(file)], {
    type: 'application/octet-stream',
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
 * Compress a graph into a URL-safe base64url string (legacy full format).
 */
/**
 * Uint8Array → base64url. Chunked: `String.fromCharCode(...arr)` spreads the
 * whole buffer as call arguments and throws RangeError past ~64k elements
 * (e.g. graphs with image data).
 */
function toBase64Url(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export function encodeGraphToHash(
  nodes: Node<NodeData>[],
  edges: Edge<EdgeData>[],
): string {
  const file = exportToFile(nodes, edges)
  const json = JSON.stringify(file)
  const compressed = pako.deflate(new TextEncoder().encode(json))
  return toBase64Url(compressed)
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
  // Strip disconnected nodes — they don't affect the output. Fragment Output
  // is always kept: dropping it when unwired turned the share link into a
  // confusing viewer compile error, and it carries renderer settings
  // (anchor/quality) besides.
  const connectedIds = new Set<string>()
  for (const e of edges) { connectedIds.add(e.source); connectedIds.add(e.target) }
  const connectedNodes = nodes.filter(
    n => connectedIds.has(n.id) || n.data.type === 'fragment_output'
  )

  const compactNodes: CompactNode[] = connectedNodes.map(node => {
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
  return toBase64Url(compressed)
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

/**
 * Open a file picker and read a binary .sombra package or legacy JSON file.
 * Returns the decoded payload object.
 */
export function openSombraFile(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.sombra,.json'
    input.hidden = true

    let settled = false
    const finish = (result: { value: unknown } | { error: Error }) => {
      if (settled) return
      settled = true
      input.remove()
      if ('error' in result) reject(result.error)
      else resolve(result.value)
    }

    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) {
        finish({ error: new Error('File selection cancelled') })
        return
      }

      const reader = new FileReader()
      reader.onload = () => {
        try {
          if (!(reader.result instanceof ArrayBuffer)) {
            throw new Error('Failed to read file as binary data')
          }
          finish({ value: decodeSombraPackage(reader.result) })
        } catch (error) {
          finish({
            error: error instanceof Error ? error : new Error('Failed to decode file'),
          })
        }
      }
      reader.onerror = () => finish({ error: new Error('Failed to read file') })
      reader.readAsArrayBuffer(file)
    })

    // Handle cancel (no file selected)
    input.addEventListener('cancel', () => {
      finish({ error: new Error('File selection cancelled') })
    })

    // Keep the input connected until the picker resolves. Removing it directly
    // after click() detaches the event target while the native picker is open;
    // Chrome and Safari may then drop the eventual change event entirely.
    document.body.appendChild(input)
    input.click()
  })
}
