/**
 * renderer-driver — boots the REAL shipping renderers
 * (WebGPUShaderRenderer / WebGL2ShaderRenderer) in a headless page and measures
 * UNCAPPED sustained wall-clock FPS by driving `render()` directly.
 *
 * Why this and not the rig: the rig answers "is the WGSL efficient?" (per-pass
 * GPU ns). This answers "what does the delivered frame loop actually sustain?"
 * — through the same submit path, texture pool, and bind-group churn the app
 * uses. We bypass the shipping throttle (which lives only inside the rAF
 * callback) by calling `render()` in a tight loop, fencing each frame on
 * `queue.onSubmittedWorkDone()` (WebGPU) or a 1×1 `readPixels` (WebGL2). No rAF
 * (headless Chrome clamps/pauses it), no `startAnimation()` (throttled).
 *
 * True 4K under headless DPR=1: the canvas is appended to document.body (render()
 * reads clientWidth), sized via `canvas.style` to the target px, and the tier is
 * pinned 'high' so currentDprScale stays 1 → backing == target px. The caller
 * asserts `canvasWidth === expected`; if the GPU rejects the dimension the driver
 * reports it so the CLI can fall back to 1080 with an explicit note.
 *
 * The plan is compiled IN-PAGE from nodes+edges: the compiler's WGSL uniform
 * layout is a Map, which does not survive page.evaluate serialization, and the
 * renderer needs the real plan object anyway. This mirrors compiler.worker.ts:
 * compileGraph(nodes,edges) then attach plan.wgsl = compileGraphIR(...).passes.
 *
 * Boot scaffold copied from scripts/verify-pass-resolution-gpu.ts:886.
 */

import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright-core'
import { resolve } from 'node:path'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../../../src/nodes/types'
import type { Backend } from './perf-util'

const ROOT = resolve(import.meta.dirname, '../../..')

export interface FpsRunSpec {
  backend: Backend
  width: number
  height: number
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
  warmup?: number
  frames?: number
}

export interface FpsRunResult {
  ok: boolean
  error?: string
  frameMs: number[]
  /** Backing-store size after the first render — the 4K assertion checks this. */
  canvasWidth: number
  canvasHeight: number
  backend: Backend
}

export interface RendererDriver {
  available: { webgpu: boolean; webgl2: boolean }
  runFps(spec: FpsRunSpec): Promise<FpsRunResult>
  close(): Promise<void>
}

export async function createRendererDriver(): Promise<RendererDriver> {
  const server: ViteDevServer = await createServer({
    configFile: resolve(ROOT, 'vite.config.ts'),
    root: ROOT,
    logLevel: 'error',
    server: { port: 0, host: '127.0.0.1' },
  })
  await server.listen()
  const url = server.resolvedUrls?.local[0]
  if (!url) throw new Error('vite dev server did not report a local URL')
  const base = new URL(url).pathname.endsWith('/') ? new URL(url).pathname : `${new URL(url).pathname}/`
  const origin = new URL(url).origin

  const browser: Browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu'],
  })
  const page: Page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  page.on('pageerror', (err) => console.error('  [fps page error]', err.message))
  page.on('console', (m) => { if (m.type() === 'error') console.error('  [fps page]', m.text()) })
  // esbuild keepNames wraps named fns in __name(); Playwright ships callback
  // SOURCE to the page where that helper is absent — provide it.
  await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f)' })
  await page.route('**/__gate.html', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>perf fps gate</title>' }))
  await page.goto(`${origin}${base}__gate.html`)

  await installHarness(page, base)

  const available = await page.evaluate(async () =>
    await (window as unknown as { __fps: { available(): Promise<{ webgpu: boolean; webgl2: boolean }> } }).__fps.available())

  return {
    available,
    async runFps(spec: FpsRunSpec): Promise<FpsRunResult> {
      return await page.evaluate(
        async (p) => await (window as unknown as { __fps: { run(p: unknown): Promise<FpsRunResult> } }).__fps.run(p),
        {
          backend: spec.backend,
          width: spec.width,
          height: spec.height,
          nodes: spec.nodes,
          edges: spec.edges,
          warmup: spec.warmup ?? 30,
          frames: spec.frames ?? 180,
        },
      ) as FpsRunResult
    },
    async close() {
      await browser.close()
      await server.close()
    },
  }
}

/**
 * Install the in-page FPS harness. All src/ imports resolve on the Vite origin;
 * the plan is compiled here so its Map-valued uniform layout is real.
 */
async function installHarness(page: Page, base: string): Promise<void> {
  await page.evaluate(async (base) => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const nodesMod: any = await import(`${base}src/nodes/index.ts`)
    const glslMod: any = await import(`${base}src/compiler/glsl-generator.ts`)
    const irMod: any = await import(`${base}src/compiler/ir-compiler.ts`)
    const gpuMod: any = await import(`${base}src/webgpu/renderer.ts`)
    const glMod: any = await import(`${base}src/webgl/renderer.ts`)
    nodesMod.initializeNodeLibrary()

    function buildPlan(nodes: any, edges: any) {
      const plan = glslMod.compileGraph(nodes, edges)
      if (!plan.success) throw new Error('GLSL compile failed: ' + plan.errors.map((e: any) => e.message).join('; '))
      const ir = irMod.compileGraphIR(nodes, edges)
      if (ir) plan.wgsl = { passes: ir.passes }
      return plan
    }

    ;(window as any).__fps = {
      async available() {
        let webgpu = false, webgl2 = false
        try { webgpu = !!(navigator as any).gpu && !!(await (navigator as any).gpu.requestAdapter()) } catch { webgpu = false }
        try { webgl2 = !!document.createElement('canvas').getContext('webgl2') } catch { webgl2 = false }
        return { webgpu, webgl2 }
      },
      async run(p: any) {
        const canvas = document.createElement('canvas')
        canvas.style.width = p.width + 'px'
        canvas.style.height = p.height + 'px'
        canvas.style.position = 'fixed'
        canvas.style.left = '0'
        canvas.style.top = '0'
        document.body.appendChild(canvas)
        let renderer: any = null
        try {
          const plan = buildPlan(p.nodes, p.edges)
          renderer = p.backend === 'webgpu' ? new gpuMod.WebGPUShaderRenderer() : new glMod.WebGL2ShaderRenderer()
          await renderer.init(canvas)
          renderer.setQualityTier('high')
          const applied = renderer.updateRenderPlan(plan)
          if (!applied.success) throw new Error('updateRenderPlan failed: ' + (applied.error || '?'))

          // Fence per frame → GPU-bound measurement (no rAF vsync clamp).
          let fence: () => Promise<void>
          if (p.backend === 'webgpu') {
            const dev = renderer.getDevice()
            fence = () => dev.queue.onSubmittedWorkDone()
          } else {
            const gl = canvas.getContext('webgl2')
            const one = new Uint8Array(4)
            fence = async () => { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one) }
          }

          for (let i = 0; i < p.warmup; i++) { renderer.render(); await fence() }
          const cw = canvas.width, ch = canvas.height
          const frameMs: number[] = []
          for (let i = 0; i < p.frames; i++) {
            const t0 = performance.now()
            renderer.render()
            await fence()
            frameMs.push(performance.now() - t0)
          }
          return { ok: true, frameMs, canvasWidth: cw, canvasHeight: ch, backend: renderer.backend }
        } catch (e: any) {
          return { ok: false, error: String(e && e.message ? e.message : e), frameMs: [], canvasWidth: 0, canvasHeight: 0, backend: p.backend }
        } finally {
          try { if (renderer) renderer.dispose() } catch { /* ignore */ }
          canvas.remove()
        }
      },
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }, base)
}
