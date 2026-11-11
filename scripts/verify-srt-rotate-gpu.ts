/**
 * Does the framework Rotate actually rotate Noise, FBM and Warp — on real GPUs,
 * both backends? (Added 2026-11-11 when the three gained 'rotate'; they had
 * scale + translate only.)
 *
 * Each scene is one node wired straight to Fragment Output on a square canvas,
 * anchor centre. The rotate uniform (the node's `srt_rotate`, looked up from
 * the compiled plan the way the editor uploads it) is set to 0, +90 and −90
 * with no recompile, and each frame is drawn and read back in the same task.
 *
 *  - Rotation-covariant scenes (every noise type on Noise; every noise type ×
 *    fractal mode on FBM; Warp with no source, whose colour is its warped
 *    coordinate): the node is a pure function of its SRT'd coordinate, so the
 *    +90 frame must equal the 0 frame rotated a quarter turn about the centre
 *    pixel-for-pixel (within a small tolerance for cos(90°) ≠ 0 in f32), and
 *    −90 the opposite quarter turn.
 *  - Warp in texture mode (a Checkerboard wired into `source`): the rotation
 *    turns only the noise field, not the sampled source, so the picture is not
 *    a rotated copy; the frame must change and +360 must come back to 0.
 *
 * Mechanism-engaged: the uniform must be present in that backend's compiled
 * shader; the +90 frame must differ from the 0 frame on a large share of
 * pixels; and it must NOT match the wrong-direction quarter turn (so a scene
 * with quarter-turn symmetry, or an ignored uniform, cannot pass). Strip
 * 'rotate' from a node, or break either codegen path, and this goes red.
 *
 * Run: npm run verify:srt-rotate:gpu
 */
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser } from 'playwright-core'
import { resolve } from 'node:path'
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import { NOISE_TYPE_OPTIONS } from '../src/nodes/noise/noise-functions'

const ROOT = resolve(import.meta.dirname, '..')
const S = 96 // square canvas, even: a quarter turn maps pixel centres onto pixel centres

type Kind = 'covariant' | 'changes'
interface Case { name: string; kind: Kind; type: string; params: Record<string, unknown>; texture?: boolean }

const NOISE = NOISE_TYPE_OPTIONS.map((o) => o.value)
const CASES: Case[] = [
  ...NOISE.map((n): Case => ({ name: `noise ${n}`, kind: 'covariant', type: 'noise', params: { noiseType: n, srt_scale: 0.08 } })),
  ...NOISE.flatMap((n) => ['standard', 'turbulence', 'ridged'].map((m): Case =>
    ({ name: `fbm ${n} ${m}`, kind: 'covariant', type: 'fbm', params: { noiseType: n, fractalMode: m, srt_scale: 0.15 } }))),
  ...NOISE.map((n): Case => ({ name: `warp ${n} (no source)`, kind: 'covariant', type: 'warp', params: { noiseType: n, srt_scale: 0.1 } })),
  { name: 'warp value depth 3 (no source)', kind: 'covariant', type: 'warp', params: { noiseType: 'value', warpDepth: '3', srt_scale: 0.1 } },
  ...['value', 'simplex', 'box', 'worley2d'].flatMap((n) => ['clamp', 'repeat', 'mirror'].map((e): Case =>
    ({ name: `warp ${n} ${e} (texture mode)`, kind: 'changes', type: 'warp', texture: true, params: { noiseType: n, edge: e, srt_scale: 0.1, strength: 0.6 } }))),
]

function graph(c: Case) {
  const node = (id: string, type: string, params: Record<string, unknown> = {}) =>
    ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params } })
  const nodes = [node('rn', c.type, c.params), node('out', 'fragment_output', {})]
  const edges = [{ id: 'e1', source: 'rn', sourceHandle: c.type === 'warp' ? 'color' : 'value', target: 'out', targetHandle: 'color' }]
  if (c.texture) {
    nodes.push(node('src', 'checkerboard', {}))
    edges.push({ id: 'e2', source: 'src', sourceHandle: 'color', target: 'rn', targetHandle: 'source' })
  }
  return { nodes, edges }
}

interface Frame { ok: boolean; error?: string; px?: number[]; shaderHas?: boolean }

/** Quarter turn of an RGBA S×S image: +1 → out(i,j) = in(S−1−j, i); −1 → out(i,j) = in(j, S−1−i). */
function quarter(px: number[], dir: 1 | -1): number[] {
  const out = new Array(px.length)
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const [si, sj] = dir === 1 ? [S - 1 - j, i] : [j, S - 1 - i]
      for (let ch = 0; ch < 4; ch++) out[(j * S + i) * 4 + ch] = px[(sj * S + si) * 4 + ch]
    }
  }
  return out
}
/** Share of pixels whose largest channel difference exceeds `tol`, and the mean abs difference. */
function diff(a: number[], b: number[], tol = 3): { frac: number; mean: number } {
  let bad = 0, sum = 0
  for (let p = 0; p < a.length; p += 4) {
    let m = 0
    for (let ch = 0; ch < 3; ch++) { const d = Math.abs(a[p + ch] - b[p + ch]); m = Math.max(m, d); sum += d }
    if (m > tol) bad++
  }
  return { frac: bad / (a.length / 4), mean: sum / ((a.length / 4) * 3) }
}

async function main() {
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
    await page.route('**/__srt-rotate.html', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>srt rotate gate</title>' }))
    await page.goto(`${origin}${base}__srt-rotate.html`)

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
      const open: Record<string, any> = {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).__frame = async (req: { g: { nodes: any[]; edges: any[] }; backend: string; rotate: number[] }) => {
        try {
          // Fill every param with its default, as the editor does on create.
          for (const n of req.g.nodes) n.data.params = { ...defMod.defaultParams(reg.get(n.data.type)), ...n.data.params }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const plan: any = glslMod.compileGraph(req.g.nodes, req.g.edges)
          if (!plan.success) return [{ ok: false, error: JSON.stringify(plan.errors) }]
          if (req.backend === 'webgpu') plan.wgsl = irMod.toPlanWgsl(irMod.compileGraphIR(req.g.nodes, req.g.edges))
          const rot = plan.userUniforms.find((u: { nodeId: string; paramId: string }) => u.nodeId === 'rn' && u.paramId === 'srt_rotate')
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
          if (!res.success) return [{ ok: false, error: res.error }]
          r.setAnchor([0.5, 0.5])
          const src = req.backend === 'webgpu' ? plan.wgsl.passes.map((p: { shaderCode: string }) => p.shaderCode).join('\n') : plan.passes.map((p: { fragmentShader: string }) => p.fragmentShader).join('\n')
          const frames: Array<{ ok: boolean; px?: number[]; shaderHas?: boolean; error?: string }> = []
          for (const deg of req.rotate) {
            r.updateUniforms(plan.userUniforms.map((u: { name: string; value: unknown }) => ({ name: u.name, value: rot && u.name === rot.name ? deg : u.value })))
            r.markAllDirty?.()
            r.render()
            const o = document.createElement('canvas'); o.width = c.S; o.height = c.S
            const ctx = o.getContext('2d', { willReadFrequently: true })!
            ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.S, c.S); ctx.drawImage(canvas, 0, 0)
            frames.push({ ok: true, px: Array.from(ctx.getImageData(0, 0, c.S, c.S).data), shaderHas: !!rot && src.includes(rot.name) })
          }
          if (req.backend === 'webgpu') await r.getDevice().queue.onSubmittedWorkDone()
          r.dispose?.(); canvas.remove()
          return frames
        } catch (e) { return [{ ok: false, error: String((e as Error)?.stack ?? e) }] }
      }
      // Probe each backend once.
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
    console.log(`  backends: ${backends.join(', ') || '(none)'} · ${CASES.length} scenes`)
    test('both backends are available — a skipped backend is a FAILURE here', () => {
      assert(backends.length === 2, `only ${backends.join(', ')} came up`)
    })

    const frames = async (backend: string, c: Case, rotate: number[]) => {
      const r: Frame[] = await page.evaluate((q) => (window as unknown as { __frame: (q: unknown) => Promise<Frame[]> }).__frame(q), { g: graph(c), backend, rotate })
      if (!r[0]?.ok) throw new Error(r[0]?.error ?? 'no frame')
      return r
    }
    const pct = (x: number) => `${(x * 100).toFixed(2)}%`
    // Worst observed margins, printed after the run so a tolerance creeping
    // toward its limit is visible before it fails.
    const worst = { cov: -1, covName: '', moved: 2, movedName: '' }
    const note = (name: string, cov: number, moved: number) => {
      if (cov > worst.cov) { worst.cov = cov; worst.covName = name }
      if (moved < worst.moved) { worst.moved = moved; worst.movedName = name }
    }

    for (const backend of backends) {
      for (const c of CASES) {
        if (c.kind === 'covariant') {
          test(`${backend}: ${c.name} — +90 is the 0 frame turned a quarter, −90 the other quarter`, async () => {
            const [f0, fp, fm] = await frames(backend, c, [0, 90, -90])
            assert(!!f0.shaderHas, 'the rotate uniform is not in the compiled shader')
            const moved = diff(fp.px!, f0.px!)
            assert(moved.frac > 0.2, `+90 barely differs from 0 (${pct(moved.frac)} of pixels) — rotation not engaged`)
            const want = diff(fp.px!, quarter(f0.px!, 1))
            const wrong = diff(fp.px!, quarter(f0.px!, -1))
            assert(want.frac <= 0.005 && want.mean <= 0.5, `+90 ≠ quarter turn of 0: ${pct(want.frac)} pixels off, mean ${want.mean.toFixed(3)}`)
            assert(wrong.frac > 0.2, `+90 also matches the OPPOSITE quarter turn (${pct(wrong.frac)} off) — scene is quarter-turn symmetric, test is vacuous`)
            const back = diff(fm.px!, quarter(f0.px!, -1))
            note(`${backend} ${c.name}`, Math.max(want.frac, back.frac), Math.min(moved.frac, wrong.frac))
            assert(back.frac <= 0.005 && back.mean <= 0.5, `−90 ≠ the opposite quarter turn: ${pct(back.frac)} pixels off`)
          })
        } else {
          test(`${backend}: ${c.name} — rotating the noise field changes the frame, +360 returns to 0`, async () => {
            const [f0, fp, f360, f0b] = await frames(backend, c, [0, 90, 360, 0])
            assert(!!f0.shaderHas, 'the rotate uniform is not in the compiled shader')
            assert(diff(f0b.px!, f0.px!, 0).frac === 0, 'two rotate=0 frames differ — non-deterministic render')
            const moved = diff(fp.px!, f0.px!)
            assert(moved.frac > 0.1, `+90 barely differs from 0 (${pct(moved.frac)} of pixels) — rotation not engaged`)
            const full = diff(f360.px!, f0.px!)
            note(`${backend} ${c.name}`, full.frac, moved.frac)
            assert(full.frac <= 0.01, `+360 does not return to 0: ${pct(full.frac)} pixels off`)
          })
        }
      }
    }
    await run('verify-srt-rotate-gpu')
    console.log(`  worst rotated-vs-expected mismatch: ${pct(worst.cov)} of pixels (${worst.covName}; limit 0.5%, 1% for 360)`)
    console.log(`  smallest change vs rotate=0 / wrong turn: ${pct(worst.moved)} (${worst.movedName}; floor 10–20%)`)
  } finally {
    await browser?.close()
    await server?.close()
  }
}

await main()
