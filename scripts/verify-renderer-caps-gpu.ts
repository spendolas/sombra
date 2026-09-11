/**
 * Does the WebGL2 renderer REJECT a plan it cannot allocate render targets for?
 *
 * The failure this gate exists to catch is invisible to any pixel comparison.
 * `allocateFBOs` used to cap the pool at `maxIntermediateTextures` (8 desktop,
 * 4 mobile) and only `console.warn`, while `updateRenderPlan` still returned
 * `{success:true}`. At draw time `renderMultiPass` skips a pass with no FBO and
 * `continue`s WITHOUT setting the consumer's sampler uniform — which therefore
 * keeps its default of texture unit 0 and samples whatever is bound there. The
 * result is a plausible image built from the wrong texture, reported as
 * success, with nothing reaching the UI. Reachable today without any new node:
 * Pyramid Blur at N=3 is already 7 passes.
 *
 * So the assertions here are on the CONTRACT, not on pixels:
 *   1. OVER CAP        cap+1 intermediates → success:false, and the error names
 *                      both the needed count and the cap.
 *   2. AT CAP          exactly cap intermediates → success:true AND the FBO
 *                      pool really holds `cap` slots. Without this a guard that
 *                      rejected every multi-pass plan would score green on (1).
 *   3. SINGLE PASS     the one-pass fast path is untouched.
 *
 * The plans are produced by the real compiler from a real graph (a chain of
 * `pixelate` nodes, each of which is a texture boundary), not hand-written, so
 * a change in how boundaries become passes cannot make this gate vacuous.
 *
 * WebGPU already had this check (`src/webgpu/renderer.ts`, `updateMultiPass`),
 * and gate 4 asserts it still holds so the two backends cannot drift apart.
 *
 * Run: npx tsx scripts/verify-renderer-caps-gpu.ts
 */
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright-core'
import { resolve } from 'node:path'
import { test, run, assert } from './blur-bakeoff/lib/test-util'

const ROOT = resolve(import.meta.dirname, '..')

interface CapProbe {
  /** `maxIntermediateTextures` as the renderer itself computed it. */
  cap: number
  /** MAX_TEXTURE_IMAGE_UNITS, for the report only. */
  units: number
}

interface PlanResult {
  passes: number
  success: boolean
  error: string
  /** Length of the renderer's FBO pool after the call — the mechanism proof. */
  fbos: number
}

interface Harness {
  probe(): CapProbe
  /** Compile a chain of `n` pixelate nodes and hand the plan to the renderer. */
  apply(n: number): Promise<PlanResult>
  applyWebGPU(n: number): Promise<PlanResult | null>
}

declare global {
  var __caps: Harness
}

async function installHarness(page: Page, base: string): Promise<void> {
  await page.evaluate(async (b) => {
    const { initializeNodeLibrary } = await import(/* @vite-ignore */ `${b}src/nodes/index.ts`)
    const { compileGraph } = await import(/* @vite-ignore */ `${b}src/compiler/glsl-generator.ts`)
    const { compileGraphIR } = await import(/* @vite-ignore */ `${b}src/compiler/ir-compiler.ts`)
    const { WebGL2ShaderRenderer } = await import(/* @vite-ignore */ `${b}src/webgl/renderer.ts`)
    const { WebGPUShaderRenderer } = await import(/* @vite-ignore */ `${b}src/webgpu/renderer.ts`)
    initializeNodeLibrary()

    const mkCanvas = () => {
      const c = document.createElement('canvas')
      c.width = 128; c.height = 128
      c.style.width = '128px'; c.style.height = '128px'
      document.body.appendChild(c)
      return c
    }

    // A chain of `n` pixelate nodes: every pixelate port is `textureInput`, so
    // the compiler emits n+1 passes — n of them intermediate.
    const buildPlan = (n: number) => {
      const nodes: unknown[] = [{ id: 'src', type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: 'checkerboard', params: {} } }]
      const edges: unknown[] = []
      let prev = 'src'
      for (let i = 0; i < n; i++) {
        nodes.push({ id: `p${i}`, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: 'pixelate', params: {} } })
        edges.push({ id: `e${i}`, source: prev, sourceHandle: 'color', target: `p${i}`, targetHandle: 'source' })
        prev = `p${i}`
      }
      nodes.push({ id: 'out', type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: 'fragment_output', params: {} } })
      edges.push({ id: 'eo', source: prev, sourceHandle: 'color', target: 'out', targetHandle: 'color' })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const plan = compileGraph(nodes as any, edges as any)
      if (!plan.success) throw new Error(`compile failed: ${plan.errors.map((e: { message: string }) => e.message).join('; ')}`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ir = compileGraphIR(nodes as any, edges as any)
      if (ir) plan.wgsl = { passes: ir.passes }
      return plan
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let glRenderer: any = null
    const gl = async () => {
      if (!glRenderer) {
        glRenderer = new WebGL2ShaderRenderer()
        await glRenderer.init(mkCanvas())
      }
      return glRenderer
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let gpuRenderer: any = null
    let gpuTried = false

    globalThis.__caps = {
      probe: () => {
        // Private fields are a runtime object property; asserted non-zero by
        // the caller so a rename fails this gate loudly instead of silently
        // comparing against `undefined`.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = glRenderer as any
        return { cap: r?.maxIntermediateTextures, units: r?.maxTextureUnits }
      },
      apply: async (n: number) => {
        const r = await gl()
        const plan = buildPlan(n)
        const res = r.updateRenderPlan(plan)
        return {
          passes: plan.passes.length,
          success: !!res.success,
          error: res.error ?? '',
          fbos: r.fboPool.length,
        }
      },
      applyWebGPU: async (n: number) => {
        if (!gpuTried) {
          gpuTried = true
          try {
            if (navigator.gpu) {
              const r = new WebGPUShaderRenderer()
              await r.init(mkCanvas())
              gpuRenderer = r
            }
          } catch { gpuRenderer = null }
        }
        if (!gpuRenderer) return null
        const plan = buildPlan(n)
        const res = gpuRenderer.updateRenderPlan(plan)
        return { passes: plan.passes.length, success: !!res.success, error: res.error ?? '', fbos: 0 }
      },
    }
  }, base)
}

async function main() {
  let server: ViteDevServer | null = null
  let browser: Browser | null = null

  try {
    server = await createServer({
      configFile: resolve(ROOT, 'vite.config.ts'),
      root: ROOT,
      logLevel: 'error',
      server: { port: 0, host: '127.0.0.1' },
    })
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    if (!url) throw new Error('vite dev server did not report a local URL')
    const path = new URL(url).pathname
    const base = path.endsWith('/') ? path : `${path}/`
    const origin = new URL(url).origin

    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: ['--enable-unsafe-webgpu'],
    })
    const page = await browser.newPage({ viewport: { width: 320, height: 320 } })
    page.on('pageerror', (e) => console.error('  [page error]', e.message))
    await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f)' })
    await page.route('**/__caps.html', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>renderer-caps gate</title>' }))
    await page.goto(`${origin}${base}__caps.html`)

    await installHarness(page, base)

    // Touch the renderer once so the probe reads a constructed instance.
    const one = await page.evaluate(() => globalThis.__caps.apply(0))
    const caps = await page.evaluate(() => globalThis.__caps.probe())
    console.log(`  WebGL2: MAX_TEXTURE_IMAGE_UNITS=${caps.units}, maxIntermediateTextures=${caps.cap}`)
    assert(Number.isInteger(caps.cap) && caps.cap > 0,
      `renderer did not report an intermediate-texture cap (got ${String(caps.cap)}) — field renamed?`)

    const overCap = await page.evaluate((n) => globalThis.__caps.apply(n), caps.cap + 1)
    const atCap = await page.evaluate((n) => globalThis.__caps.apply(n), caps.cap)
    const gpuOver = await page.evaluate((n) => globalThis.__caps.applyWebGPU(n), 40)

    test('1 · over-cap plan is REJECTED, not silently truncated', () => {
      assert(overCap.passes === caps.cap + 2,
        `expected ${caps.cap + 2} passes (${caps.cap + 1} intermediates), got ${overCap.passes}`)
      assert(overCap.success === false,
        `updateRenderPlan returned success:true for ${caps.cap + 1} intermediates against a cap of ${caps.cap} — `
        + `the over-cap passes render with an unset sampler uniform (texture unit 0)`)
      assert(overCap.error.includes(String(caps.cap + 1)) && overCap.error.includes(String(caps.cap)),
        `error must name both the needed count (${caps.cap + 1}) and the cap (${caps.cap}); got: "${overCap.error}"`)
      console.log(`  over-cap error: ${overCap.error}`)
    })

    test('2 · at-cap plan still succeeds AND allocates the full pool', () => {
      assert(atCap.success === true, `at-cap plan was rejected: ${atCap.error}`)
      // The mechanism proof: the guard let this through and the FBOs exist, so
      // gate 1 is a boundary, not a blanket refusal of multi-pass.
      assert(atCap.fbos === caps.cap,
        `expected ${caps.cap} FBO slots allocated, got ${atCap.fbos}`)
    })

    test('3 · single-pass fast path is unaffected', () => {
      assert(one.passes === 1, `expected a 1-pass plan, got ${one.passes}`)
      assert(one.success === true, `single-pass plan rejected: ${one.error}`)
    })

    test('4 · WebGPU rejects its own over-cap plan (backends agree)', () => {
      if (!gpuOver) { console.log('  (WebGPU unavailable — skipped)'); return }
      assert(gpuOver.success === false,
        `WebGPU accepted a ${gpuOver.passes}-pass plan past MAX_INTERMEDIATE_TEXTURES`)
      console.log(`  webgpu over-cap error: ${gpuOver.error}`)
    })
  } catch (err) {
    test('harness setup', () => {
      throw err instanceof Error ? err : new Error(String(err))
    })
  } finally {
    await browser?.close()
    await server?.close()
  }
  await run('renderer-caps')
}

await main()
