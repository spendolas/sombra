/**
 * Does setting ONE ramp-stop knob's alpha to 0 make exactly that stop's band
 * transparent — on both backends — and leave every other pixel unchanged?
 * (SR-2; the host dissolves a palette colour by colour this way.)
 *
 * Scene: a horizontal Gradient's `value` drives a Color Ramp labelled
 * `site.palette` with 4 opaque stops at 0, .25, .5, .75 and CONSTANT
 * interpolation, so every pixel is exactly one stop's colour. The stop
 * uniforms are looked up through the published manifest keys
 * (`site-palette-stop-<n>`), i.e. the way a host addresses them.
 *
 * Read-back composites the canvas over black and over white in the same task
 * as the draw: that pair gives premultiplied colour and alpha exactly.
 *
 * Mechanism-engaged: every band must be non-empty in the baseline (otherwise
 * "the band went transparent" is vacuous), the baseline must be fully opaque,
 * the knob must change pixels (band alpha 255 → 0), and the knob's uniform must
 * be in the compiled shader on that backend. A renderer that ignored the
 * uniform, or a codegen that baked the colour, keeps the band opaque.
 *
 * Run: npm run verify:ramp-knobs:gpu
 */
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser } from 'playwright-core'
import { resolve } from 'node:path'
import { test, run, assert } from './blur-bakeoff/lib/test-util'

const ROOT = resolve(import.meta.dirname, '..')
const W = 64
const H = 8

const STOP_COLORS: Array<[number, number, number, number]> = [
  [0.086, 0.027, 0.035, 1],   // #160709-ish "off"
  [1.0, 0.4, 0.1, 1],
  [0.2, 0.8, 0.4, 1],
  [0.3, 0.4, 1.0, 1],
]

function graph() {
  const node = (id: string, type: string, params: Record<string, unknown>, label?: string) =>
    ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params, ...(label ? { label } : {}) } })
  return {
    nodes: [
      node('g', 'gradient', { gradientType: 'linear', drawMode: 'stretch', p0u: 0, p0v: 0.5, p1u: 1, p1v: 0.5 }),
      node('ramp', 'color_ramp', {
        interpolation: 'constant',
        stops: [0, 0.25, 0.5, 0.75].map((position, k) => ({ position, color: STOP_COLORS[k] })),
      }, 'site.palette'),
      node('out', 'fragment_output', {}),
    ],
    edges: [
      { id: 'e1', source: 'g', sourceHandle: 'value', target: 'ramp', targetHandle: 't' },
      { id: 'e2', source: 'ramp', sourceHandle: 'color', target: 'out', targetHandle: 'color' },
    ],
  }
}

type Px = { black: number[]; white: number[] }
interface Frame { ok: boolean; error?: string; black?: number[]; white?: number[]; w?: number; h?: number; shaderHas?: boolean }

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
    await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f)' })
    await page.route('**/__ramp.html', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>ramp knobs gate</title>' }))
    await page.goto(`${origin}${base}__ramp.html`)

    const g = graph()
    const setup = await page.evaluate(async (c) => {
      const [nodesMod, glslMod, irMod, manifestMod] = await Promise.all([
        import(/* @vite-ignore */ `${c.base}src/nodes/index.ts`),
        import(/* @vite-ignore */ `${c.base}src/compiler/glsl-generator.ts`),
        import(/* @vite-ignore */ `${c.base}src/compiler/ir-compiler.ts`),
        import(/* @vite-ignore */ `${c.base}src/embed/manifest.ts`),
      ])
      nodesMod.initializeNodeLibrary()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const plan: any = glslMod.compileGraph(c.g.nodes, c.g.edges)
      if (!plan.success) return { error: JSON.stringify(plan.errors) }
      plan.wgsl = irMod.toPlanWgsl(irMod.compileGraphIR(c.g.nodes, c.g.edges))
      const manifest = manifestMod.buildManifest(plan.userUniforms, c.g.nodes)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const open: Record<string, any> = {}
      const mk = async (backend: string) => {
        try {
          const canvas = document.createElement('canvas')
          canvas.style.display = 'block'; canvas.style.width = `${c.W}px`; canvas.style.height = `${c.H}px`
          document.body.appendChild(canvas)
          const mod = backend === 'webgpu' ? await import(/* @vite-ignore */ `${c.base}src/webgpu/renderer.ts`) : await import(/* @vite-ignore */ `${c.base}src/webgl/renderer.ts`)
          const r = backend === 'webgpu' ? new mod.WebGPUShaderRenderer() : new mod.WebGL2ShaderRenderer()
          await r.init(canvas)
          r.setAnimated(false)
          const res = r.updateRenderPlan(plan)
          if (!res.success) return null
          open[backend] = { canvas, r }
          return true
        } catch { return null }
      }
      const over = (canvas: HTMLCanvasElement, bg: string) => {
        const out = document.createElement('canvas'); out.width = canvas.width; out.height = canvas.height
        const ctx = out.getContext('2d', { willReadFrequently: true })!
        ctx.fillStyle = bg; ctx.fillRect(0, 0, out.width, out.height); ctx.drawImage(canvas, 0, 0)
        return Array.from(ctx.getImageData(0, 0, out.width, out.height).data)
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).__frame = async (req: { backend: string; overrides: Record<string, number[]> }) => {
        const o = open[req.backend]
        if (!o) return { ok: false, error: 'backend unavailable' }
        // Every upload from the plan's defaults, then the host's overrides on top.
        o.r.updateUniforms(plan.userUniforms.map((u: { name: string; value: unknown }) => ({ name: u.name, value: req.overrides[u.name] ?? u.value })))
        o.r.markAllDirty?.()
        o.r.render()
        const black = over(o.canvas, '#000'); const white = over(o.canvas, '#fff')
        if (req.backend === 'webgpu') await o.r.getDevice().queue.onSubmittedWorkDone()
        const src = req.backend === 'webgpu' ? plan.wgsl.passes.map((p: { shaderCode: string }) => p.shaderCode).join('\n') : plan.passes.map((p: { fragmentShader: string }) => p.fragmentShader).join('\n')
        return { ok: true, black, white, w: o.canvas.width, h: o.canvas.height, shaderHas: Object.keys(req.overrides).every((n) => src.includes(n)) }
      }
      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stops: manifest.filter((k: any) => k.group === 'stops' && k.nodeId === 'ramp').map((k: any) => ({ key: k.key, uniform: k.uniform, default: k.default })),
        webgpu: !!(await mk('webgpu')), webgl2: !!(await mk('webgl2')),
      }
    }, { base, W, H, g })

    if ('error' in setup) throw new Error(`compile failed: ${setup.error}`)
    const backends = (['webgpu', 'webgl2'] as const).filter((b) => setup[b])
    console.log(`  backends: ${backends.join(', ') || '(none)'}`)

    test('both backends are available — a skipped backend is a FAILURE here', () => {
      assert(backends.length === 2, `only ${backends.join(', ')} came up`)
    })
    test('the manifest exposes site-palette-stop-0..3 with the authored RGBA', () => {
      assert(setup.stops.map((s) => s.key).join() === 'site-palette-stop-0,site-palette-stop-1,site-palette-stop-2,site-palette-stop-3', setup.stops.map((s) => s.key).join())
      setup.stops.forEach((s, k) => assert(JSON.stringify(s.default) === JSON.stringify(STOP_COLORS[k]), `stop ${k} default ${JSON.stringify(s.default)}`))
    })

    const frame = async (backend: string, overrides: Record<string, number[]>): Promise<Px & { shaderHas: boolean }> => {
      const r = await page.evaluate((q) => (window as unknown as { __frame: (q: unknown) => Promise<Frame> }).__frame(q), { backend, overrides })
      if (!r.ok) throw new Error(r.error)
      return { black: r.black!, white: r.white!, shaderHas: r.shaderHas! }
    }
    const alphaAt = (p: Px, i: number) => 255 - (p.white[i * 4] - p.black[i * 4])
    const q = (x: number) => Math.round(x * 255)

    for (const backend of backends) {
      const base0 = await frame(backend, {})
      const n = base0.black.length / 4
      // Classify each pixel by its baseline colour → stop index.
      const band: number[] = []
      for (let i = 0; i < n; i++) {
        const rgb = [base0.black[i * 4], base0.black[i * 4 + 1], base0.black[i * 4 + 2]]
        band.push(STOP_COLORS.findIndex((c) => c.slice(0, 3).every((v, ch) => Math.abs(q(v) - rgb[ch]) <= 1)))
      }
      const counts = [0, 1, 2, 3].map((k) => band.filter((b) => b === k).length)

      test(`${backend}: baseline — opaque, every pixel is one stop, every band non-empty (${counts.join('/')})`, () => {
        for (let i = 0; i < n; i++) assert(alphaAt(base0, i) === 255, `pixel ${i} alpha ${alphaAt(base0, i)} in the baseline`)
        assert(band.every((b) => b >= 0), `${band.filter((b) => b < 0).length} pixels match no stop colour`)
        assert(counts.every((c) => c >= 4), `a band is (nearly) empty: ${counts.join('/')}`)
      })

      for (let k = 0; k < 4; k++) {
        const s = setup.stops[k]
        test(`${backend}: ${s.key} alpha → 0 makes exactly band ${k} transparent, all else unchanged`, async () => {
          const f = await frame(backend, { [s.uniform]: [...STOP_COLORS[k].slice(0, 3), 0] })
          assert(f.shaderHas, `${s.uniform} is not in the ${backend} shader`)
          let banded = 0, changedElsewhere = 0
          for (let i = 0; i < n; i++) {
            if (band[i] === k) {
              assert(alphaAt(f, i) === 0 && f.black[i * 4] === 0 && f.white[i * 4] === 255, `band pixel ${i} not fully transparent (alpha ${alphaAt(f, i)})`)
              banded++
            } else {
              for (let ch = 0; ch < 3; ch++) {
                if (f.black[i * 4 + ch] !== base0.black[i * 4 + ch] || f.white[i * 4 + ch] !== base0.white[i * 4 + ch]) { changedElsewhere++; break }
              }
            }
          }
          assert(banded === counts[k] && changedElsewhere === 0, `${changedElsewhere} pixels outside band ${k} changed`)
        })
      }

      test(`${backend}: all four stops at alpha 0 → every pixel transparent; restoring brings the baseline back byte-for-byte`, async () => {
        const all: Record<string, number[]> = {}
        setup.stops.forEach((s, k) => { all[s.uniform] = [...STOP_COLORS[k].slice(0, 3), 0] })
        const f = await frame(backend, all)
        for (let i = 0; i < n; i++) assert(alphaAt(f, i) === 0, `pixel ${i} alpha ${alphaAt(f, i)}`)
        const back = await frame(backend, {})
        assert(back.black.join() === base0.black.join() && back.white.join() === base0.white.join(), 'baseline not restored')
      })

      test(`${backend}: an RGB change on one stop recolours only its band (colour, not just alpha, is live)`, async () => {
        const s = setup.stops[2]
        const f = await frame(backend, { [s.uniform]: [1, 1, 0, 1] })
        for (let i = 0; i < n; i++) {
          const want = band[i] === 2 ? [255, 255, 0] : [base0.black[i * 4], base0.black[i * 4 + 1], base0.black[i * 4 + 2]]
          assert([0, 1, 2].every((ch) => f.black[i * 4 + ch] === want[ch]), `pixel ${i}: ${f.black.slice(i * 4, i * 4 + 3)} ≠ ${want}`)
        }
      })
    }
    await run('verify-ramp-knobs-gpu')
  } finally {
    await browser?.close()
    await server?.close()
  }
}

await main()
