/**
 * PerfSession — the in-app perf measurement driver (Perf View, Task 3).
 *
 * A pure-TS, React-free object that owns one <canvas>, compiles a subject graph
 * (the live editor graph, a shared benchmark scene, or a single isolated node),
 * hands the plan to the shipping renderer factory, and runs an UNCAPPED render
 * loop (render → GPU fence → measure) to sample real frame timings and, on
 * WebGPU, per-pass `timestamp-query` durations.
 *
 * It is deliberately NOT the app's live-compiler: no Web Worker, no debounced
 * uniform fast path. It compiles synchronously on the calling thread (the perf
 * view is a modal tool, not the editing hot path) and drives frames itself so a
 * benchmark is bounded by the GPU, not by requestAnimationFrame's 60 Hz cap.
 *
 * RenderPlan assembly MIRRORS the app exactly (src/viewer.ts / compiler.worker):
 *   full graph → `compileGraph(nodes, edges)` produces the GLSL RenderPlan; when
 *   the WebGPU backend is targeted, `compileGraphIR(nodes, edges)` runs too and
 *   its `.passes` are attached as `plan.wgsl.passes`. The same `plan` object is
 *   then passed to BOTH `createShaderRenderer(canvas, plan, …)` (the factory
 *   reads `plan.wgsl` to decide WebGPU vs WebGL2) and `renderer.updateRenderPlan`.
 *   Isolated node → the subgraph compilers (`compileNodePreview` +
 *   `compileNodePreviewIR`) produce the same shapes, assembled into a RenderPlan.
 */

import { createShaderRenderer } from '../renderer/create-renderer'
import type { ShaderRenderer, QualityTier } from '../renderer/types'
import type { RenderPlan, RenderPass } from '../compiler/glsl-generator'
import { compileGraph } from '../compiler'
import { compileGraphIR } from '../compiler/ir-compiler'
import { compileNodePreview } from '../compiler/subgraph-compiler'
import { compileNodePreviewIR } from '../compiler/ir-subgraph-compiler'
import { useGraphStore } from '../stores/graphStore'
import { PERF_SCENES } from './scenes'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../nodes/types'

export type PerfSubject = { kind: 'live' } | { kind: 'scene'; sceneId: string }

export interface PerfConfig {
  subject: PerfSubject
  width: number
  height: number
  dpr: number
  backend: 'webgpu' | 'webgl2'
  /** When set, measure only the subgraph ending at this node id. */
  isolateNodeId?: string
}

export interface PerfSample {
  fps: number
  frameMsP50: number
  frameMsP95: number
  passCount: number
  /** Per-pass GPU durations in ns (WebGPU + timestamp-query only), else null. */
  passNs: number[] | null
  /** Sum of passNs, or null when unavailable. */
  gpuTotalNs: number | null
  timingMethod: 'timestamp-query' | 'unavailable'
}

type Graph = { nodes: Node<NodeData>[]; edges: Edge<EdgeData>[] }

const WARMUP_FRAMES = 20
const WINDOW_SIZE = 120
const EMIT_INTERVAL_MS = 250
const LIVE_RECOMPILE_DEBOUNCE_MS = 150

/** Nearest-rank percentile of an ASCENDING-sorted array. */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0
  const rank = Math.ceil(p * sortedAsc.length)
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))
  return sortedAsc[idx]
}

export class PerfSession {
  private readonly canvas: HTMLCanvasElement
  private cfg: PerfConfig | null = null
  private renderer: ShaderRenderer | null = null

  private running = false
  private loopDone: Promise<void> | null = null

  private sampleCb: ((s: PerfSample) => void) | null = null

  private frameTimes: number[] = []
  private warmupRemaining = WARMUP_FRAMES
  private lastEmit = 0
  private passCount = 0

  private unsubscribeStore: (() => void) | null = null
  private liveRecompileTimer: ReturnType<typeof setTimeout> | undefined

  /** Reused scratch for the WebGL2 readback fence. */
  private glReadPx: Uint8Array | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async start(cfg: PerfConfig): Promise<void> {
    this.cfg = { ...cfg }
    this.applyCanvasSize()
    await this.buildRendererAndPlan()
    this.reconcileLiveSubscription()
    this.startLoop()
  }

  update(partial: Partial<PerfConfig>): void {
    if (!this.cfg) {
      // No session yet — remember the config for a later start().
      this.cfg = { ...(partial as PerfConfig) }
      return
    }
    const prev = this.cfg
    const next: PerfConfig = { ...prev, ...partial }
    this.cfg = next

    const sizeChanged =
      next.width !== prev.width ||
      next.height !== prev.height ||
      next.dpr !== prev.dpr
    const backendChanged = next.backend !== prev.backend
    const subjectChanged =
      next.subject.kind !== prev.subject.kind ||
      (next.subject.kind === 'scene' &&
        prev.subject.kind === 'scene' &&
        next.subject.sceneId !== prev.subject.sceneId) ||
      next.isolateNodeId !== prev.isolateNodeId

    if (sizeChanged) this.applyCanvasSize()

    if (backendChanged) {
      // A different backend means a different renderer (and, for WebGPU, a plan
      // that carries `.wgsl`). Rebuild without tearing down the session.
      void this.rebuildRenderer()
    } else if (subjectChanged) {
      // Same renderer — a synchronous recompile + updateRenderPlan is enough.
      this.recompileAndApply()
    }

    this.reconcileLiveSubscription()
  }

  onSample(cb: (s: PerfSample) => void): void {
    this.sampleCb = cb
  }

  stop(): void {
    this.running = false
    this.teardownLiveSubscription()
  }

  dispose(): void {
    this.stop()
    // The loop reads this.renderer; let it observe running=false first, then
    // release the GPU renderer. dispose() is not awaited, so guard the loop.
    void this.finishLoopThen(() => {
      this.renderer?.dispose()
      this.renderer = null
    })
  }

  // -------------------------------------------------------------------------
  // Renderer + plan lifecycle
  // -------------------------------------------------------------------------

  private applyCanvasSize(): void {
    if (!this.cfg) return
    this.canvas.style.width = `${this.cfg.width}px`
    this.canvas.style.height = `${this.cfg.height}px`
    // The renderer derives its backing store from clientWidth * devicePixelRatio.
    // Pinning the 'high' quality tier (see buildRendererAndPlan) keeps its
    // internal dpr scale at 1.0 so the backing tracks the requested px as far as
    // the browser's own devicePixelRatio allows.
  }

  private async buildRendererAndPlan(): Promise<void> {
    if (!this.cfg) return
    const plan = this.compilePlan()
    this.passCount = this.planPassCount(plan)

    // The factory reads plan.wgsl to choose WebGPU vs WebGL2: a plan WITHOUT
    // wgsl forces the WebGL2 path (our backend:'webgl2' request); a plan WITH
    // wgsl keeps WebGPU-first. enableTimestamps only matters on WebGPU.
    this.renderer = await createShaderRenderer(this.canvas, plan, {
      enableTimestamps: this.cfg.backend === 'webgpu',
    })
    this.applyPlan(plan)
    this.resetMeasurement()
  }

  /** Stop the loop, dispose the renderer, rebuild it, and resume. */
  private async rebuildRenderer(): Promise<void> {
    const wasRunning = this.running
    await this.finishLoopThen(() => {
      this.renderer?.dispose()
      this.renderer = null
    })
    await this.buildRendererAndPlan()
    if (wasRunning) this.startLoop()
  }

  /** Recompile the current subject and push it to the existing renderer. */
  private recompileAndApply(): void {
    if (!this.renderer) return
    const plan = this.compilePlan()
    this.passCount = this.planPassCount(plan)
    this.applyPlan(plan)
    this.resetMeasurement()
  }

  private applyPlan(plan: RenderPlan): void {
    const r = this.renderer
    if (!r) return
    const res = r.updateRenderPlan(plan)
    if (!res.success) {
      console.error('[Sombra][perf] renderer rejected plan:', res.error)
      return
    }
    if (plan.userUniforms?.length) {
      r.updateUniforms(plan.userUniforms.map((u) => ({ name: u.name, value: u.value })))
    }
    // Pin a deterministic, non-throttled config: 'high' keeps the internal dpr
    // scale at 1.0, and driving frames manually means the internal animation
    // loop must stay off.
    r.setAnimated(false)
    r.setQualityTier('high' as QualityTier)
  }

  // -------------------------------------------------------------------------
  // Compilation — mirrors the app's plan assembly exactly
  // -------------------------------------------------------------------------

  private resolveGraph(): Graph {
    const subject = this.cfg!.subject
    if (subject.kind === 'live') {
      const s = useGraphStore.getState()
      return { nodes: s.nodes, edges: s.edges }
    }
    const scene = PERF_SCENES.find((sc) => sc.id === subject.sceneId)
    if (!scene) throw new Error(`[perf] unknown scene: ${subject.sceneId}`)
    return scene.build()
  }

  private compilePlan(): RenderPlan {
    const { nodes, edges } = this.resolveGraph()
    const wantWgsl = this.cfg!.backend === 'webgpu'
    // Isolate only when the target exists in the CURRENT subject's graph. A
    // stale/foreign id (e.g. a Live node id left set when switching to a scene)
    // would otherwise make the subgraph compiler throw "Target node not found"
    // and crash update(); fall back to profiling the whole subject instead.
    const id = this.cfg!.isolateNodeId
    return id && nodes.some((n) => n.id === id)
      ? this.compileIsolatedPlan(nodes, edges, id, wantWgsl)
      : this.compileFullPlan(nodes, edges, wantWgsl)
  }

  /**
   * Full-graph plan. Identical to src/viewer.ts and compiler.worker.ts:
   * `compileGraph` is the GLSL RenderPlan; when WebGPU is targeted,
   * `compileGraphIR(...).passes` is attached as `plan.wgsl.passes`.
   */
  private compileFullPlan(
    nodes: Node<NodeData>[],
    edges: Edge<EdgeData>[],
    wantWgsl: boolean,
  ): RenderPlan {
    const plan = compileGraph(nodes, edges)
    if (!plan.success) {
      throw new Error(
        `[perf] GLSL compile failed: ${plan.errors.map((e) => e.message).join('; ')}`,
      )
    }
    if (wantWgsl) {
      const ir = compileGraphIR(nodes, edges)
      if (ir) plan.wgsl = { passes: ir.passes }
    }
    return plan
  }

  /**
   * Single-node plan. The subgraph compilers return the same pass shapes as the
   * full-graph compilers (PreviewPass ≈ RenderPass, wgslPasses === WGSLPassOutput
   * === RenderPlan.wgsl.passes), so we assemble a RenderPlan-for-the-renderer the
   * same way — the main renderer's updateRenderPlan, not the preview path.
   */
  private compileIsolatedPlan(
    nodes: Node<NodeData>[],
    edges: Edge<EdgeData>[],
    targetNodeId: string,
    wantWgsl: boolean,
  ): RenderPlan {
    const glsl = compileNodePreview(nodes, edges, targetNodeId)
    if (!glsl.success) {
      throw new Error(
        `[perf] node isolation (GLSL) failed: ${glsl.errors.map((e) => e.message).join('; ')}`,
      )
    }

    const passes: RenderPass[] =
      glsl.passes.length > 0
        ? glsl.passes.map((p, i) => ({
            index: i,
            fragmentShader: p.fragmentShader,
            vertexShader: '',
            userUniforms: p.userUniforms,
            inputTextures: p.inputTextures,
            isTimeLive: glsl.isTimeLive,
            resolution: p.resolution,
          }))
        : [
            {
              index: 0,
              fragmentShader: glsl.fragmentShader,
              vertexShader: '',
              userUniforms: glsl.userUniforms,
              inputTextures: {},
              isTimeLive: glsl.isTimeLive,
            },
          ]

    const lastPass = passes[passes.length - 1]
    const plan: RenderPlan = {
      success: true,
      passes,
      errors: [],
      isTimeLiveAtOutput: glsl.isTimeLive,
      qualityTier: 'high',
      vertexShader: '',
      fragmentShader: lastPass.fragmentShader,
      userUniforms: lastPass.userUniforms,
    }

    if (wantWgsl) {
      const ir = compileNodePreviewIR(nodes, edges, targetNodeId)
      if (ir.success && ir.wgslPasses.length) {
        plan.wgsl = { passes: ir.wgslPasses }
      }
    }
    return plan
  }

  private planPassCount(plan: RenderPlan): number {
    // Count the passes the ACTIVE backend actually renders. On WebGPU that is
    // plan.wgsl.passes (which getPassTimingsNs() reports against); on WebGL2 it
    // is the GLSL passes.
    if (this.renderer?.backend === 'webgpu' && plan.wgsl?.passes?.length) {
      return plan.wgsl.passes.length
    }
    if (this.cfg?.backend === 'webgpu' && plan.wgsl?.passes?.length) {
      return plan.wgsl.passes.length
    }
    return plan.passes.length
  }

  // -------------------------------------------------------------------------
  // Uncapped render loop
  // -------------------------------------------------------------------------

  private startLoop(): void {
    if (this.running) return
    this.running = true
    this.lastEmit = performance.now()
    this.loopDone = this.loop()
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const r = this.renderer
      if (!r) break
      const t0 = performance.now()
      r.render()
      await this.fence(r)
      const dt = performance.now() - t0

      if (this.warmupRemaining > 0) {
        this.warmupRemaining--
      } else {
        this.frameTimes.push(dt)
        if (this.frameTimes.length > WINDOW_SIZE) this.frameTimes.shift()
      }

      const now = performance.now()
      if (now - this.lastEmit >= EMIT_INTERVAL_MS && this.frameTimes.length >= 2) {
        this.emitSample()
        this.lastEmit = now
      }
    }
  }

  /** Block until the just-submitted GPU work completes, so `dt` is GPU-bounded. */
  private async fence(r: ShaderRenderer): Promise<void> {
    if (r.backend === 'webgpu') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const device = (r as any).getDevice?.() as GPUDevice | undefined
      if (device) await device.queue.onSubmittedWorkDone()
      return
    }
    // WebGL2: read back one pixel from the just-drawn default framebuffer. A
    // bare gl.finish() is a no-op under some drivers (SwiftShader); a readback
    // cannot be skipped, forcing genuine GPU completion so `dt` is real.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gl = (r as any).gl as WebGL2RenderingContext | undefined
    if (gl && !this.glReadPx) this.glReadPx = new Uint8Array(4)
    if (gl && this.glReadPx) {
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.glReadPx)
    }
    // readPixels is synchronous and resolves no macrotask, so without this the
    // uncapped loop would spin on microtasks alone and starve the compositor —
    // the tab freezes while a WebGL2 subject runs. Yield one macrotask per frame
    // (~4ms browser clamp, so WebGL2 samples cap ~250fps; its wall-clock metric
    // is coarse anyway). WebGPU's onSubmittedWorkDone already yields, so it's
    // untouched and stays truly uncapped.
    await new Promise<void>((resolve) => setTimeout(resolve))
  }

  private emitSample(): void {
    const r = this.renderer
    const sorted = [...this.frameTimes].sort((a, b) => a - b)
    const p50 = percentile(sorted, 0.5)
    const p95 = percentile(sorted, 0.95)
    const fps = p50 > 0 ? 1000 / p50 : 0

    const passNs = r?.getPassTimingsNs?.() ?? null
    const gpuTotalNs = passNs ? passNs.reduce((a, b) => a + b, 0) : null
    const timingMethod: PerfSample['timingMethod'] = r?.timestampsActive?.()
      ? 'timestamp-query'
      : 'unavailable'

    this.sampleCb?.({
      fps,
      frameMsP50: p50,
      frameMsP95: p95,
      passCount: this.passCount,
      passNs,
      gpuTotalNs,
      timingMethod,
    })
  }

  private resetMeasurement(): void {
    this.frameTimes = []
    this.warmupRemaining = WARMUP_FRAMES
    this.lastEmit = performance.now()
  }

  /** Stop the loop, wait for the in-flight iteration to exit, then run `fn`. */
  private async finishLoopThen(fn: () => void): Promise<void> {
    this.running = false
    const done = this.loopDone
    this.loopDone = null
    if (done) await done
    fn()
  }

  // -------------------------------------------------------------------------
  // Live subject subscription
  // -------------------------------------------------------------------------

  private reconcileLiveSubscription(): void {
    const isLive = this.cfg?.subject.kind === 'live'
    if (isLive && !this.unsubscribeStore) {
      this.unsubscribeStore = useGraphStore.subscribe(() => this.onLiveGraphChange())
    } else if (!isLive && this.unsubscribeStore) {
      this.teardownLiveSubscription()
    }
  }

  private onLiveGraphChange(): void {
    if (this.liveRecompileTimer) clearTimeout(this.liveRecompileTimer)
    this.liveRecompileTimer = setTimeout(() => {
      this.liveRecompileTimer = undefined
      if (this.cfg?.subject.kind === 'live') this.recompileAndApply()
    }, LIVE_RECOMPILE_DEBOUNCE_MS)
  }

  private teardownLiveSubscription(): void {
    if (this.liveRecompileTimer) {
      clearTimeout(this.liveRecompileTimer)
      this.liveRecompileTimer = undefined
    }
    this.unsubscribeStore?.()
    this.unsubscribeStore = null
  }
}
