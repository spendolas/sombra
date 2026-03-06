/**
 * Compiler Web Worker — runs GLSL codegen off the main thread.
 * No DOM, no WebGL, no React rendering. Pure JS only.
 */

import { compileGraph } from './glsl-generator'
import { initializeNodeLibrary } from '../nodes'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../nodes/types'

// Populate nodeRegistry inside the Worker context (once)
initializeNodeLibrary()

export interface CompileRequest {
  id: string
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
}

export interface CompileResponse {
  id: string
  result?: ReturnType<typeof compileGraph>
  error?: string
  durationMs: number
}

self.onmessage = (event: MessageEvent<CompileRequest>) => {
  const { id, nodes, edges } = event.data
  const start = performance.now()
  try {
    const result = compileGraph(nodes, edges)
    const durationMs = performance.now() - start
    self.postMessage({ id, result, durationMs } satisfies CompileResponse)
  } catch (err) {
    const durationMs = performance.now() - start
    self.postMessage({ id, error: String(err), durationMs } satisfies CompileResponse)
  }
}
