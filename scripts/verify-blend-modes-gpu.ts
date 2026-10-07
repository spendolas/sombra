/**
 * Do all 24 blend modes compute what their formulas say, on BOTH backends?
 *
 * The blend helpers (`src/nodes/shared/blend-modes.ts`) are one GLSL text per
 * mode, emitted on GLSL as-is and on WGSL by mechanical translation. This gate
 * renders every mode through the REAL compile pipeline (glsl-generator for
 * WebGL2, ir-compiler for WebGPU) and the REAL renderers, and compares every
 * pixel against an independent CPU implementation written from the W3C /
 * Photoshop definitions — not from the shader text.
 *
 * THE PROBE. A test-registered node lays out an 81×81 lattice of colour pairs
 * from the y-down fragment coordinate: every channel of the backdrop and the
 * source takes values k/8, k = 0..8. So every pair includes the guard edges —
 * 0, 1, and 0.5 (the light modes' threshold) — on every channel, exactly
 * representable, so the GPU and the CPU branch identically. 6561 pairs per mode.
 *
 * WHY A PIXEL DIFF IS NOT ENOUGH ON ITS OWN. A skipped blend outputs the
 * backdrop (or, for a broken `normal`, the source), and a pixel diff against a
 * reference that happens to equal those passes. So, per mode:
 *   - the reference must DIFFER from both the backdrop and the source on a real
 *     fraction of pixels, or the comparison could not catch a skip;
 *   - the emitted shader text must contain exactly the expected helper
 *     definitions — this mode's plus its dependencies — and none other. That is
 *     the "emitted only for modes a graph uses" contract.
 *
 * BOTH BLEND SPACES. Linear wraps B in the existing `sombra_toLin` /
 * `sombra_toSrgb` helpers, so the blend library is also proven to coexist with
 * the colour-space registration in one shader.
 *
 * CHAINS. Three probes compose two modes (`B2(B1(b, s), s)`) whose helper sets
 * overlap — Vivid Light pulls in Colour Burn/Dodge, the non-separable modes
 * share five helpers — so the shared definitions must dedup to one each, or
 * both backends refuse the module.
 *
 * Run: npm run verify:blend-modes:gpu
 */
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser } from 'playwright-core'
import { resolve } from 'node:path'
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import { BLEND_MODES, type BlendMode } from '../src/nodes/shared/blend-modes'

const ROOT = resolve(import.meta.dirname, '..')
const N = 81
const K = 8

// ---------------------------------------------------------------------------
// CPU reference — written per channel / per W3C pseudo-code, deliberately NOT
// in the shader's vectorised step/mix form, so a shared mistake is unlikely.
// ---------------------------------------------------------------------------

type V3 = [number, number, number]
const map = (a: V3, b: V3, f: (x: number, y: number) => number): V3 => [f(a[0], b[0]), f(a[1], b[1]), f(a[2], b[2])]

function burn(cb: number, cs: number): number {
  if (cb === 1) return 1
  if (cs === 0) return 0
  return 1 - Math.min(1, (1 - cb) / cs)
}
function dodge(cb: number, cs: number): number {
  if (cb === 0) return 0
  if (cs === 1) return 1
  return Math.min(1, cb / (1 - cs))
}
function hardLight(cb: number, cs: number): number {
  if (cs <= 0.5) return cb * 2 * cs
  const s2 = 2 * cs - 1
  return cb + s2 - cb * s2
}
function softLight(cb: number, cs: number): number {
  if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb)
  const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb)
  return cb + (2 * cs - 1) * (d - cb)
}
const lum = (c: V3) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]
function clipColor(c: V3): V3 {
  const l = lum(c)
  const n = Math.min(...c)
  const x = Math.max(...c)
  let r: V3 = [...c]
  if (n < 0) r = r.map((v) => l + ((v - l) * l) / (l - n)) as V3
  if (x > 1) r = r.map((v) => l + ((v - l) * (1 - l)) / (x - l)) as V3
  return r
}
const setLum = (c: V3, l: number): V3 => { const d = l - lum(c); return clipColor([c[0] + d, c[1] + d, c[2] + d]) }
const sat = (c: V3) => Math.max(...c) - Math.min(...c)
/** W3C SetSat, literally: sort into min/mid/max indices. */
function setSat(c: V3, s: number): V3 {
  const idx = [0, 1, 2].sort((i, j) => c[i] - c[j])
  const [mn, md, mx] = idx
  const r: V3 = [0, 0, 0]
  if (c[mx] > c[mn]) {
    r[md] = ((c[md] - c[mn]) * s) / (c[mx] - c[mn])
    r[mx] = s
  } else {
    r[md] = 0
    r[mx] = 0
  }
  r[mn] = 0
  return r
}

const REF: Record<BlendMode, (b: V3, s: V3) => V3> = {
  normal: (_b, s) => s,
  darken: (b, s) => map(b, s, Math.min),
  multiply: (b, s) => map(b, s, (x, y) => x * y),
  colorBurn: (b, s) => map(b, s, burn),
  linearBurn: (b, s) => map(b, s, (x, y) => Math.max(0, x + y - 1)),
  lighten: (b, s) => map(b, s, Math.max),
  screen: (b, s) => map(b, s, (x, y) => x + y - x * y),
  colorDodge: (b, s) => map(b, s, dodge),
  linearDodge: (b, s) => map(b, s, (x, y) => Math.min(1, x + y)),
  overlay: (b, s) => map(b, s, (x, y) => hardLight(y, x)),
  softLight: (b, s) => map(b, s, softLight),
  hardLight: (b, s) => map(b, s, hardLight),
  vividLight: (b, s) => map(b, s, (x, y) => (y <= 0.5 ? burn(x, 2 * y) : dodge(x, 2 * (y - 0.5)))),
  linearLight: (b, s) => map(b, s, (x, y) => Math.min(1, Math.max(0, x + 2 * y - 1))),
  pinLight: (b, s) => map(b, s, (x, y) => (y <= 0.5 ? Math.min(x, 2 * y) : Math.max(x, 2 * y - 1))),
  hardMix: (b, s) => map(b, s, (x, y) => (x + y >= 1 ? 1 : 0)),
  difference: (b, s) => map(b, s, (x, y) => Math.abs(x - y)),
  exclusion: (b, s) => map(b, s, (x, y) => x + y - 2 * x * y),
  subtract: (b, s) => map(b, s, (x, y) => Math.max(0, x - y)),
  divide: (b, s) => map(b, s, (x, y) => (x === 0 ? 0 : y === 0 ? 1 : Math.min(1, x / y))),
  hue: (b, s) => setLum(setSat(s, sat(b)), lum(b)),
  saturation: (b, s) => setLum(setSat(b, sat(s)), lum(b)),
  color: (b, s) => setLum(s, lum(b)),
  luminosity: (b, s) => setLum(b, lum(s)),
}

const toLin = (c: number) => (c < 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const toSrgb = (c: number) => { const v = Math.max(c, 0); return v < 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055 }

/** The probe's lattice — must match the shader in `installHarness`. */
function pair(x: number, y: number): { b: V3; s: V3 } {
  return {
    b: [(x % 9) / K, Math.floor(x / 9) / K, (y % 9) / K],
    s: [Math.floor(y / 9) / K, ((x + y) % 9) / K, ((x * 7 + y * 3) % 9) / K],
  }
}

type Space = 'srgb' | 'linear'
function reference(modes: BlendMode[], space: Space, b: V3, s: V3): V3 {
  const enc = (c: V3) => (space === 'linear' ? (c.map(toLin) as V3) : c)
  const bb = enc(b), ss = enc(s)
  let r = REF[modes[0]](bb, ss)
  for (const m of modes.slice(1)) r = REF[m](r, ss)
  return space === 'linear' ? (r.map(toSrgb) as V3) : r
}
const byte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255)

// ---------------------------------------------------------------------------
// In-page harness
// ---------------------------------------------------------------------------

interface Capture {
  ok: boolean
  error?: string
  width?: number
  height?: number
  b64?: string
  /** Every `sombra_blend_*` function DEFINED in the module the backend ran. */
  defined?: string[]
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
    await page.route('**/__blend.html', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>blend-modes gate</title>' }))
    await page.goto(`${origin}${base}__blend.html`)

    const avail = await page.evaluate(async (c) => {
      const [nodesMod, registryMod, glslMod, irMod, typesMod, irTypes, glslBackend, blendMod, colorMod] = await Promise.all([
        import(/* @vite-ignore */ `${c.base}src/nodes/index.ts`),
        import(/* @vite-ignore */ `${c.base}src/nodes/registry.ts`),
        import(/* @vite-ignore */ `${c.base}src/compiler/glsl-generator.ts`),
        import(/* @vite-ignore */ `${c.base}src/compiler/ir-compiler.ts`),
        import(/* @vite-ignore */ `${c.base}src/nodes/types.ts`),
        import(/* @vite-ignore */ `${c.base}src/compiler/ir/types.ts`),
        import(/* @vite-ignore */ `${c.base}src/compiler/ir/glsl-backend.ts`),
        import(/* @vite-ignore */ `${c.base}src/nodes/shared/blend-modes.ts`),
        import(/* @vite-ignore */ `${c.base}src/nodes/shared/color-space.ts`),
      ])
      nodesMod.initializeNodeLibrary()
      const { declare, raw, call, variable, construct, literal, fragCoord } = irTypes

      // The probe's body as IR — shared by both paths so the LATTICE cannot
      // differ between backends. Only the blend REGISTRATION differs per path,
      // and that is the API under test: addBlendGLSL vs blendIRFunctions.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const probeStatements = (ctx: any, names: string[], linear: boolean) => {
        const id = ctx.nodeId.replace(/-/g, '_')
        const px = `bp_px_${id}`, b = `bp_b_${id}`, s = `bp_s_${id}`, r = `bp_r_${id}`
        const stmts = [
          declare(px, 'vec2', call('floor', [fragCoord('yDown')], 'vec2')),
          // Single-arg raw: one text, mechanically translated (mod → sombra_mod).
          raw(`vec3 ${b} = vec3(mod(${px}.x, 9.0), floor(${px}.x / 9.0), mod(${px}.y, 9.0)) / 8.0;
  vec3 ${s} = vec3(floor(${px}.y / 9.0), mod(${px}.x + ${px}.y, 9.0), mod(${px}.x * 7.0 + ${px}.y * 3.0, 9.0)) / 8.0;`),
        ]
        const enc = (v: string) => (linear ? call('sombra_toLin', [variable(v, 'vec3')], 'vec3') : variable(v, 'vec3'))
        let acc = call(names[0], [enc(b), enc(s)], 'vec3')
        for (const n of names.slice(1)) acc = call(n, [acc, enc(s)], 'vec3')
        stmts.push(declare(r, 'vec3', linear ? call('sombra_toSrgb', [acc], 'vec3') : acc))
        stmts.push(declare(ctx.outputs.color, 'vec4', construct('vec4', [variable(r, 'vec3'), literal('float', 1)])))
        return stmts
      }

      registryMod.nodeRegistry.register({
        type: 'test_blend_probe',
        label: 'Test Blend Probe',
        category: 'effect',
        inputs: [],
        outputs: [{ id: 'color', label: 'Color', type: 'color' }],
        params: [],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        glsl: (ctx: any) => {
          const modes = ctx.params.modes as string[]
          const linear = ctx.params.space === 'linear'
          ctx.uniforms.add('u_resolution')
          const names = modes.map((m) => blendMod.addBlendGLSL(ctx, m))
          if (linear) ctx.functionRegistry.set('sombra_color_helpers', colorMod.COLOR_GLSL_HELPERS)
          return glslBackend.lowerNodeOutputToGLSL({ statements: probeStatements(ctx, names, linear), uniforms: [], standardUniforms: new Set() }).join('\n  ')
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ir: (ctx: any) => {
          const modes = ctx.params.modes as string[]
          const linear = ctx.params.space === 'linear'
          const names = modes.map((m) => blendMod.blendFunctionName(m))
          return {
            statements: probeStatements(ctx, names, linear),
            uniforms: [],
            standardUniforms: new Set<string>(['u_resolution']),
            functions: [
              ...(linear ? colorMod.COLOR_IR_HELPERS : []),
              ...modes.flatMap((m) => blendMod.blendIRFunctions(m)),
            ],
          }
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      void typesMod

      const buildPlan = (modes: string[], space: string) => {
        const nodes = [
          { id: 'p', type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: 'test_blend_probe', params: { modes, space } } },
          { id: 'out', type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: 'fragment_output', params: {} } },
        ]
        const edges = [{ id: 'e', source: 'p', sourceHandle: 'color', target: 'out', targetHandle: 'color' }]
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const plan: any = glslMod.compileGraph(nodes as any, edges as any)
        if (!plan.success) throw new Error(`glsl compile: ${JSON.stringify(plan.errors)}`)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ir = irMod.compileGraphIR(nodes as any, edges as any)
        if (!ir) throw new Error('ir compile returned null')
        plan.wgsl = irMod.toPlanWgsl(ir)
        return plan
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const open: Record<string, { canvas: HTMLCanvasElement; renderer: any } | null> = {}
      const renderer = async (backend: string) => {
        if (backend in open) return open[backend]
        try {
          const canvas = document.createElement('canvas')
          canvas.style.display = 'block'
          canvas.style.width = `${c.N}px`
          canvas.style.height = `${c.N}px`
          document.body.appendChild(canvas)
          const mod = backend === 'webgpu'
            ? await import(/* @vite-ignore */ `${c.base}src/webgpu/renderer.ts`)
            : await import(/* @vite-ignore */ `${c.base}src/webgl/renderer.ts`)
          const r = backend === 'webgpu' ? new mod.WebGPUShaderRenderer() : new mod.WebGL2ShaderRenderer()
          await r.init(canvas)
          r.setAnimated(false)
          open[backend] = { canvas, renderer: r }
        } catch {
          open[backend] = null
        }
        return open[backend]
      }

      const grab = (canvas: HTMLCanvasElement) => {
        const out = document.createElement('canvas')
        out.width = canvas.width
        out.height = canvas.height
        const ctx = out.getContext('2d', { willReadFrequently: true })!
        ctx.drawImage(canvas, 0, 0)
        const px = ctx.getImageData(0, 0, out.width, out.height).data
        let bin = ''
        for (let i = 0; i < px.length; i += 0x8000) bin += String.fromCharCode.apply(null, px.subarray(i, i + 0x8000) as unknown as number[])
        return { width: out.width, height: out.height, b64: btoa(bin) }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).__blend = async (req: { backend: string; modes: string[]; space: string }) => {
        try {
          const rr = await renderer(req.backend)
          if (!rr) return { ok: false, error: 'backend unavailable' }
          const plan = buildPlan(req.modes, req.space)
          const text: string = req.backend === 'webgpu'
            ? plan.wgsl.passes[plan.wgsl.passes.length - 1].shaderCode
            : plan.passes[plan.passes.length - 1].fragmentShader
          const defRe = req.backend === 'webgpu' ? /\bfn\s+(sombra_blend_\w+)\s*\(/g : /\b(?:vec3|float)\s+(sombra_blend_\w+)\s*\(/g
          const defined = [...text.matchAll(defRe)].map((m) => m[1])
          let uncaptured: string[] = []
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let dev: any = null
          const onErr = (e: Event) => uncaptured.push(String((e as GPUUncapturedErrorEvent).error?.message ?? e))
          if (req.backend === 'webgpu') {
            dev = rr.renderer.getDevice()
            dev.addEventListener('uncapturederror', onErr)
            const info = await dev.createShaderModule({ code: text }).getCompilationInfo()
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const errs = info.messages.filter((m: any) => m.type === 'error').map((m: any) => m.message)
            if (errs.length) { dev.removeEventListener('uncapturederror', onErr); return { ok: false, error: `WGSL: ${errs[0]}`, defined } }
          }
          const res = rr.renderer.updateRenderPlan(plan)
          if (!res.success) { dev?.removeEventListener('uncapturederror', onErr); return { ok: false, error: `updateRenderPlan: ${res.error}`, defined } }
          // Fragment Output's alpha is a uniform; without its value the
          // output is alpha 0 and every pixel reads back as transparent black.
          if (plan.userUniforms?.length) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            rr.renderer.updateUniforms(plan.userUniforms.map((u: any) => ({ name: u.name, value: u.value })))
          }
          rr.renderer.render()
          // Read back in the SAME task as the draw: WebGL2 has no
          // preserveDrawingBuffer, and a WebGPU canvas texture is consumed on
          // present — an await here reads a cleared canvas.
          const frame = grab(rr.canvas)
          if (dev) { await dev.queue.onSubmittedWorkDone(); dev.removeEventListener('uncapturederror', onErr) }
          if (uncaptured.length) return { ok: false, error: `uncaptured: ${uncaptured[0]}`, defined }
          uncaptured = []
          return { ok: true, defined, ...frame }
        } catch (e) {
          return { ok: false, error: String((e as Error)?.message ?? e) }
        }
      }
      return { webgpu: !!(await renderer('webgpu')), webgl2: !!(await renderer('webgl2')) }
    }, { base, N })

    const backends = (['webgpu', 'webgl2'] as const).filter((b) => avail[b])
    console.log(`  backends: ${backends.join(', ') || '(none)'}`)
    test('both backends are available — a skipped backend is a FAILURE here', () => {
      assert(backends.length === 2, `only ${backends.join(', ')} came up`)
    })

    const capture = (backend: string, modes: BlendMode[], space: Space) =>
      page.evaluate((r) => (window as unknown as { __blend: (q: unknown) => Promise<Capture> }).__blend(r), { backend, modes, space })

    /** Helper definitions a probe of `modes` must emit — this file's own list, not the library's. */
    const NON_SEP = ['sombra_blend_lum', 'sombra_blend_clipColor', 'sombra_blend_setLum', 'sombra_blend_sat', 'sombra_blend_setSat']
    const expectedDefs = (modes: BlendMode[]) => {
      const set = new Set<string>()
      for (const m of modes) {
        set.add(`sombra_blend_${m}`)
        if (m === 'vividLight') { set.add('sombra_blend_colorBurn'); set.add('sombra_blend_colorDodge') }
        if (['hue', 'saturation', 'color', 'luminosity'].includes(m)) NON_SEP.forEach((n) => set.add(n))
      }
      return set
    }

    let worst = 0
    const check = async (backend: string, modes: BlendMode[], space: Space) => {
      const cap = await capture(backend, modes, space)
      const label = `${modes.join('∘')} [${space}]`
      // 1. Mechanism: exactly the expected definitions, each exactly once.
      const want = expectedDefs(modes)
      const got = cap.defined ?? []
      const dupes = got.filter((n, i) => got.indexOf(n) !== i)
      assert(dupes.length === 0, `${label}: helper(s) defined more than once: ${JSON.stringify(dupes)}`)
      const missing = [...want].filter((n) => !got.includes(n))
      const extra = got.filter((n) => !want.has(n))
      assert(missing.length === 0, `${label}: missing helper definition(s) ${JSON.stringify(missing)}`)
      assert(extra.length === 0, `${label}: emitted helper(s) for modes not in the graph: ${JSON.stringify(extra)}`)
      assert(cap.ok, `${label}: ${cap.error}`)
      assert(cap.width === N && cap.height === N, `${label}: canvas is ${cap.width}×${cap.height}, expected ${N}×${N} — the lattice would be misread`)
      // 2. Outcome: every pixel against the CPU reference.
      const data = Buffer.from(cap.b64!, 'base64')
      let bad = 0, maxErr = 0, firstBad = ''
      let diffB = 0, diffS = 0
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const { b, s } = pair(x, y)
          const ref = reference(modes, space, b, s)
          const i = (y * N + x) * 4
          let pixErr = 0
          for (let ch = 0; ch < 3; ch++) pixErr = Math.max(pixErr, Math.abs(data[i + ch] - byte(ref[ch])))
          if (pixErr > maxErr) maxErr = pixErr
          if (pixErr > 1) {
            if (!bad) firstBad = `(${x},${y}) b=${b.map((v) => v.toFixed(3))} s=${s.map((v) => v.toFixed(3))} → gpu ${[data[i], data[i + 1], data[i + 2], data[i + 3]]} ref ${ref.map(byte)}`
            bad++
          }
          // Discrimination: would a skipped blend (output = backdrop or = source) be caught?
          if (ref.some((v, ch) => Math.abs(byte(v) - byte(b[ch])) > 1)) diffB++
          if (ref.some((v, ch) => Math.abs(byte(v) - byte(s[ch])) > 1)) diffS++
        }
      }
      worst = Math.max(worst, maxErr)
      const total = N * N
      assert(diffB > total * 0.05, `${label}: reference equals the BACKDROP on ${total - diffB}/${total} pixels — a skipped blend would pass`)
      if (modes.length > 1 || modes[0] !== 'normal') {
        assert(diffS > total * 0.05, `${label}: reference equals the SOURCE on ${total - diffS}/${total} pixels — a "normal" stand-in would pass`)
      }
      assert(bad === 0, `${label}: ${bad}/${total} pixels off by more than 1 LSB (max ${maxErr}); first ${firstBad}`)
    }

    for (const backend of backends) {
      for (const space of ['srgb', 'linear'] as const) {
        for (const m of BLEND_MODES) {
          test(`${backend} · ${m.id} [${space}]`, async () => { await check(backend, [m.id], space) })
        }
      }
      for (const chain of [['vividLight', 'colorBurn'], ['hue', 'saturation'], ['luminosity', 'color', 'colorDodge']] as BlendMode[][]) {
        test(`${backend} · chain ${chain.join('∘')} [srgb] — shared helpers dedup to one each`, async () => { await check(backend, chain, 'srgb') })
      }
    }

    test('the gate covers all 24 modes, no more and no fewer', () => {
      assert(BLEND_MODES.length === 24, `BLEND_MODES has ${BLEND_MODES.length} entries`)
      assert(new Set(BLEND_MODES.map((m) => m.id)).size === 24, 'BLEND_MODES has duplicate ids')
      for (const m of BLEND_MODES) assert(m.id in REF, `no CPU reference for ${m.id}`)
      assert(Object.keys(REF).length === 24, `CPU reference covers ${Object.keys(REF).length} modes`)
    })

    await run('blend-modes-gpu')
    console.log(`  worst per-channel error across every mode/space/backend: ${worst} LSB`)
  } finally {
    await browser?.close()
    await server?.close()
  }
}

await main()
