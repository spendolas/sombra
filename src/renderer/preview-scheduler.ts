/**
 * Preview scheduler — orchestrates subgraph compilation (via Worker)
 * and rendering (via PreviewRenderer) for per-node thumbnails.
 *
 * Batches up to 4 stale nodes per animation frame within an 8ms budget.
 * Uses fine-grained staleness detection to avoid recompiling unchanged nodes.
 *
 * Supports both WebGL2 (GLSL) and WebGPU (WGSL/IR) preview paths.
 */

import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'
import type { PreviewResponse, PreviewIRResponse, SerializedIRPreviewResult } from '../compiler/compiler.worker'
import type { PreviewRenderer, UniformUpload } from './types'
import type { WebGPUPreviewRenderer, WGSLPreviewPass } from '../webgpu/preview-renderer'
import type { UniformBufferLayout, TextureBinding } from '../compiler/ir/wgsl-assembler'
import { usePreviewStore } from '../stores/previewStore'
import CompilerWorker from '../compiler/compiler.worker?worker'

// ---------------------------------------------------------------------------
// Cached shader types — discriminated by backend
// ---------------------------------------------------------------------------

interface CachedShaderWebGL2 {
  backend: 'webgl2'
  fragmentShader: string
  uniforms: UniformUpload[]
  isTimeLive: boolean
  passes?: Array<{ fragmentShader: string; uniforms: UniformUpload[]; inputTextures: Record<string, number> }>
  depthExceeded?: boolean
}

interface CachedShaderWebGPU {
  backend: 'webgpu'
  wgslPasses: WGSLPreviewPass[]
  isTimeLive: boolean
  depthExceeded?: boolean
}

type CachedShader = CachedShaderWebGL2 | CachedShaderWebGPU

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class PreviewScheduler {
  private renderer: PreviewRenderer
  private isWebGPU: boolean
  private worker: Worker
  private rafId: number | null = null
  private running = false

  // Current graph snapshot
  private nodes: Node<NodeData>[] = []
  private edges: Edge<EdgeData>[] = []

  // Staleness tracking
  private staleNodes = new Set<string>()
  private pendingCompile = new Set<string>() // nodes awaiting Worker response

  // Dependency map: nodeId → set of downstream nodeIds
  private downstreamMap = new Map<string, Set<string>>()

  // Previous graph state for fine-grained staleness detection
  private prevEdges: Edge<EdgeData>[] = []
  private prevNodeMap = new Map<string, Node<NodeData>>()

  // Cached shaders: nodeId → CachedShader
  private shaderCache = new Map<string, CachedShader>()

  // Compile request counter for staleness
  private compileIdCounter = 0

  // Time-dependent nodes: re-render periodically
  private timeLiveNodes = new Set<string>()
  private lastAnimatedRender = 0
  private readonly BASE_ANIMATED_INTERVAL = 200 // 5 FPS at small canvas sizes

  // Canvas dimension hint for adaptive throttling
  private canvasMaxDimension = 0

  constructor(renderer: PreviewRenderer) {
    this.renderer = renderer
    this.isWebGPU = renderer.backend === 'webgpu'
    this.worker = new CompilerWorker()
    this.worker.onmessage = this.onWorkerMessage.bind(this)
  }

  /**
   * Called when the graph changes. Rebuilds dependency map and marks affected nodes stale.
   * Uses fine-grained detection: only marks nodes stale when edges or params actually change.
   */
  onGraphChange(nodes: Node<NodeData>[], edges: Edge<EdgeData>[]) {
    const prevNodeIds = new Set(this.nodes.map(n => n.id))
    this.nodes = nodes
    this.edges = edges
    this.rebuildDownstreamMap()

    // Determine which nodes changed
    const currentNodeIds = new Set(nodes.map(n => n.id))

    // Removed nodes — clean up
    for (const oldId of prevNodeIds) {
      if (!currentNodeIds.has(oldId)) {
        this.staleNodes.delete(oldId)
        this.shaderCache.delete(oldId)
        this.timeLiveNodes.delete(oldId)
      }
    }

    // Detect edge changes (added/removed connections)
    const prevEdgeKey = (e: Edge<EdgeData>) => `${e.source}:${e.sourceHandle}->${e.target}:${e.targetHandle}`
    const prevEdgeSet = new Set(this.prevEdges.map(prevEdgeKey))
    const currEdgeSet = new Set(edges.map(prevEdgeKey))

    const addedEdges = edges.filter(e => !prevEdgeSet.has(prevEdgeKey(e)))
    const removedEdges = this.prevEdges.filter(e => !currEdgeSet.has(prevEdgeKey(e)))

    // Mark affected nodes stale (source and target of changed edges + their downstream)
    for (const e of [...addedEdges, ...removedEdges]) {
      this.markStaleWithDownstream(e.source)
      this.markStaleWithDownstream(e.target)
    }

    // Detect node additions and param changes
    for (const node of nodes) {
      if (node.data.type === 'fragment_output') continue
      const prev = this.prevNodeMap.get(node.id)
      if (!prev) {
        // New node
        this.markStaleWithDownstream(node.id)
      } else if (prev.data !== node.data) {
        // Data reference changed (Zustand immutability) — params changed
        this.markStaleWithDownstream(node.id)
      }
    }

    // Final cleanup: remove stale/pending entries for nodes no longer in the graph.
    // This handles clearGraph() where edge removal re-marks deleted nodes as stale.
    for (const id of [...this.staleNodes]) {
      if (!currentNodeIds.has(id)) this.staleNodes.delete(id)
    }
    for (const id of [...this.pendingCompile]) {
      if (!currentNodeIds.has(id)) this.pendingCompile.delete(id)
    }

    // Save current state for next comparison
    this.prevEdges = edges
    this.prevNodeMap = new Map(nodes.map(n => [n.id, n]))
  }

  /**
   * Mark a node and all its downstream dependents as stale.
   */
  private markStaleWithDownstream(nodeId: string) {
    this.staleNodes.add(nodeId)
    this.shaderCache.delete(nodeId)
    const downstream = this.downstreamMap.get(nodeId)
    if (downstream) {
      for (const id of downstream) {
        this.staleNodes.add(id)
        this.shaderCache.delete(id)
      }
    }
  }

  /**
   * Build downstream dependency map from edges.
   * For each node, find all nodes that transitively depend on it.
   */
  private rebuildDownstreamMap() {
    // Build direct forward adjacency: source → targets
    const forwardAdj = new Map<string, Set<string>>()
    for (const edge of this.edges) {
      if (!forwardAdj.has(edge.source)) forwardAdj.set(edge.source, new Set())
      forwardAdj.get(edge.source)!.add(edge.target)
    }

    // For each node, BFS/DFS forward to find all transitive downstream nodes
    this.downstreamMap.clear()
    for (const node of this.nodes) {
      const visited = new Set<string>()
      const queue = [node.id]
      while (queue.length) {
        const current = queue.pop()!
        const targets = forwardAdj.get(current)
        if (targets) {
          for (const t of targets) {
            if (!visited.has(t)) {
              visited.add(t)
              queue.push(t)
            }
          }
        }
      }
      if (visited.size > 0) {
        this.downstreamMap.set(node.id, visited)
      }
    }
  }

  /**
   * Handle compilation result from the Worker.
   */
  private async onWorkerMessage(event: MessageEvent<PreviewResponse | PreviewIRResponse>) {
    const data = event.data

    if (data.type === 'preview-ir') {
      await this.handleIRPreviewResult(data)
      return
    }

    if (data.type === 'preview') {
      await this.handleGLSLPreviewResult(data)
      return
    }
  }

  /**
   * Handle GLSL preview compilation result (WebGL2 path).
   */
  private async handleGLSLPreviewResult(data: PreviewResponse) {
    const { targetNodeId, result } = data
    this.pendingCompile.delete(targetNodeId)

    if (!result || !result.success) {
      console.warn(`[preview] compile failed for ${targetNodeId}`, result?.errors || 'no result')
      this.staleNodes.delete(targetNodeId)
      return
    }

    // Cache the shader (including multi-pass data)
    const passes = result.passes?.length
      ? result.passes.map(p => ({
          fragmentShader: p.fragmentShader,
          uniforms: p.userUniforms.map(u => ({ name: u.name, value: u.value })),
          inputTextures: p.inputTextures,
        }))
      : undefined
    const cached: CachedShaderWebGL2 = {
      backend: 'webgl2',
      fragmentShader: result.fragmentShader,
      uniforms: result.userUniforms.map(u => ({ name: u.name, value: u.value })),
      isTimeLive: result.isTimeLive,
      passes,
      depthExceeded: result.depthExceeded,
    }
    this.shaderCache.set(targetNodeId, cached)

    if (result.isTimeLive) {
      this.timeLiveNodes.add(targetNodeId)
    } else {
      this.timeLiveNodes.delete(targetNodeId)
    }

    if (cached.depthExceeded) {
      console.warn(`[preview] depth exceeded for ${targetNodeId}`)
      this.staleNodes.delete(targetNodeId)
      return
    }

    // Render
    const bitmap = await this.renderCached(targetNodeId, cached)
    if (bitmap) {
      usePreviewStore.getState().setPreview(targetNodeId, bitmap)
    } else {
      console.warn(`[preview] render returned null for ${targetNodeId}`)
    }
    this.staleNodes.delete(targetNodeId)
  }

  /**
   * Handle IR/WGSL preview compilation result (WebGPU path).
   */
  private async handleIRPreviewResult(data: PreviewIRResponse) {
    const { targetNodeId, result } = data
    this.pendingCompile.delete(targetNodeId)

    if (!result || !result.success) {
      console.warn(`[preview-ir] compile failed for ${targetNodeId}`, result?.errors || 'no result')
      this.staleNodes.delete(targetNodeId)
      return
    }

    if (result.depthExceeded) {
      console.warn(`[preview-ir] depth exceeded for ${targetNodeId}`)
      this.staleNodes.delete(targetNodeId)
      return
    }

    // Deserialize and cache
    const wgslPasses = deserializeWGSLPasses(result)
    const cached: CachedShaderWebGPU = {
      backend: 'webgpu',
      wgslPasses,
      isTimeLive: result.isTimeLive,
      depthExceeded: result.depthExceeded,
    }
    this.shaderCache.set(targetNodeId, cached)

    if (result.isTimeLive) {
      this.timeLiveNodes.add(targetNodeId)
    } else {
      this.timeLiveNodes.delete(targetNodeId)
    }

    // Render
    const bitmap = await this.renderCached(targetNodeId, cached)
    if (bitmap) {
      usePreviewStore.getState().setPreview(targetNodeId, bitmap)
    } else {
      console.warn(`[preview-ir] render returned null for ${targetNodeId}`)
    }
    this.staleNodes.delete(targetNodeId)
  }

  /**
   * Render from cached data — dispatches to the correct backend method.
   */
  private async renderCached(_nodeId: string, cached: CachedShader): Promise<ImageBitmap | null> {
    if (cached.backend === 'webgpu') {
      const gpuRenderer = this.renderer as WebGPUPreviewRenderer
      return gpuRenderer.renderWGSLPreview(cached.wgslPasses)
    }

    // WebGL2 path
    if (cached.passes && cached.passes.length > 1) {
      return this.renderer.renderMultiPassPreview(cached.passes)
    }
    return this.renderer.renderPreview(cached.fragmentShader, cached.uniforms)
  }

  /**
   * Animation frame tick. Batches multiple stale nodes per frame within a time budget.
   */
  private tick = async () => {
    if (!this.running) return
    this.rafId = requestAnimationFrame(this.tick)

    const now = performance.now()

    // Re-render time-dependent nodes periodically (adaptive interval based on canvas size)
    if (now - this.lastAnimatedRender > this.animatedInterval) {
      this.lastAnimatedRender = now
      const batch = new Map<string, ImageBitmap>()
      for (const nodeId of this.timeLiveNodes) {
        const cached = this.shaderCache.get(nodeId)
        if (!cached || cached.depthExceeded) continue
        const bitmap = await this.renderCached(nodeId, cached)
        if (bitmap) {
          batch.set(nodeId, bitmap)
        }
      }
      if (batch.size > 0) {
        usePreviewStore.getState().setBatchPreviews(batch)
      }
    }

    // Batch multiple stale nodes per frame within a time budget
    const FRAME_BUDGET_MS = 8
    // Remove hidePreview nodes from stale set
    for (const nodeId of [...this.staleNodes]) {
      const nodeType = this.prevNodeMap.get(nodeId)?.data?.type
      if (nodeType && nodeRegistry.get(nodeType)?.hidePreview) this.staleNodes.delete(nodeId)
    }

    const frameStart = performance.now()
    let dispatched = 0
    for (const nodeId of [...this.staleNodes]) {
      if (performance.now() - frameStart > FRAME_BUDGET_MS) break
      if (this.pendingCompile.has(nodeId)) continue

      // Request compilation from Worker
      this.pendingCompile.add(nodeId)
      const id = `preview-${++this.compileIdCounter}`

      if (this.isWebGPU) {
        this.worker.postMessage({
          type: 'preview-ir',
          id,
          targetNodeId: nodeId,
          nodes: this.nodes,
          edges: this.edges,
        })
      } else {
        this.worker.postMessage({
          type: 'preview',
          id,
          targetNodeId: nodeId,
          nodes: this.nodes,
          edges: this.edges,
        })
      }

      dispatched++
      if (dispatched >= 4) break // Cap at 4 per frame
    }
  }

  /**
   * Forward the main canvas resolution to the preview renderer
   * so pixel-based params (e.g. ribWidth) compute correct UV fractions.
   */
  setMainResolution(width: number, height: number) {
    this.renderer.setMainResolution(width, height)
    this.canvasMaxDimension = Math.max(width, height)
  }

  /** Adaptive refresh interval — slower thumbnails at large canvas sizes to stay in frame budget. */
  private get animatedInterval(): number {
    if (this.canvasMaxDimension > 1500) return 1000
    if (this.canvasMaxDimension > 800) return 500
    return this.BASE_ANIMATED_INTERVAL
  }

  start() {
    if (this.running) return
    this.running = true
    this.rafId = requestAnimationFrame(this.tick)
  }

  stop() {
    this.running = false
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }

  destroy() {
    this.stop()
    this.worker.terminate()
    this.shaderCache.clear()
    this.staleNodes.clear()
    this.pendingCompile.clear()
    this.timeLiveNodes.clear()
    usePreviewStore.getState().clearAll()
  }
}

// ---------------------------------------------------------------------------
// Deserialization helpers (Map reconstruction from worker postMessage)
// ---------------------------------------------------------------------------

/**
 * Deserialize the serialized IR preview result from the worker
 * into WGSLPreviewPass[] with proper Map offsets.
 */
function deserializeWGSLPasses(result: SerializedIRPreviewResult): WGSLPreviewPass[] {
  return result.wgslPasses.map((pass) => {
    // Reconstruct Map from Record
    const offsets = new Map<string, number>(Object.entries(pass.uniformLayout.offsets))
    const uniformLayout: UniformBufferLayout = {
      totalSize: pass.uniformLayout.totalSize,
      offsets,
      struct: pass.uniformLayout.struct,
    }

    // Collect user uniforms for this pass from the result
    // User uniforms are global in the result — filter to those present in this pass's layout
    const passUserUniforms: UniformUpload[] = result.userUniforms
      .filter(u => offsets.has(u.name))
      .map(u => ({ name: u.name, value: u.value }))

    const textureBindings: TextureBinding[] = pass.textureBindings

    return {
      shaderCode: pass.shaderCode,
      uniformLayout,
      textureBindings,
      inputTextures: pass.inputTextures,
      userUniforms: passUserUniforms,
    }
  })
}
