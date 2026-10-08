/**
 * Does the Stack node composite what spec §3 says, on BOTH backends, as a
 * chain of passes that binds at most two textures each?
 *
 * Every case runs a real graph through the real compilers (glsl-generator →
 * WebGL2, ir-compiler → WebGPU) and the real renderers, reads the canvas back
 * composited over BLACK and over WHITE in the same tick — that pair gives the
 * premultiplied colour and the alpha exactly, whatever the canvas alpha mode —
 * and compares against a CPU emulation of the same pipeline: every layer
 * source and every non-final composite crosses an rgba8 boundary, so the
 * reference quantises at exactly those points.
 *
 * A pixel diff alone proves nothing for a blend: skipping it makes the output
 * equal the backdrop. So each case also asserts, on the compiler-produced
 * plans, the pass count, that no composite pass binds more than two textures,
 * which blend helpers each pass defines — and the reference itself must differ
 * from the "blend skipped" and "layer missing" alternatives by a margin the
 * comparison can see.
 *
 *   maths       3 solid layers, mixed modes, opacity and a WIRED mask; both
 *               blend spaces; plus a translucent bottom (alpha-aware over).
 *   hidden      3 wired layers, middle hidden: zero uncaptured WebGPU errors,
 *               the hidden layer's colour absent, no pass for it at all.
 *   none        every layer hidden: an explicit transparent constant.
 *   single      3 wired, only one visible: the degenerate chain still routes
 *               (one composite pass, one bound texture).
 *   banding     a dark gradient through 5 layers in LINEAR mode against a
 *               single-pass float reference: within 1 LSB per pass. Storing
 *               linear values in the 8-bit intermediates would band the darks
 *               far past that, and the gate proves its own content would show it.
 *
 * Run: npm run verify:stack:gpu
 */
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser } from 'playwright-core'
import { resolve } from 'node:path'
import { test, run, assert } from './blur-bakeoff/lib/test-util'

const ROOT = resolve(import.meta.dirname, '..')
const W = 32
const H = 16

// ---------------------------------------------------------------------------
// Graph building
// ---------------------------------------------------------------------------

type RGBA = [number, number, number, number]
interface LayerSpec {
  id: string
  mode: string
  visible?: boolean
  /** Solid source colour, or a gradient source, or nothing wired. */
  src?: RGBA | 'gradient' | null
  opacity?: number
  /** A wired mask (float_constant) value. */
  mask?: number
  /** A wired opacity (float_constant) value — for the hidden-layer case. */
  wiredOpacity?: number
}

const GRADIENT_PARAMS = {
  gradientType: 'linear', drawMode: 'stretch', interpolation: 'linear',
  p0u: 0, p0v: 0.5, p1u: 1, p1v: 0.5,
  stops: [{ position: 0, color: [0, 0, 0, 1] }, { position: 1, color: [0.16, 0.14, 0.18, 1] }],
}

function buildGraph(layers: LayerSpec[], space: 'srgb' | 'linear') {
  const nodes: unknown[] = []
  const edges: unknown[] = []
  const mk = (id: string, type: string, params: Record<string, unknown> = {}) =>
    nodes.push({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params } })
  const ed = (s: string, sh: string, t: string, th: string) =>
    edges.push({ id: `e${edges.length}`, source: s, sourceHandle: sh, target: t, targetHandle: th })
  const params: Record<string, unknown> = {
    layers: layers.map((l, i) => ({ id: l.id, name: `Layer ${i + 1}`, blendMode: l.mode, visible: l.visible !== false })),
    nextLayerNumber: layers.length + 1,
    blendSpace: space,
  }
  for (const l of layers) if (l.opacity !== undefined) params[`opacity_${l.id}`] = l.opacity
  mk('stk', 'stack', params)
  for (const l of layers) {
    if (l.src === 'gradient') { mk(`src_${l.id}`, 'gradient', GRADIENT_PARAMS); ed(`src_${l.id}`, 'color', 'stk', `layer_${l.id}`) }
    else if (l.src) { mk(`src_${l.id}`, 'color_constant', { color: l.src }); ed(`src_${l.id}`, 'color', 'stk', `layer_${l.id}`) }
    if (l.mask !== undefined) { mk(`mask_${l.id}`, 'float_constant', { value: l.mask }); ed(`mask_${l.id}`, 'value', 'stk', `mask_${l.id}`) }
    if (l.wiredOpacity !== undefined) { mk(`op_${l.id}`, 'float_constant', { value: l.wiredOpacity }); ed(`op_${l.id}`, 'value', 'stk', `opacity_${l.id}`) }
  }
  mk('out', 'fragment_output')
  ed('stk', 'color', 'out', 'color')
  return { nodes, edges }
}

// ---------------------------------------------------------------------------
// CPU reference — the spec §3 maths and the blend formulas for the modes used
// here, plus the pipeline's quantisation points.
// ---------------------------------------------------------------------------

type V3 = [number, number, number]
const q = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255) / 255
const toLin = (c: number) => (c < 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const toSrgb = (c: number) => { const v = Math.max(c, 0); return v < 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055 }
const per = (b: V3, s: V3, f: (x: number, y: number) => number): V3 => [f(b[0], s[0]), f(b[1], s[1]), f(b[2], s[2])]
const BLEND: Record<string, (b: V3, s: V3) => V3> = {
  normal: (_b, s) => s,
  multiply: (b, s) => per(b, s, (x, y) => x * y),
  screen: (b, s) => per(b, s, (x, y) => x + y - x * y),
  overlay: (b, s) => per(b, s, (x, y) => (x <= 0.5 ? 2 * x * y : 1 - 2 * (1 - x) * (1 - y))),
  lighten: (b, s) => per(b, s, Math.max),
  difference: (b, s) => per(b, s, (x, y) => Math.abs(x - y)),
}

interface Px { c: V3; a: number }
/**
 * Composite `layers` bottom-up. `quantise` true emulates the GPU: each layer
 * source and each intermediate composite stored as rgba8 sRGB. `storeLinear`
 * emulates the WRONG design (intermediates stored as 8-bit linear) so the
 * banding case can prove its content would expose it.
 */
function composite(
  layers: Array<{ mode: string; src: RGBA; opacity: number; mask: number }>,
  space: 'srgb' | 'linear',
  opts: { quantise: boolean; storeLinear?: boolean; skipBlend?: boolean } = { quantise: true },
): Px {
  const lin = space === 'linear'
  let acc: Px | null = null
  layers.forEach((l, k) => {
    const src = opts.quantise ? l.src.map(q) as RGBA : l.src
    const cs: V3 = [src[0], src[1], src[2]].map((x) => (lin ? toLin(x) : x)) as V3
    const as = src[3] * Math.min(1, Math.max(0, l.opacity)) * Math.min(1, Math.max(0, l.mask))
    let co: V3, ao: number
    if (!acc) { co = cs; ao = as } else {
      const cb = acc.c, ab = acc.a
      const B = (opts.skipBlend ? BLEND.normal : BLEND[l.mode])(cb, cs)
      const cs2 = cs.map((x, i) => (1 - ab) * x + ab * B[i]) as V3
      ao = as + ab * (1 - as)
      co = cb.map((x, i) => ((1 - as) * ab * x + as * cs2[i]) / Math.max(ao, 1e-6)) as V3
    }
    const last = k === layers.length - 1
    if (opts.quantise && !last) {
      if (opts.storeLinear && lin) { co = co.map(q) as V3 } else {
        const enc = co.map((x) => q(lin ? toSrgb(x) : x))
        co = enc.map((x) => (lin ? toLin(x) : x)) as V3
      }
      ao = q(ao)
    }
    acc = { c: co, a: ao }
  })
  if (!acc) return { c: [0, 0, 0], a: 0 }
  const fin = acc as Px
  return { c: fin.c.map((x) => (lin ? toSrgb(x) : x)) as V3, a: fin.a }
}

/** Bytes the canvas shows over black: premultiplied colour, quantised once. */
const overBlack = (p: Px) => p.c.map((x) => Math.round(Math.min(1, Math.max(0, x)) * p.a * 255))
const alphaByte = (p: Px) => Math.round(p.a * 255)

// ---------------------------------------------------------------------------

interface PassInfo { glslInputs: number; glslReads: number[]; resolution: number | null; wgslBindings: string[]; glslHelpers: string[]; wgslHelpers: string[] }
interface Result {
  ok: boolean
  error?: string
  black?: number[][]
  white?: number[][]
  width?: number
  height?: number
  uncaptured: string[]
  passes: PassInfo[]
  /** Per pass: the render target the renderer ACTUALLY allocated ("WxH"), or "canvas". */
  targetSizes?: string[]
}

async function main() {
  let server: ViteDevServer | undefined
  let browser: Browser | undefined
  try {
    server = await createServer({ configFile: resolve(ROOT, 'vite.config.ts'), root: ROOT, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } })
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    if (!url) throw new Error('vite gave no local URL')
    const path = new URL(url).pathname
    const base = path.endsWith('/') ? path : `${path}/`
    const origin = new URL(url).origin
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] })
    const page = await browser.newPage({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 1 })
    page.on('pageerror', (e) => console.error('  [page error]', e.message))
    await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f)' })
    await page.route('**/__stack.html', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>stack gate</title>' }))
    await page.goto(`${origin}${base}__stack.html`)

    const avail = await page.evaluate(async (c) => {
      const [nodesMod, glslMod, irMod] = await Promise.all([
        import(/* @vite-ignore */ `${c.base}src/nodes/index.ts`),
        import(/* @vite-ignore */ `${c.base}src/compiler/glsl-generator.ts`),
        import(/* @vite-ignore */ `${c.base}src/compiler/ir-compiler.ts`),
      ])
      nodesMod.initializeNodeLibrary()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const open: Record<string, { canvas: HTMLCanvasElement; renderer: any } | null> = {}
      const renderer = async (backend: string) => {
        if (backend in open) return open[backend]
        try {
          const canvas = document.createElement('canvas')
          canvas.style.display = 'block'
          canvas.style.width = `${c.W}px`
          canvas.style.height = `${c.H}px`
          document.body.appendChild(canvas)
          const mod = backend === 'webgpu'
            ? await import(/* @vite-ignore */ `${c.base}src/webgpu/renderer.ts`)
            : await import(/* @vite-ignore */ `${c.base}src/webgl/renderer.ts`)
          const r = backend === 'webgpu' ? new mod.WebGPUShaderRenderer() : new mod.WebGL2ShaderRenderer()
          await r.init(canvas)
          r.setAnimated(false)
          open[backend] = { canvas, renderer: r }
        } catch { open[backend] = null }
        return open[backend]
      }
      const over = (canvas: HTMLCanvasElement, bg: string) => {
        const out = document.createElement('canvas')
        out.width = canvas.width; out.height = canvas.height
        const ctx = out.getContext('2d', { willReadFrequently: true })!
        ctx.fillStyle = bg; ctx.fillRect(0, 0, out.width, out.height)
        ctx.drawImage(canvas, 0, 0)
        const d = ctx.getImageData(0, 0, out.width, out.height).data
        const px: number[][] = []
        for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2]])
        return px
      }
      const helperRe = { glsl: /\b(?:vec3|float)\s+(sombra_blend_\w+)\s*\(/g, wgsl: /\bfn\s+(sombra_blend_\w+)\s*\(/g }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).__stack = async (req: { backend: string; nodes: unknown[]; edges: unknown[] }) => {
        const uncaptured: string[] = []
        let passes: Array<{ glslInputs: number; glslReads: number[]; resolution: number | null; wgslBindings: string[]; glslHelpers: string[]; wgslHelpers: string[] }> = []
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const plan: any = glslMod.compileGraph(req.nodes as any, req.edges as any)
          if (!plan.success) return { ok: false, error: `glsl: ${JSON.stringify(plan.errors)}`, uncaptured, passes }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ir = irMod.compileGraphIR(req.nodes as any, req.edges as any)
          if (!ir) return { ok: false, error: 'ir compile returned null', uncaptured, passes }
          plan.wgsl = irMod.toPlanWgsl(ir)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          passes = plan.passes.map((p: any, i: number) => {
            const w = plan.wgsl.passes[i]
            return {
              glslInputs: Object.keys(p.inputTextures ?? {}).length,
              glslReads: Object.values(p.inputTextures ?? {}) as number[],
              resolution: p.resolution ?? null,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              wgslBindings: w ? w.textureBindings.map((b: any) => b.samplerName) : ['<missing wgsl pass>'],
              glslHelpers: [...p.fragmentShader.matchAll(helperRe.glsl)].map((m: RegExpMatchArray) => m[1]),
              wgslHelpers: w ? [...w.shaderCode.matchAll(helperRe.wgsl)].map((m: RegExpMatchArray) => m[1]) : [],
            }
          })
          if (plan.wgsl.passes.length !== plan.passes.length) {
            return { ok: false, error: `backends disagree on pass count: glsl ${plan.passes.length}, wgsl ${plan.wgsl.passes.length}`, uncaptured, passes }
          }
          const rr = await renderer(req.backend)
          if (!rr) return { ok: false, error: 'backend unavailable', uncaptured, passes }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let dev: any = null
          const onErr = (e: Event) => uncaptured.push(String((e as GPUUncapturedErrorEvent).error?.message ?? e))
          if (req.backend === 'webgpu') { dev = rr.renderer.getDevice(); dev.addEventListener('uncapturederror', onErr) }
          const res = rr.renderer.updateRenderPlan(plan)
          if (!res.success) { dev?.removeEventListener('uncapturederror', onErr); return { ok: false, error: `updateRenderPlan: ${res.error}`, uncaptured, passes } }
          if (plan.userUniforms?.length) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            rr.renderer.updateUniforms(plan.userUniforms.map((u: any) => ({ name: u.name, value: u.value })))
          }
          rr.renderer.render()
          // Same task as the draw — see verify-blend-modes-gpu.ts.
          const black = over(rr.canvas, '#000')
          const white = over(rr.canvas, '#fff')
          if (dev) { await dev.queue.onSubmittedWorkDone(); dev.removeEventListener('uncapturederror', onErr) }
          // What each pass really rendered into: the renderer's pool is indexed
          // by the compiler's target slot (-1 = the canvas).
          const pool = req.backend === 'webgpu' ? rr.renderer.intermediateTextures : rr.renderer.fboPool
          const planPasses = req.backend === 'webgpu' ? plan.wgsl.passes : plan.passes
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const targetSizes = planPasses.map((pp: any) => {
            const slot = pp.targetSlot
            if (slot === undefined || slot < 0) return 'canvas'
            const t = pool?.[slot]
            return t ? `${t.width}x${t.height}` : `<slot ${slot} unallocated>`
          })
          return { ok: true, black, white, width: rr.canvas.width, height: rr.canvas.height, uncaptured, passes, targetSizes }
        } catch (e) {
          return { ok: false, error: String((e as Error)?.message ?? e), uncaptured, passes }
        }
      }
      return { webgpu: !!(await renderer('webgpu')), webgl2: !!(await renderer('webgl2')) }
    }, { base, W, H })

    const backends = (['webgpu', 'webgl2'] as const).filter((b) => avail[b])
    console.log(`  backends: ${backends.join(', ') || '(none)'}`)
    test('both backends are available — a skipped backend is a FAILURE here', () => {
      assert(backends.length === 2, `only ${backends.join(', ')} came up`)
    })

    const render = (backend: string, layers: LayerSpec[], space: 'srgb' | 'linear') =>
      page.evaluate((r) => (window as unknown as { __stack: (q: unknown) => Promise<Result> }).__stack(r),
        { backend, ...buildGraph(layers, space) })

    /**
     * The composite passes, bottom first, found by walking back from the output
     * pass: each composite reads its source (a pass that reads nothing) and,
     * above the bottom, the previous composite.
     */
    const chainBottomUp = (res: Result, n: number): PassInfo[] => {
      const out: PassInfo[] = []
      let cur = res.passes.length - 1
      for (let k = 0; k < n; k++) {
        out.unshift(res.passes[cur])
        const prev = res.passes[cur].glslReads.filter((r) => res.passes[r].glslReads.length > 0)
        if (k < n - 1) {
          assert(prev.length === 1, `composite at pass ${cur} reads ${JSON.stringify(res.passes[cur].glslReads)} — no single previous composite`)
          cur = prev[0]
        } else {
          assert(prev.length === 0, `the bottom composite (pass ${cur}) reads a backdrop`)
        }
      }
      return out
    }
    /** Pass count and the ≤2-textures rule, independent of pass order. */
    const assertChainShape = (label: string, res: Result, sources: number, composites: number) => {
      assert(res.passes.length === sources + composites,
        `${label}: ${res.passes.length} passes, expected ${sources} source + ${composites} composite`)
      res.passes.forEach((p, i) => {
        assert(p.glslInputs <= 2, `${label}: pass ${i} binds ${p.glslInputs} textures on GLSL — the chain must bind at most 2`)
        assert(p.wgslBindings.length <= 2, `${label}: pass ${i} binds ${JSON.stringify(p.wgslBindings)} on WGSL — at most 2`)
      })
    }
    const uniformPixel = (label: string, res: Result) => {
      assert(res.ok, `${label}: ${res.error}`)
      assert(res.width === W && res.height === H, `${label}: canvas ${res.width}×${res.height}`)
      const b = res.black![(H >> 1) * W + (W >> 1)]
      const w = res.white![(H >> 1) * W + (W >> 1)]
      for (const p of res.black!) assert(p.every((v, i) => Math.abs(v - b[i]) <= 1), `${label}: solid layers rendered a non-uniform image`)
      return { rgb: b, alpha: 255 - (w[0] - b[0]) }
    }
    const close = (got: number[], want: number[], tol: number) => got.every((v, i) => Math.abs(v - want[i]) <= tol)

    // ---- maths -----------------------------------------------------------
    const MATHS: LayerSpec[] = [
      { id: 'a1', mode: 'normal', src: [0.85, 0.35, 0.15, 1] },
      { id: 'b2', mode: 'multiply', src: [0.30, 0.70, 0.95, 0.6], opacity: 0.7 },
      { id: 'c3', mode: 'screen', src: [0.20, 0.25, 0.60, 1], mask: 0.5 },
    ]
    const TRANSLUCENT: LayerSpec[] = [
      { id: 'a1', mode: 'normal', src: [0.10, 0.60, 0.80, 0.5] },
      { id: 'b2', mode: 'overlay', src: [0.90, 0.20, 0.40, 0.6], opacity: 0.8 },
    ]
    const asRef = (ls: LayerSpec[]) => ls.filter((l) => l.visible !== false).map((l) => ({
      mode: l.mode, src: (l.src ?? [0, 0, 0, 0]) as RGBA, opacity: l.opacity ?? 1, mask: l.mask ?? 1,
    }))

    for (const backend of backends) {
      for (const space of ['srgb', 'linear'] as const) {
        for (const [name, layers, tol] of [['3 layers, multiply/screen, opacity + wired mask', MATHS, 1], ['translucent bottom, overlay', TRANSLUCENT, 2]] as const) {
          test(`${backend} · maths [${space}] · ${name}`, async () => {
            const label = `${name} [${space}]`
            const res = await render(backend, layers as LayerSpec[], space)
            assert(res.ok, `${label}: ${res.error}`)
            const n = layers.length
            assertChainShape(label, res, n, n)
            // Sub-pass 0 has nothing beneath it: no blend helper. Every later
            // composite defines exactly its layer's mode. Passes are emitted in
            // consumer order, so the chain is walked from the output pass down.
            const comps = chainBottomUp(res, n)
            assert(comps[0].glslHelpers.length === 0 && comps[0].wgslHelpers.length === 0,
              `${label}: the bottom composite emitted blend helpers ${JSON.stringify(comps[0].wgslHelpers)} — it has no backdrop`)
            comps.slice(1).forEach((p, i) => {
              const want = `sombra_blend_${(layers as LayerSpec[])[i + 1].mode}`
              for (const [side, list] of [['GLSL', p.glslHelpers], ['WGSL', p.wgslHelpers]] as const) {
                assert(list.length === 1 && list[0] === want, `${label}: composite ${i + 1} defines ${JSON.stringify(list)} on ${side}, expected [${want}]`)
              }
            })
            const ref = composite(asRef(layers as LayerSpec[]), space)
            const skipped = composite(asRef(layers as LayerSpec[]), space, { quantise: true, skipBlend: true })
            const topless = composite(asRef(layers as LayerSpec[]).slice(0, -1), space)
            const want = overBlack(ref)
            // The reference must be distinguishable from the obvious failures.
            const dist = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])))
            assert(dist(want, overBlack(skipped)) >= 6, `${label}: reference within ${dist(want, overBlack(skipped))} LSB of "blend skipped" — pick colours that discriminate`)
            assert(dist(want, overBlack(topless)) >= 6, `${label}: reference within ${dist(want, overBlack(topless))} LSB of "top layer missing"`)
            const got = uniformPixel(label, res)
            assert(close(got.rgb, want, tol), `${label}: got ${got.rgb} (premultiplied), want ${want} ±${tol}`)
            assert(Math.abs(got.alpha - alphaByte(ref)) <= tol, `${label}: alpha ${got.alpha}, want ${alphaByte(ref)} ±${tol}`)
          })
        }
      }

      // ---- hidden middle layer ------------------------------------------------
      test(`${backend} · hidden middle layer: no errors, its colour absent, no pass for it`, async () => {
        const layers: LayerSpec[] = [
          { id: 'r1', mode: 'normal', src: [0.9, 0.05, 0.05, 1] },
          { id: 'g2', mode: 'screen', src: [0.05, 0.9, 0.05, 1], visible: false, wiredOpacity: 0.9 },
          { id: 'b3', mode: 'normal', src: [0.05, 0.05, 0.9, 1], opacity: 0.5 },
        ]
        const res = await render(backend, layers, 'srgb')
        assert(res.uncaptured.length === 0, `WebGPU raised ${res.uncaptured.length} uncaptured error(s): ${JSON.stringify(res.uncaptured.slice(0, 1))}`)
        assert(res.ok, res.error ?? '')
        // 2 visible sources + 2 composites. The hidden source is not rendered at all.
        assertChainShape('hidden', res, 2, 2)
        const ref = composite(asRef(layers), 'srgb')
        const got = uniformPixel('hidden', res)
        assert(close(got.rgb, overBlack(ref), 1), `got ${got.rgb}, want ${overBlack(ref)}`)
        assert(got.rgb[1] <= 15, `green channel ${got.rgb[1]} — the hidden layer leaked into the output`)
        const withHidden = composite(asRef(layers.map((l) => ({ ...l, visible: true }))), 'srgb')
        assert(Math.abs(overBlack(withHidden)[1] - got.rgb[1]) >= 40, 'fixture would not show the hidden layer even if it rendered')
      })

      test(`${backend} · every layer hidden: transparent, one pass`, async () => {
        const layers: LayerSpec[] = [
          { id: 'r1', mode: 'normal', src: [0.9, 0.1, 0.1, 1], visible: false },
          { id: 'g2', mode: 'multiply', src: [0.1, 0.9, 0.1, 1], visible: false },
        ]
        const res = await render(backend, layers, 'linear')
        assert(res.uncaptured.length === 0, `uncaptured: ${JSON.stringify(res.uncaptured.slice(0, 1))}`)
        assertChainShape('none', res, 0, 1)
        const got = uniformPixel('none', res)
        assert(got.rgb.every((v) => v === 0) && got.alpha === 0, `expected transparent, got rgb ${got.rgb} alpha ${got.alpha}`)
      })

      test(`${backend} · one visible of three wired: the degenerate chain still routes`, async () => {
        const layers: LayerSpec[] = [
          { id: 'r1', mode: 'normal', src: [0.9, 0.1, 0.1, 1], visible: false },
          { id: 'g2', mode: 'normal', src: [0.1, 0.9, 0.1, 1], visible: false },
          { id: 'b3', mode: 'screen', src: [0.2, 0.3, 0.8, 1], opacity: 0.75 },
        ]
        const res = await render(backend, layers, 'srgb')
        assert(res.uncaptured.length === 0, `uncaptured: ${JSON.stringify(res.uncaptured.slice(0, 1))}`)
        assertChainShape('single', res, 1, 1)
        const last = res.passes[res.passes.length - 1]
        assert(last.glslInputs === 1 && last.wgslBindings.length === 1,
          `the single composite binds ${last.glslInputs} (GLSL) / ${last.wgslBindings.length} (WGSL) textures, expected exactly its own layer`)
        const got = uniformPixel('single', res)
        const ref = composite(asRef(layers), 'srgb')
        assert(close(got.rgb, overBlack(ref), 1), `got ${got.rgb}, want ${overBlack(ref)}`)
      })

      // ---- banding --------------------------------------------------------------
      test(`${backend} · linear deep stack over a dark gradient: ≤1 LSB per pass, no banding`, async () => {
        const top: LayerSpec[] = [
          { id: 'b2', mode: 'normal', src: [0.05, 0.04, 0.06, 1], opacity: 0.35 },
          { id: 'c3', mode: 'screen', src: [0.10, 0.08, 0.02, 1], opacity: 0.3 },
          { id: 'd4', mode: 'multiply', src: [0.90, 0.85, 0.95, 1], opacity: 0.5 },
          { id: 'e5', mode: 'lighten', src: [0.03, 0.05, 0.08, 1], opacity: 0.4 },
        ]
        const layers: LayerSpec[] = [{ id: 'a1', mode: 'normal', src: 'gradient' }, ...top]
        // The bottom layer's exact bytes: the same gradient rendered alone at
        // the same size is what the stack's source pass stores.
        const alone = await render(backend, [{ id: 'a1', mode: 'normal', src: 'gradient' }], 'linear')
        assert(alone.ok, `gradient alone: ${alone.error}`)
        const res = await render(backend, layers, 'linear')
        assert(res.ok, res.error ?? '')
        assert(res.uncaptured.length === 0, `uncaptured: ${JSON.stringify(res.uncaptured.slice(0, 1))}`)
        assertChainShape('banding', res, 5, 5)
        const passes = 5
        const row = H >> 1
        const darkest = Math.max(...alone.black!.slice(row * W, row * W + W).map((p) => p[0]))
        assert(darkest > 20, `gradient tops out at ${darkest}/255 — too dark to span a range`)
        let worst = 0, worstWrongDesign = 0
        for (let x = 0; x < W; x++) {
          const g = alone.black![row * W + x].map((v) => v / 255)
          const ls = [{ mode: 'normal', src: [g[0], g[1], g[2], 1] as RGBA, opacity: 1, mask: 1 },
            ...asRef(top)]
          const exact = overBlack(composite(ls, 'linear', { quantise: false }))
          // Sources are rgba8 on the GPU too; quantise them, but NOT the chain.
          const exactQ = overBlack(composite(ls.map((l) => ({ ...l, src: l.src.map(q) as RGBA })), 'linear', { quantise: false }))
          const wrong = overBlack(composite(ls, 'linear', { quantise: true, storeLinear: true }))
          void exact
          const got = res.black![row * W + x]
          worst = Math.max(worst, ...got.map((v, i) => Math.abs(v - exactQ[i])))
          worstWrongDesign = Math.max(worstWrongDesign, ...wrong.map((v, i) => Math.abs(v - exactQ[i])))
        }
        console.log(`  [${backend}] banding: worst ${worst} LSB vs single-pass reference over ${passes} passes (8-bit linear storage would be ${worstWrongDesign})`)
        assert(worstWrongDesign > passes, `fixture cannot expose banding: storing linear would only be ${worstWrongDesign} LSB off`)
        assert(worst <= passes, `deep linear stack is ${worst} LSB off a single-pass reference — more than 1 LSB per pass (${passes}); intermediates are banding`)
      })
    }

    // ---- blurred layers -------------------------------------------------------
    // Stack composites blurred layers routinely, and WebGL2 has a known blank
    // render for blur → pixelate. A raw graph, not buildGraph: the source is a
    // multi-pass blur, not a constant.
    const rawRender = (backend: string, nodes: unknown[], edges: unknown[]) =>
      page.evaluate((r) => (window as unknown as { __stack: (q: unknown) => Promise<Result> }).__stack(r), { backend, nodes, edges })
    const nd = (id: string, type: string, params: Record<string, unknown> = {}) => ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params } })
    const wr = (i: number, s: string, sh: string, t: string, th: string) => ({ id: `w${i}`, source: s, sourceHandle: sh, target: t, targetHandle: th })
    const spread = (px: number[][]) => { const v = px.map((p) => p[0]); return Math.max(...v) - Math.min(...v) }
    const maxDiff = (a: number[][], b: number[][]) => Math.max(...a.map((p, i) => Math.max(...p.map((v, c) => Math.abs(v - b[i][c])))))
    const blurred: Record<string, number[][]> = {}
    // A full-range horizontal ramp: survives any blur radius at this size.
    const RAMP = { ...GRADIENT_PARAMS, stops: [{ position: 0, color: [0, 0, 0, 1] }, { position: 1, color: [1, 1, 1, 1] }] }
    for (const backend of backends) {
      test(`${backend} · a pyramid-blurred layer composites exactly what the blur renders alone`, async () => {
        // Pyramid's final sub-pass is full size, so as an intermediate it is the
        // same image it is as the final pass; one opaque Normal layer at
        // opacity 1 must reproduce it. (Gaussian/Kawase declare a reduced final
        // scale that only takes effect as an intermediate, so they cannot be
        // compared this way.)
        const alone = await rawRender(backend, [nd('c', 'gradient', RAMP), nd('py', 'pyramid_blur', { radius: 6 }), nd('out', 'fragment_output')],
          [wr(0, 'c', 'color', 'py', 'source'), wr(1, 'py', 'color', 'out', 'color')])
        const inStack = await rawRender(backend,
          [nd('c', 'gradient', RAMP), nd('py', 'pyramid_blur', { radius: 6 }), nd('stk', 'stack', { layers: [{ id: 'b', name: 'Layer 1', blendMode: 'normal', visible: true }] }), nd('out', 'fragment_output')],
          [wr(0, 'c', 'color', 'py', 'source'), wr(1, 'py', 'color', 'stk', 'layer_b'), wr(2, 'stk', 'color', 'out', 'color')])
        assert(alone.ok && inStack.ok, `${alone.error ?? ''} ${inStack.error ?? ''}`)
        assert(inStack.uncaptured.length === 0, `uncaptured: ${JSON.stringify(inStack.uncaptured.slice(0, 1))}`)
        assert(spread(alone.black!) > 40, `the blur rendered flat (spread ${spread(alone.black!)}) — nothing to compare`)
        const d = maxDiff(alone.black!, inStack.black!)
        assert(d <= 1, `the Stack changed the blurred layer by up to ${d} LSB`)
      })
      test(`${backend} · a Gaussian-blurred layer in a 2-layer Stack renders (not blank)`, async () => {
        const res = await rawRender(backend,
          [nd('g', 'gradient'), nd('c', 'checkerboard'), nd('bl', 'blur', { radius: 12 }),
            nd('stk', 'stack', { layers: [{ id: 'a', name: 'Layer 1', blendMode: 'normal', visible: true }, { id: 'b', name: 'Layer 2', blendMode: 'screen', visible: true }] }), nd('out', 'fragment_output')],
          [wr(0, 'g', 'color', 'stk', 'layer_a'), wr(1, 'c', 'color', 'bl', 'source'), wr(2, 'bl', 'color', 'stk', 'layer_b'), wr(3, 'stk', 'color', 'out', 'color')])
        assert(res.ok, res.error ?? '')
        assert(res.uncaptured.length === 0, `uncaptured: ${JSON.stringify(res.uncaptured.slice(0, 1))}`)
        assert(spread(res.black!) > 40, `the composite is flat (spread ${spread(res.black!)}) — the blurred layer did not reach it`)
        blurred[backend] = res.black!
      })
    }
    // ---- per-pass scale beside a Stack composite (the full-res pin) -------------
    // A blur layer beside another layer shares its first depth group with the
    // Stack's bottom composite. Each sub-pass must still render into a target
    // of the size it declares — read off the renderer's allocated textures, not
    // inferred from pixels — and, for the pyramid, the image must be exactly
    // the blur's own.
    for (const backend of backends) {
      for (const type of ['blur', 'pyramid_blur'] as const) {
        test(`${backend} · ${type} beside a Stack composite: every sub-pass renders at its declared size${type === 'pyramid_blur' ? ', image byte-identical' : ''}`, async () => {
          const radius = type === 'blur' ? 4 : 24
          const alone = await rawRender(backend, [nd('c', 'gradient', RAMP), nd('bl', type, { radius }), nd('out', 'fragment_output')],
            [wr(0, 'c', 'color', 'bl', 'source'), wr(1, 'bl', 'color', 'out', 'color')])
          const inStack = await rawRender(backend,
            [nd('g', 'gradient', GRADIENT_PARAMS), nd('c', 'gradient', RAMP), nd('bl', type, { radius }),
              nd('stk', 'stack', { layers: [{ id: 'a', name: 'Layer 1', blendMode: 'normal', visible: true }, { id: 'b', name: 'Layer 2', blendMode: 'normal', visible: true }] }),
              nd('out', 'fragment_output')],
            [wr(0, 'g', 'color', 'stk', 'layer_a'), wr(1, 'c', 'color', 'bl', 'source'), wr(2, 'bl', 'color', 'stk', 'layer_b'), wr(3, 'stk', 'color', 'out', 'color')])
          assert(alone.ok && inStack.ok, `${alone.error ?? ''} ${inStack.error ?? ''}`)
          assert(inStack.uncaptured.length === 0, `uncaptured: ${JSON.stringify(inStack.uncaptured.slice(0, 1))}`)
          // The blur's sub-passes in the Stack plan: walk back from the top
          // composite's scaled input.
          const ps = inStack.passes
          const top = ps[ps.length - 1]
          const chain = [top.glslReads.find((r) => ps[r].resolution !== null)!]
          assert(chain[0] !== undefined, 'the top composite reads no scaled pass')
          for (;;) {
            const prev = ps[chain[0]].glslReads.filter((r) => ps[r].glslReads.length > 0)
            if (prev.length !== 1) break
            chain.unshift(prev[0])
          }
          // Alone: the blur's sub-passes are passes 1..n-2 (the last is the canvas).
          const aloneSizes = alone.targetSizes!.slice(1, -1)
          const stackSizes = chain.map((i) => inStack.targetSizes![i])
          const half = `${W / 2}x${H / 2}`
          assert(aloneSizes[0] === half, `fixture assumption broken: ${type} alone renders its first sub-pass into ${aloneSizes[0]}, expected ${half}`)
          assert(JSON.stringify(stackSizes.slice(0, aloneSizes.length)) === JSON.stringify(aloneSizes),
            `beside a Stack composite the blur rendered into ${JSON.stringify(stackSizes)}, alone into ${JSON.stringify(aloneSizes)}`)
          // The bottom composite (the top's other input) stays full size.
          const bottom = top.glslReads.find((r) => !chain.includes(r))!
          assert(inStack.targetSizes![bottom] === `${W}x${H}`, `the bottom composite rendered into ${inStack.targetSizes![bottom]}`)
          if (type === 'pyramid_blur') {
            // Opaque Normal top layer at opacity 1: the composite IS the blur.
            const d = maxDiff(alone.black!, inStack.black!)
            assert(spread(alone.black!) > 40, 'the blur rendered flat')
            assert(d === 0, `the pyramid in a 2-layer Stack differs from the pyramid alone by up to ${d} LSB`)
          }
        })
      }
    }
    test('the Gaussian-blurred composite agrees across backends', () => {
      assert(blurred.webgpu && blurred.webgl2, 'one backend did not produce the blurred composite')
      const d = maxDiff(blurred.webgpu, blurred.webgl2)
      assert(d <= 2, `WebGPU and WebGL2 differ by up to ${d} LSB on the blurred-layer composite`)
    })

    await run('stack-gpu')
  } finally {
    await browser?.close()
    await server?.close()
  }
}

await main()
