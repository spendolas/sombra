/**
 * Does every coordinate a node OUTPUTS point the same way on WebGL2 and WebGPU?
 *
 * Sombra's pattern space is top-left origin (y down) on both backends — that is
 * what `auto_uv` and `fragCoord('yDown')` give. `fragCoord('native')` is each
 * backend's own framebuffer orientation (GLSL y-up, WGSL y-down) and is only for
 * indexing a texture rendered in that same orientation. A coordinate OUTPUT built
 * from the native space is y-up on WebGL2 and y-down on WebGPU, so anything that
 * consumes it (a noise or pattern field) renders vertically mirrored between the
 * two backends while both compile cleanly. Pixelate's `uv` shipped exactly that
 * (fixed 2026-11-18).
 *
 * WHAT IT CHECKS. Every vec2 output in the node registry must appear in AUDIT
 * below, either as a coordinate (with the scenes that exercise it) or as
 * not-a-coordinate with a reason. A new vec2 output that nobody audited fails
 * the gate. Each coordinate scene renders the output straight into Fragment
 * Output (x → red, y → green) and, separately, through a Noise node's coords,
 * on both backends. Then:
 *   - the two backends agree on the top-left and bottom-left pixels, and on the
 *     whole frame within a small tolerance;
 * Mechanism-engaged:
 *   - the output's variable is in BOTH backends' compiled shaders (the output is
 *     really wired into the frame);
 *   - the frame is not constant (direct scenes: green differs top vs bottom);
 *   - the frame is NOT its own vertical mirror, so a mirrored backend could not
 *     pass by accident (a flip-symmetric scene is reported as vacuous).
 *
 * Revert the pixelate fix (either codegen path) and this goes red.
 *
 * Run: npm run verify:uv-orientation:gpu
 */
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser } from 'playwright-core'
import { resolve } from 'node:path'
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import { ALL_NODES } from '../src/nodes/index'

const ROOT = resolve(import.meta.dirname, '..')
const S = 128 // square canvas, dpr 1: auto_uv spans 0.375..0.625, about one green level per two rows

interface Scene {
  label: string; params?: Record<string, unknown>; texture?: boolean
  /**
   * A divergence that is KNOWN and not fixed here, with the reason. The scene must still
   * diverge — once it agrees, the entry is stale and the gate fails until it is removed.
   */
  knownDivergent?: string
}
type Entry =
  | { coordinate: true; scenes: Scene[] }
  | { coordinate: false; reason: string }

/**
 * The audited list: `<nodeType>.<outputId>` for EVERY vec2 output in the registry.
 * Texture-mode scenes wire a Checkerboard into the node's `source`, which switches
 * the compiler's `coords` default from auto_uv to the native screen UV (the texture
 * sample base) — the second way a native coordinate can reach an output.
 */
const TEXTURE_MODE_SAMPLE_BASE = 'texture mode feeds `coords` the NATIVE screen UV (ir-compiler.ts / glsl-generator.ts ' +
  'texture-mode default), which is also the texture sample base; the output passes it through. ' +
  'Fixing it means converting every pass-texture sample in tile/polar/warp, which changes WebGL2 colour output — a separate change.'

const AUDIT: Record<string, Entry> = {
  'uv_transform.uv': { coordinate: true, scenes: [{ label: 'default' }, { label: 'rotated', params: { srt_rotate: 30 } }] },
  'warp.warped': { coordinate: true, scenes: [{ label: 'no source' }, { label: 'texture mode', texture: true, knownDivergent: TEXTURE_MODE_SAMPLE_BASE }] },
  'polar_coords.polar': {
    coordinate: true, scenes: [
      { label: 'forward', params: { centerX: 0.45, centerY: 0.4 } },
      { label: 'inverse', params: { mode: 'inverse' } },
      { label: 'forward, texture mode', params: { centerX: 0.45, centerY: 0.4 }, texture: true, knownDivergent: TEXTURE_MODE_SAMPLE_BASE },
    ],
  },
  'tile.uv': {
    coordinate: true, scenes: [
      { label: 'plain', params: { countX: 3, countY: 3 } },
      { label: 'mirror xy', params: { countX: 3, countY: 3, mirror: 'xy' } },
      { label: 'plain, texture mode', params: { countX: 3, countY: 3 }, texture: true, knownDivergent: TEXTURE_MODE_SAMPLE_BASE },
    ],
  },
  'pixelate.uv': {
    coordinate: true, scenes: [
      { label: 'no source', params: { pixelSize: 16 } },
      { label: 'texture mode', params: { pixelSize: 16 }, texture: true },
    ],
  },
  'reeded_glass.coords': { coordinate: true, scenes: [{ label: 'no source' }, { label: 'texture mode', texture: true }] },
  'vec2_constant.value': { coordinate: false, reason: 'a constant from params; no fragment position involved' },
  'resolution.resolution': { coordinate: false, reason: 'the canvas size, uniform across the frame' },
  'combine_vec2.vector': { coordinate: false, reason: 'packs its two float inputs; no fragment position of its own' },
}

/** Every vec2 output in the registry, as `<type>.<port>`. */
const VEC2_OUTPUTS = ALL_NODES.flatMap((n) => n.outputs.filter((o) => o.type === 'vec2').map((o) => `${n.type}.${o.id}`))

interface Case { name: string; type: string; port: string; params: Record<string, unknown>; texture: boolean; via: 'direct' | 'noise'; knownDivergent?: string }
const CASES: Case[] = Object.entries(AUDIT).flatMap(([key, e]) => {
  if (!e.coordinate) return []
  const [type, port] = key.split('.')
  return e.scenes.flatMap((s) => (['direct', 'noise'] as const).map((via): Case =>
    ({ name: `${key} ${s.label} (${via})`, type, port, params: s.params ?? {}, texture: !!s.texture, via, knownDivergent: s.knownDivergent })))
})

function graph(c: Case) {
  const node = (id: string, type: string, params: Record<string, unknown> = {}) =>
    ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params } })
  const nodes = [node('rn', c.type, c.params), node('out', 'fragment_output', {})]
  const edges: Array<{ id: string; source: string; sourceHandle: string; target: string; targetHandle: string }> = []
  if (c.via === 'direct') {
    edges.push({ id: 'e1', source: 'rn', sourceHandle: c.port, target: 'out', targetHandle: 'color' })
  } else {
    // Noise reads the coordinate as its field position — the real-world symptom.
    nodes.push(node('nz', 'noise', { noiseType: 'simplex', srt_scale: 0.25 }))
    edges.push({ id: 'e1', source: 'rn', sourceHandle: c.port, target: 'nz', targetHandle: 'coords' })
    edges.push({ id: 'e2', source: 'nz', sourceHandle: 'value', target: 'out', targetHandle: 'color' })
  }
  if (c.texture) {
    nodes.push(node('src', 'checkerboard', {}))
    edges.push({ id: 'e3', source: 'src', sourceHandle: 'color', target: 'rn', targetHandle: 'source' })
  }
  return { nodes, edges }
}

interface Frame { ok: boolean; error?: string; px?: number[]; shaderHas?: boolean }

const at = (px: number[], x: number, y: number) => { const i = (y * S + x) * 4; return [px[i], px[i + 1], px[i + 2]] }
const maxd = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])))
/** Share of pixels whose largest RGB difference exceeds `tol`, and the mean abs difference. */
function diff(a: number[], b: number[], tol = 3): { frac: number; mean: number } {
  let bad = 0, sum = 0
  for (let p = 0; p < a.length; p += 4) {
    let m = 0
    for (let ch = 0; ch < 3; ch++) { const d = Math.abs(a[p + ch] - b[p + ch]); m = Math.max(m, d); sum += d }
    if (m > tol) bad++
  }
  return { frac: bad / (a.length / 4), mean: sum / ((a.length / 4) * 3) }
}
/** Vertical mirror of an RGBA S×S image. */
function vflip(px: number[]): number[] {
  const out = new Array(px.length)
  for (let y = 0; y < S; y++) for (let i = 0; i < S * 4; i++) out[y * S * 4 + i] = px[(S - 1 - y) * S * 4 + i]
  return out
}
/** Mean green of the top and bottom eighths. */
function greenBands(px: number[]): { top: number; bottom: number } {
  const band = S / 8
  let t = 0, b = 0
  for (let y = 0; y < band; y++) for (let x = 0; x < S; x++) { t += at(px, x, y)[1]; b += at(px, x, S - 1 - y)[1] }
  return { top: t / (band * S), bottom: b / (band * S) }
}

async function main() {
  console.log(`  known divergent (not fixed here): ${CASES.filter((c) => c.knownDivergent).map((c) => c.name).join('; ')}`)
  // The audit must cover the registry exactly.
  test('every vec2 output in the registry is audited, and every audit entry still exists', () => {
    const missing = VEC2_OUTPUTS.filter((k) => !(k in AUDIT))
    const stale = Object.keys(AUDIT).filter((k) => !VEC2_OUTPUTS.includes(k))
    assert(missing.length === 0, `unaudited vec2 output(s): ${missing.join(', ')} — add them to AUDIT (coordinate scenes, or a reason it is not one)`)
    assert(stale.length === 0, `AUDIT names output(s) the registry no longer has: ${stale.join(', ')}`)
    for (const [k, e] of Object.entries(AUDIT)) {
      if (e.coordinate) assert(e.scenes.length > 0, `${k}: a coordinate output needs at least one scene`)
      else assert(e.reason.trim().length > 0, `${k}: a not-a-coordinate entry needs a reason`)
    }
  })

  let server: ViteDevServer | undefined
  let browser: Browser | undefined
  try {
    server = await createServer({ configFile: resolve(ROOT, 'vite.config.ts'), root: ROOT, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } })
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    if (!url) throw new Error('vite gave no local URL')
    const base = new URL(url).pathname.replace(/\/?$/, '/')
    const origin = new URL(url).origin
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] })
    const page = await browser.newPage({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 1 })
    page.on('pageerror', (e) => console.error('  [page error]', e.message))
    await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f); { const FIXED = 1700000000000; Date.now = () => FIXED; }' })
    await page.route('**/__uv-orientation.html', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>uv orientation gate</title>' }))
    await page.goto(`${origin}${base}__uv-orientation.html`)

    const avail = await page.evaluate(async (c) => {
      const [nodesMod, glslMod, irMod, defMod] = await Promise.all([
        import(/* @vite-ignore */ `${c.base}src/nodes/index.ts`),
        import(/* @vite-ignore */ `${c.base}src/compiler/glsl-generator.ts`),
        import(/* @vite-ignore */ `${c.base}src/compiler/ir-compiler.ts`),
        import(/* @vite-ignore */ `${c.base}src/nodes/default-params.ts`),
      ])
      nodesMod.initializeNodeLibrary()
      const reg = (await import(/* @vite-ignore */ `${c.base}src/nodes/registry.ts`)).nodeRegistry
      const mods: Record<string, unknown> = {
        webgpu: await import(/* @vite-ignore */ `${c.base}src/webgpu/renderer.ts`),
        webgl2: await import(/* @vite-ignore */ `${c.base}src/webgl/renderer.ts`),
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).__frame = async (req: { g: { nodes: any[]; edges: any[] }; backend: string; probe: string }) => {
        try {
          // Fill every param with its default, as the editor does on create.
          for (const n of req.g.nodes) n.data.params = { ...defMod.defaultParams(reg.get(n.data.type)), ...n.data.params }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const plan: any = glslMod.compileGraph(req.g.nodes, req.g.edges)
          if (!plan.success) return { ok: false, error: JSON.stringify(plan.errors) }
          if (req.backend === 'webgpu') plan.wgsl = irMod.toPlanWgsl(irMod.compileGraphIR(req.g.nodes, req.g.edges))
          const canvas = document.createElement('canvas')
          canvas.width = c.S; canvas.height = c.S; canvas.style.width = `${c.S}px`; canvas.style.height = `${c.S}px`
          document.body.appendChild(canvas)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const mod: any = mods[req.backend]
          const r = req.backend === 'webgpu' ? new mod.WebGPUShaderRenderer() : new mod.WebGL2ShaderRenderer()
          await r.init(canvas)
          r.setAnimated(false)
          r.setTimeSource?.(() => 0)
          const res = r.updateRenderPlan(plan)
          if (!res.success) return { ok: false, error: res.error }
          r.setAnchor([0.5, 0.5])
          r.updateUniforms(plan.userUniforms.map((u: { name: string; value: unknown }) => ({ name: u.name, value: u.value })))
          r.markAllDirty?.()
          r.render()
          const o = document.createElement('canvas'); o.width = c.S; o.height = c.S
          const ctx = o.getContext('2d', { willReadFrequently: true })!
          ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.S, c.S); ctx.drawImage(canvas, 0, 0)
          const px = Array.from(ctx.getImageData(0, 0, c.S, c.S).data)
          const src = req.backend === 'webgpu'
            ? plan.wgsl.passes.map((p: { shaderCode: string }) => p.shaderCode).join('\n')
            : plan.passes.map((p: { fragmentShader: string }) => p.fragmentShader).join('\n')
          if (req.backend === 'webgpu') await r.getDevice().queue.onSubmittedWorkDone()
          r.dispose?.(); canvas.remove()
          return { ok: true, px, shaderHas: src.includes(req.probe) }
        } catch (e) { return { ok: false, error: String((e as Error)?.stack ?? e) } }
      }
      const open: Record<string, boolean> = {}
      for (const b of ['webgpu', 'webgl2']) {
        try {
          const cv = document.createElement('canvas'); cv.width = 4; cv.height = 4
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const mod: any = mods[b]
          const r = b === 'webgpu' ? new mod.WebGPUShaderRenderer() : new mod.WebGL2ShaderRenderer()
          await r.init(cv); r.dispose?.(); open[b] = true
        } catch { open[b] = false }
      }
      return open
    }, { base, S })

    const backends = (['webgpu', 'webgl2'] as const).filter((b) => avail[b])
    console.log(`  backends: ${backends.join(', ') || '(none)'} · ${CASES.length} scenes from ${Object.values(AUDIT).filter((e) => e.coordinate).length} coordinate outputs`)
    test('both backends are available — a skipped backend is a FAILURE here', () => {
      assert(backends.length === 2, `only ${backends.join(', ')} came up`)
    })

    const frame = async (backend: string, c: Case): Promise<Frame> => {
      const r: Frame = await page.evaluate((q) => (window as unknown as { __frame: (q: unknown) => Promise<Frame> }).__frame(q),
        { g: graph(c), backend, probe: `node_rn_${c.port}` })
      if (!r.ok) throw new Error(`${backend}: ${r.error ?? 'no frame'}`)
      return r
    }
    const pct = (x: number) => `${(x * 100).toFixed(2)}%`
    const worst = { agree: -1, agreeName: '', flip: 2, flipName: '' }

    if (backends.length === 2) {
      for (const c of CASES.filter((k) => k.knownDivergent)) {
        test(`${c.name} — KNOWN divergence still present (remove the entry once fixed)`, async () => {
          const gpu = await frame('webgpu', c)
          const gl = await frame('webgl2', c)
          assert(!!gpu.shaderHas && !!gl.shaderHas, `node_rn_${c.port} is missing from a compiled shader`)
          const whole = diff(gpu.px!, gl.px!)
          assert(whole.frac > 0.05, `the backends now agree (${pct(whole.frac)} of pixels differ) — this divergence is fixed; drop knownDivergent from the scene`)
        })
      }
      for (const c of CASES.filter((k) => !k.knownDivergent)) {
        test(`${c.name} — WebGL2 and WebGPU agree on orientation`, async () => {
          const gpu = await frame('webgpu', c)
          const gl = await frame('webgl2', c)
          assert(!!gpu.shaderHas && !!gl.shaderHas, `node_rn_${c.port} is missing from a compiled shader (webgpu ${gpu.shaderHas}, webgl2 ${gl.shaderHas}) — the output is not wired into the frame`)
          const a = gpu.px!, b = gl.px!
          // Not constant, and not its own mirror — otherwise a flipped backend passes for free.
          const self = diff(a, vflip(a))
          if (self.frac < worst.flip) { worst.flip = self.frac; worst.flipName = c.name }
          assert(self.frac > 0.2, `the WebGPU frame is nearly its own vertical mirror (${pct(self.frac)} of pixels differ) — the scene cannot detect a flip`)
          if (c.via === 'direct') {
            const g = greenBands(a)
            assert(Math.abs(g.top - g.bottom) > 8, `green barely changes top→bottom (${g.top.toFixed(1)} vs ${g.bottom.toFixed(1)}) — the coordinate is not reaching the frame`)
          }
          const tl = [at(a, 0, 0), at(b, 0, 0)], bl = [at(a, 0, S - 1), at(b, 0, S - 1)]
          const whole = diff(a, b)
          if (whole.frac > worst.agree) { worst.agree = whole.frac; worst.agreeName = c.name }
          const mirrored = diff(a, vflip(b))
          assert(maxd(tl[0], tl[1]) <= 6, `top-left differs: WebGPU [${tl[0]}] vs WebGL2 [${tl[1]}]`)
          assert(maxd(bl[0], bl[1]) <= 6, `bottom-left differs: WebGPU [${bl[0]}] vs WebGL2 [${bl[1]}]`)
          assert(whole.frac <= 0.01 && whole.mean <= 1.0,
            `frames differ on ${pct(whole.frac)} of pixels (mean ${whole.mean.toFixed(2)}); against a vertically mirrored WebGL2 frame: ${pct(mirrored.frac)} (mean ${mirrored.mean.toFixed(2)})`)
        })
      }
    }
    await run('verify-uv-orientation-gpu')
    console.log(`  worst backend disagreement: ${pct(worst.agree)} of pixels (${worst.agreeName}; limit 1%)`)
    console.log(`  least flip-sensitive scene: ${pct(worst.flip)} of pixels change under a mirror (${worst.flipName}; floor 20%)`)
  } finally {
    await browser?.close()
    await server?.close()
  }
}

await main()
