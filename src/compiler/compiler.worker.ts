/**
 * Compiler Web Worker — runs GLSL codegen off the main thread.
 * No DOM, no WebGL, no React rendering. Pure JS only.
 */

import { compileGraph } from './glsl-generator'
import type { RenderPlan } from './glsl-generator'
import { compileNodePreview } from './subgraph-compiler'
import { initializeNodeLibrary } from '../nodes'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../nodes/types'

// Populate nodeRegistry inside the Worker context (once)
initializeNodeLibrary()

export interface CompileRequest {
  type?: 'compile'
  id: string
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
}

export interface PreviewRequest {
  type: 'preview'
  id: string
  targetNodeId: string
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
}

export interface CompileResponse {
  id: string
  result?: RenderPlan
  error?: string
  durationMs: number
}

export interface PreviewResponse {
  type: 'preview'
  id: string
  targetNodeId: string
  result?: ReturnType<typeof compileNodePreview>
  error?: string
}

self.onmessage = (event: MessageEvent<CompileRequest | PreviewRequest>) => {
  const data = event.data

  if (data.type === 'preview') {
    const { id, targetNodeId, nodes, edges } = data
    try {
      const result = compileNodePreview(nodes, edges, targetNodeId)
      self.postMessage({ type: 'preview', id, targetNodeId, result } satisfies PreviewResponse)
    } catch (err) {
      self.postMessage({ type: 'preview', id, targetNodeId, error: String(err) } satisfies PreviewResponse)
    }
    return
  }

  // Default: full graph compilation
  const { id, nodes, edges } = data
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
