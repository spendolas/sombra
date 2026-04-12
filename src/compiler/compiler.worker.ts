/**
 * Compiler Web Worker — runs GLSL codegen off the main thread.
 * No DOM, no WebGL, no React rendering. Pure JS only.
 */

import { compileGraph } from './glsl-generator'
import type { RenderPlan } from './glsl-generator'
import { compileGraphIR } from './ir-compiler'
import { compileNodePreview } from './subgraph-compiler'
import { compileNodePreviewIR } from './ir-subgraph-compiler'
import type { IRPreviewCompilationResult } from './ir-subgraph-compiler'
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
  /** When true, also runs IR→WGSL compilation and attaches plan.wgsl. */
  useIR?: boolean
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

export interface PreviewIRRequest {
  type: 'preview-ir'
  id: string
  targetNodeId: string
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
}

/**
 * Serialized version of IRPreviewCompilationResult for postMessage.
 * UniformBufferLayout.offsets is Map<string, number> which doesn't survive
 * structured cloning — converted to Record<string, number>.
 */
export interface SerializedIRPreviewResult {
  success: boolean
  errors: Array<{ message: string; nodeId?: string }>
  isTimeLive: boolean
  outputType: string
  depthExceeded: boolean
  wgslPasses: Array<{
    shaderCode: string
    uniformLayout: {
      totalSize: number
      offsets: Record<string, number>
      struct: string
    }
    textureBindings: Array<{
      samplerName: string
      textureBinding: number
      samplerBinding: number
      group: number
    }>
    inputTextures: Array<{ passIndex: number; samplerName: string }>
    isTimeLive: boolean
    textureFilter?: 'linear' | 'nearest'
  }>
  userUniforms: Array<{
    name: string
    glslType: string
    value: number | number[]
    nodeId: string
    paramId: string
  }>
}

export interface PreviewIRResponse {
  type: 'preview-ir'
  id: string
  targetNodeId: string
  result?: SerializedIRPreviewResult
  error?: string
}

/** Convert Map<string, number> offsets to Record for postMessage. */
function serializeIRResult(result: IRPreviewCompilationResult): SerializedIRPreviewResult {
  return {
    ...result,
    wgslPasses: result.wgslPasses.map(pass => ({
      ...pass,
      uniformLayout: {
        totalSize: pass.uniformLayout.totalSize,
        offsets: Object.fromEntries(pass.uniformLayout.offsets),
        struct: pass.uniformLayout.struct,
      },
    })),
  }
}

self.onmessage = (event: MessageEvent<CompileRequest | PreviewRequest | PreviewIRRequest>) => {
  const data = event.data

  if (data.type === 'preview-ir') {
    const { id, targetNodeId, nodes, edges } = data
    try {
      const result = compileNodePreviewIR(nodes, edges, targetNodeId)
      const serialized = serializeIRResult(result)
      self.postMessage({ type: 'preview-ir', id, targetNodeId, result: serialized } satisfies PreviewIRResponse)
    } catch (err) {
      self.postMessage({ type: 'preview-ir', id, targetNodeId, error: String(err) } satisfies PreviewIRResponse)
    }
    return
  }

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

    // If IR path requested, also compile to WGSL
    if (data.useIR && result.success) {
      const wgslResult = compileGraphIR(nodes, edges)
      if (wgslResult) {
        result.wgsl = { passes: wgslResult.passes }
      }
      // If wgslResult is null (IR failure), plan.wgsl stays undefined
    }

    const durationMs = performance.now() - start
    self.postMessage({ id, result, durationMs } satisfies CompileResponse)
  } catch (err) {
    const durationMs = performance.now() - start
    self.postMessage({ id, error: String(err), durationMs } satisfies CompileResponse)
  }
}
