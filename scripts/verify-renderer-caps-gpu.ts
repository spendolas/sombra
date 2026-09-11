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
 *   7. UNIT ACCOUNTING a texture boundary the consuming node never reads must
 *                      not spend a texture unit. Its sampler is stripped as
 *                      unused, so the linker cannot see the overflow; the bind
 *                      loop walked one unit per entry regardless and pushed the
 *                      image samplers that follow past the last unit.
 *   8. WEBGPU          the same unread-port condition on the other backend —
 *                      pinned as known-broken (audit P0.2).
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
  /** MAX_TEXTURE_IMAGE_UNITS — the per-pass sampler ceiling. */
  units: number
}

interface UnitResult {
  passes: number
  success: boolean
  error: string
  /** Sampler uniforms the LAST pass's program actually declares. */
  samplers: number
  /** `inputTextures` entries on that pass — each spends a unit, read or not. */
  boundaries: number
  /** sampler2D uniforms the LINKED program kept (unused ones are stripped). */
  activeSamplers: number
  /** Texture unit each of those samplers was bound to after a real render. */
  boundUnits: number[]
  /**
   * Per READ sampler: the unit `uniform1i` gave it, and whether the texture
   * actually bound to that unit is the one the plan says belongs there.
   *
   * `correctTexture` is meaningless for unit 0: `renderMultiPass` ends with
   * `activeTexture(TEXTURE0); bindTexture(TEXTURE_2D, null)` as cleanup, so
   * unit 0 always reads back empty AFTER the draw. Callers skip it rather
   * than pretend — and assert that something else was actually checked.
   */
  mapping: Array<{ name: string; unit: number; correctTexture: boolean }>
  /** `gl.getError()` after the draw. 0 is NO_ERROR. */
  glError: number
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
  /**
   * `k` texture boundaries the consuming node NEVER READS, plus `m` image
   * nodes. The program links (few declared samplers) but the bind loop still
   * spends a unit per unread boundary.
   */
  applyPhantom(k: number, m: number): Promise<UnitResult>
  /** The same unread-boundary graph, handed to the WebGPU renderer. */
  phantomWebGPU(k: number, m: number): Promise<{ available: boolean; success: boolean; error: string; uncaptured: string[] }>
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
    const { nodeRegistry } = await import(/* @vite-ignore */ `${b}src/nodes/registry.ts`)
    const { declare, literal } = await import(/* @vite-ignore */ `${b}src/compiler/ir/types.ts`)
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

    // 1x1 opaque PNG. An image node with NO imageData still DECLARES its
    // sampler but never samples it, so GLSL strips it as unused and the pass
    // would want zero units — the gate would be measuring nothing.
    const PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

    // A node that declares texture ports and reads NONE of them.
    // `findTextureBoundaries` creates a boundary for any WIRED textureInput
    // whether or not codegen reads it, so each wired port becomes an
    // `inputTextures` entry whose sampler the GLSL compiler then strips as
    // unused — the pass's program links with few samplers, while the bind loop
    // still walks one unit per entry. No shipped node behaves this way (every
    // boundary they create is read), which is why this is synthetic; a node
    // with a wired-but-unread texture port is what a layer list introduces.
    const PHANTOM_PORTS = 8
    nodeRegistry.register({
      type: 'test_phantom_sampler',
      label: 'Test Phantom Sampler',
      category: 'effect',
      inputs: Array.from({ length: PHANTOM_PORTS }, (_, i) => ({
        id: `src${i}`, label: `Src ${i}`, type: 'color', textureInput: true, default: [0, 0, 0, 1],
      })),
      outputs: [{ id: 'color', label: 'Color', type: 'color' }],
      params: [],
      glsl: (ctx: { outputs: Record<string, string> }) => `vec4 ${ctx.outputs.color} = vec4(0.25, 0.5, 0.75, 1.0);`,
      // The IR half, so the same graph reaches the WebGPU backend. Also reads
      // nothing — the point is a node whose wired texture ports go unused on
      // BOTH backends.
      ir: (ctx: { outputs: Record<string, string> }) => ({
        statements: [declare(ctx.outputs.color, 'vec4', literal('vec4', [0.25, 0.5, 0.75, 1.0]))],
        uniforms: [],
        standardUniforms: new Set<string>(),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    /** `k` unread boundaries into the phantom node, then `m` image nodes mixed on. */
    const buildPhantom = (k: number, m: number) => {
      const nodes: unknown[] = []
      const edges: unknown[] = []
      const mk = (id: string, type: string, params: Record<string, unknown> = {}) =>
        ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params } })
      nodes.push(mk('ph', 'test_phantom_sampler'))
      for (let i = 0; i < k; i++) {
        nodes.push(mk(`cb${i}`, 'checkerboard'), mk(`px${i}`, 'pixelate'))
        edges.push({ id: `ce${i}`, source: `cb${i}`, sourceHandle: 'color', target: `px${i}`, targetHandle: 'source' })
        edges.push({ id: `pe${i}`, source: `px${i}`, sourceHandle: 'color', target: 'ph', targetHandle: `src${i}` })
      }
      let cur = 'ph'
      let curHandle = 'color'
      for (let j = 0; j < m; j++) {
        nodes.push(mk(`im${j}`, 'image', { imageData: PIXEL_PNG, imageAspect: 1 }))
        const id = `mx${j}`
        nodes.push(mk(id, 'mix'))
        edges.push({ id: `ma${j}`, source: cur, sourceHandle: curHandle, target: id, targetHandle: 'a' })
        edges.push({ id: `mb${j}`, source: `im${j}`, sourceHandle: 'color', target: id, targetHandle: 'b' })
        cur = id
        curHandle = 'result'
      }
      nodes.push(mk('out', 'fragment_output'))
      edges.push({ id: 'eo', source: cur, sourceHandle: curHandle, target: 'out', targetHandle: 'color' })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const plan = compileGraph(nodes as any, edges as any)
      if (!plan.success) throw new Error(`compile failed: ${plan.errors.map((e: { message: string }) => e.message).join('; ')}`)
      // The WGSL half, so the SAME graph can be handed to the WebGPU renderer.
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

    /**
     * Apply a plan, bind everything it wants, render, and report what the GPU
     * actually did — the unit each sampler was given (read back off the linked
     * program with `getUniform`) and `gl.getError()` after the draw. Judging
     * the picture would prove nothing: a sampler left on the default unit 0
     * still draws something, and a failed draw leaves the previous frame up.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runPlan = async (r: any, plan: any): Promise<UnitResult> => {
      const last = plan.passes[plan.passes.length - 1]
      const samplerNames = [...new Set(
        (last.fragmentShader.match(/uniform sampler2D\s+(\w+)/g) ?? [])
          .map((d: string) => d.split(/\s+/).pop()!))] as string[]
      const boundaries = Object.keys(last.inputTextures).length
      const res = r.updateRenderPlan(plan)
      if (!res.success) {
        return { passes: plan.passes.length, success: false, error: res.error ?? '', samplers: samplerNames.length, boundaries, activeSamplers: 0, boundUnits: [], mapping: [], glError: 0 }
      }
      // Upload a texture for every image sampler, or the bind loop skips it
      // and the units it would have taken are never claimed.
      const bmp = await createImageBitmap(await (await fetch(PIXEL_PNG)).blob())
      for (const name of samplerNames) if (name.endsWith('_image')) r.uploadImageTexture(name, bmp)
      const glCtx = r.gl as WebGL2RenderingContext
      while (glCtx.getError() !== glCtx.NO_ERROR) { /* drain pre-existing errors */ }
      r.render()
      const glError = glCtx.getError()
      const ps = r.passStates[r.passStates.length - 1]
      let activeSamplers = 0
      if (ps?.program) {
        const n = glCtx.getProgramParameter(ps.program, glCtx.ACTIVE_UNIFORMS) as number
        for (let i = 0; i < n; i++) {
          const info = glCtx.getActiveUniform(ps.program, i)
          if (info && info.type === glCtx.SAMPLER_2D) activeSamplers += info.size
        }
      }
      // For each sampler the program kept, the unit `uniform1i` assigned AND
      // what is actually bound to that unit. `getError() == NO_ERROR` passes
      // when nothing interesting happened; this does not — a phantom unit
      // shows up as a gap in the units or a texture that isn't the one the
      // plan names.
      const boundUnits: number[] = []
      const mapping: Array<{ name: string; unit: number; correctTexture: boolean }> = []
      for (const name of samplerNames) {
        const loc = ps?.uniforms?.get(name)
        if (!loc) continue
        const unit = glCtx.getUniform(ps.program, loc) as number
        boundUnits.push(unit)
        // What the GPU has on that unit right now.
        glCtx.activeTexture(glCtx.TEXTURE0 + unit)
        const actual = glCtx.getParameter(glCtx.TEXTURE_BINDING_2D) as WebGLTexture | null
        // What the plan says should be there: an earlier pass's FBO colour
        // attachment, or the uploaded image texture.
        const srcPass = last.inputTextures[name]
        const expected = srcPass === undefined
          ? r.imageTextures.get(name) ?? null
          : r.fboPool[srcPass]?.texture ?? null
        mapping.push({ name, unit, correctTexture: !!actual && actual === expected,
        })
      }
      glCtx.activeTexture(glCtx.TEXTURE0)
      return { passes: plan.passes.length, success: true, error: '', samplers: samplerNames.length, boundaries, activeSamplers, boundUnits, mapping, glError }
    }

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
      applyPhantom: async (k: number, m: number) => runPlan(await gl(), buildPhantom(k, m)),
      phantomWebGPU: async (k: number, m: number) => {
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
        if (!gpuRenderer) return { available: false, success: false, error: '', uncaptured: [] }
        // `createRenderPipeline` does NOT throw on a validation failure — it
        // returns an invalid pipeline and fires an uncaptured error — so a
        // try/catch alone would report success on a broken pass.
        const uncaptured: string[] = []
        const dev = gpuRenderer.getDevice() as GPUDevice
        const onErr = (e: Event) => uncaptured.push(String((e as GPUUncapturedErrorEvent).error?.message ?? e))
        dev.addEventListener('uncapturederror', onErr)
        let success = false
        let error = ''
        try {
          const plan = buildPhantom(k, m)
          const res = gpuRenderer.updateRenderPlan(plan)
          success = !!res.success
          error = res.error ?? ''
          gpuRenderer.render()
          await dev.queue.onSubmittedWorkDone()
        } catch (e) {
          error = e instanceof Error ? e.message : String(e)
        }
        dev.removeEventListener('uncapturederror', onErr)
        return { available: true, success, error, uncaptured }
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

    // The path the FBO cap cannot bound and the linker does not see: texture
    // boundaries the consuming node never reads. Their samplers are stripped,
    // so the program links with few of them, but the bind loop still spends a
    // unit per `inputTextures` entry — `texUnit++` runs whether or not a
    // sampler location was found — and `bindImageTextures` continues from that
    // inflated count.
    // 3 unread boundaries + (units-2) image samplers: 3 + 14 = 17 units wanted
    // against 16, while the program itself declares 17 samplers of which only
    // 14 are live. Whether that links decides whether this path exists at all.
    const phantomK = 3
    const phantom = await page.evaluate((a) => globalThis.__caps.applyPhantom(a[0], a[1]),
      [phantomK, caps.units - 2])

    test('7 · unread texture boundaries must not spend texture units', () => {
      assert(phantom.boundaries === phantomK,
        `the harness built ${phantom.boundaries} boundaries, expected ${phantomK} — it is not exercising the path`)
      assert(phantom.activeSamplers <= caps.units && phantom.samplers > caps.units,
        `this case must LINK while declaring more than it uses (declared ${phantom.samplers}, `
        + `active ${phantom.activeSamplers}, units ${caps.units}) — otherwise it is gate 5's case, not this one`)
      assert(phantom.success === true, `the plan was rejected before binding: ${phantom.error}`)
      // Assert the ACCOUNTING, not the absence of an error: NO_ERROR passes
      // whenever nothing interesting happened. A unit spent on an unread
      // boundary shows up here as a gap, an inflated count, or a sampler
      // reading a texture the plan never put there.
      const sorted = [...phantom.boundUnits].sort((a, b) => a - b)
      assert(sorted.length === phantom.activeSamplers,
        `${phantom.activeSamplers} samplers survived linking but ${sorted.length} got a unit`)
      assert(sorted.every((u, i) => u === i),
        `units must run contiguously from 0 with nothing spent on unread boundaries; got ${JSON.stringify(sorted)}`)
      const checkable = phantom.mapping.filter((m) => m.unit !== 0)
      assert(checkable.length > 0, 'no sampler landed above unit 0 — the identity check would be vacuous')
      const wrong = checkable.filter((m) => !m.correctTexture)
      assert(wrong.length === 0,
        `${wrong.length} sampler(s) read a texture the plan did not put there: `
        + JSON.stringify(wrong.map((m) => `${m.name}@${m.unit}`)))
      assert(phantom.glError === 0,
        `gl.getError() after the draw was 0x${phantom.glError.toString(16)} `
        + `(0x500 = INVALID_ENUM from activeTexture past the last unit), expected NO_ERROR`)
      console.log(`  phantom: ${phantom.boundaries} unread boundaries, ${phantom.samplers} declared / ${phantom.activeSamplers} active samplers, units ${JSON.stringify(phantom.boundUnits.length ? [Math.min(...phantom.boundUnits), Math.max(...phantom.boundUnits)] : [])}, glError 0x${phantom.glError.toString(16)}`)
    })

    const phantomGpu = await page.evaluate((a) => globalThis.__caps.phantomWebGPU(a[0], a[1]),
      [phantomK, caps.units - 2])

    test('8 · WebGPU + unread texture ports is KNOWN BROKEN (audit P0.2) — pinned', () => {
      if (!phantomGpu.available) { console.log('  (WebGPU unavailable — skipped)'); return }
      // Checked rather than assumed, and the answer is that WebGPU is NOT
      // unaffected — it fails worse than WebGL2 did. A wired-but-unread
      // texture port makes `layout:'auto'` omit the binding, `createBindGroup`
      // throws, `buildPassTextureBindGroup` swallows it and returns null,
      // `setBindGroup(1, …)` is skipped, and the draw invalidates the whole
      // command encoder — while `updateRenderPlan` reports success. That is
      // audit P0.2, it is out of Phase A's scope, and fixing it is framework
      // work on the WGSL assembler, not a one-line accounting change.
      //
      // So this gate PINS the broken behaviour rather than asserting the good
      // one. It is a tripwire: when P0.2 is fixed it goes red, and whoever
      // fixes it flips it to `uncaptured.length === 0`. It must never be
      // deleted to make a run green.
      console.log(`  webgpu phantom (P0.2): success=${phantomGpu.success} uncaptured=${phantomGpu.uncaptured.length}`)
      assert(phantomGpu.success === true,
        `WebGPU now REJECTS the plan (${phantomGpu.error}) — if P0.2 was fixed, flip this gate to assert no uncaptured errors`)
      assert(phantomGpu.uncaptured.length > 0,
        'WebGPU no longer raises a validation error on unread texture ports — P0.2 appears FIXED; '
        + 'flip this gate to assert uncaptured.length === 0 and drop the pin')
      assert(phantomGpu.uncaptured.some((m) => /bind group/i.test(m)),
        `expected the documented P0.2 signature ("No bind group set at group index 1"), got: `
        + JSON.stringify(phantomGpu.uncaptured.slice(0, 2)))
      console.log(`  ↳ pinned: "${phantomGpu.uncaptured[0].split('\n')[0]}"`)
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
