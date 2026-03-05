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

export const SOMBRA_FILE_VERSION = 1

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

  return {
    nodes: obj.nodes as Node<NodeData>[],
    edges: obj.edges as Edge<EdgeData>[],
  }
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
 * Compress a graph into a URL-safe base64url string.
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
 * Decode a base64url-compressed graph hash back into nodes and edges.
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
