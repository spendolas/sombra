/**
 * Preview scheduler — orchestrates subgraph compilation (via Worker)
 * and rendering (via PreviewRenderer) for per-node thumbnails.
 *
 * Processes one stale node per animation frame to stay within budget.
 */

import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../nodes/types'
import type { PreviewResponse } from '../compiler/compiler.worker'
import type { PreviewRenderer, UniformUpload } from './preview-renderer'
import { usePreviewStore } from '../stores/previewStore'
import CompilerWorker from '../compiler/compiler.worker?worker'

export class PreviewScheduler {
  private renderer: PreviewRenderer
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

  // Cached shaders: nodeId → { fragmentShader, uniforms, isTimeLive }
  private shaderCache = new Map<string, {
    fragmentShader: string
    uniforms: UniformUpload[]
    isTimeLive: boolean
  }>()

  // Compile request counter for staleness
  private compileIdCounter = 0

  // Time-dependent nodes: re-render periodically
  private timeLiveNodes = new Set<string>()
  private lastAnimatedRender = 0
  private readonly ANIMATED_INTERVAL = 100 // 10 FPS

  constructor(renderer: PreviewRenderer) {
    this.renderer = renderer
    this.worker = new CompilerWorker()
    this.worker.onmessage = this.onWorkerMessage.bind(this)
  }

  /**
   * Called when the graph changes. Rebuilds dependency map and marks affected nodes stale.
   */
  onGraphChange(nodes: Node<NodeData>[], edges: Edge<EdgeData>[]) {
    const prevNodeIds = new Set(this.nodes.map(n => n.id))
    this.nodes = nodes
    this.edges = edges
    this.rebuildDownstreamMap()

    // Determine which nodes changed
    const currentNodeIds = new Set(nodes.map(n => n.id))

    // New nodes or nodes with changed params → mark stale + downstream
    for (const node of nodes) {
      if (node.data.type === 'fragment_output') continue
      if (!prevNodeIds.has(node.id)) {
        // New node
        this.markStaleWithDownstream(node.id)
      }
    }

    // Removed nodes — clean up
    for (const oldId of prevNodeIds) {
      if (!currentNodeIds.has(oldId)) {
        this.staleNodes.delete(oldId)
        this.shaderCache.delete(oldId)
        this.timeLiveNodes.delete(oldId)
      }
    }

    // Mark all nodes as stale on graph change (simple, correct)
    // The scheduler will lazily re-render them
    for (const node of nodes) {
      if (node.data.type === 'fragment_output') continue
      this.staleNodes.add(node.id)
    }
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
  private onWorkerMessage(event: MessageEvent<PreviewResponse>) {
    const data = event.data
    if (data.type !== 'preview') return

    const { targetNodeId, result } = data
    this.pendingCompile.delete(targetNodeId)

    if (!result || !result.success) return

    // Cache the shader
    const cached = {
      fragmentShader: result.fragmentShader,
      uniforms: result.userUniforms.map(u => ({ name: u.name, value: u.value })),
      isTimeLive: result.isTimeLive,
    }
    this.shaderCache.set(targetNodeId, cached)

    if (result.isTimeLive) {
      this.timeLiveNodes.add(targetNodeId)
    } else {
      this.timeLiveNodes.delete(targetNodeId)
    }

    // Render immediately
    const dataUrl = this.renderer.renderPreview(cached.fragmentShader, cached.uniforms)
    if (dataUrl) {
      usePreviewStore.getState().setPreview(targetNodeId, dataUrl)
    }
    this.staleNodes.delete(targetNodeId)
  }

  /**
   * Animation frame tick. Processes one stale node per frame.
   */
  private tick = () => {
    if (!this.running) return
    this.rafId = requestAnimationFrame(this.tick)

    const now = performance.now()

    // Re-render time-dependent nodes periodically
    if (now - this.lastAnimatedRender > this.ANIMATED_INTERVAL) {
      this.lastAnimatedRender = now
      for (const nodeId of this.timeLiveNodes) {
        const cached = this.shaderCache.get(nodeId)
        if (cached) {
          const dataUrl = this.renderer.renderPreview(cached.fragmentShader, cached.uniforms)
          if (dataUrl) {
            usePreviewStore.getState().setPreview(nodeId, dataUrl)
          }
        }
      }
    }

    // Pick one stale node to compile (skip nodes already pending)
    for (const nodeId of this.staleNodes) {
      if (this.pendingCompile.has(nodeId)) continue

      // Request compilation from Worker
      this.pendingCompile.add(nodeId)
      const id = `preview-${++this.compileIdCounter}`
      this.worker.postMessage({
        type: 'preview',
        id,
        targetNodeId: nodeId,
        nodes: this.nodes,
        edges: this.edges,
      })
      break // One per frame
    }
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
