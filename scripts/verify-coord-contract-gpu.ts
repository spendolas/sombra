/**
 * Tier-2 coordinate-contract differential, on real GPUs — the behavioural
 * catcher for "mixed-up UV" bugs that the static coord-hygiene lint can't judge
 * (docs/research/2026-08-19-coord-contract-scope.md).
 *
 * v1 checks RESIZE INVARIANCE for auto_uv generator nodes. auto_uv is
 * anchor-relative: at anchor=center, a pixel's UV depends only on its OFFSET
 * from centre, `Δ/(u_dpr·u_ref_size)+0.5`, NOT on canvas size. So the centre
 * NxN crop of a larger render must be byte-identical to an NxN render — the big
 * canvas only REVEALS more margin. A node that reads u_resolution where
 * u_ref_size belongs (content SCALES with canvas) breaks this.
 *
 * Mechanism-engaged (per the repo rule that a metric must be able to fail): for
 * each node we also crop the larger render at the WRONG offset (top-left, not
 * centre). That shows a different UV region, so it MUST differ from the small
 * render — proving the byte-diff isn't vacuously zero. Aligned≈0 AND
 * misaligned≫0 is the pass condition.
 *
 * Runs both backends via system Chrome (channel:'chrome', --enable-unsafe-webgpu,
 * headless), same rig as verify-pass-resolution-gpu.ts. dpr=1 headless.
 *
 * Run: npx tsx scripts/verify-coord-contract-gpu.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
// `any` is pragmatic here: the page-boundary values (renderers, plans, capture
// results) cross Playwright's serialization untyped, same as
// verify-pass-resolution-gpu.ts.
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright-core'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SMALL = 256
const LARGE = 512
const CROP = (LARGE - SMALL) / 2 // 128 — centre offset
/** Aligned centre-crop should be near byte-identical (same UV → same output).
 *  Allow a hair for GPU AA/rounding at feature edges. */
const ALIGNED_MAX_FRAC = 0.01
/** A wrong-offset crop shows a different UV region; for spatially-varying
 *  content it must differ well above this, or the metric is vacuous. */
const DISTINGUISH_MIN_FRAC = 0.05
/** Per-byte tolerance below which two samples count as equal (AA/dither noise). */
const BYTE_EPS = 6

type Frame = { width: number; height: number; data: Uint8Array }

function toFrame(res: { width: number; height: number; b64: string }): Frame {
  return { width: res.width, height: res.height, data: new Uint8Array(Buffer.from(res.b64, 'base64')) }
}

/** Extract an NxN block from `f` at (offset, offset). */
function crop(f: Frame, size: number, offset: number): Frame {
  const out = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    const srcStart = ((y + offset) * f.width + offset) * 4
    out.set(f.data.subarray(srcStart, srcStart + size * 4), y * size * 4)
  }
  return { width: size, height: size, data: out }
}

/** Fraction of bytes that differ by more than BYTE_EPS. */
function diffFrac(a: Frame, b: Frame): number {
  const n = Math.min(a.data.length, b.data.length)
  let d = 0
  for (let i = 0; i < n; i++) if (Math.abs(a.data[i] - b.data[i]) > BYTE_EPS) d++
  return d / n
}

// --- in-page harness (real src/ modules, real renderers) --------------------
async function installHarness(page: Page, base: string): Promise<{ webgpu: boolean; webgl2: boolean }> {
  return await page.evaluate(async (c) => {
    const [nodesMod, registryMod, glslMod, irMod] = await Promise.all([
      import(/* @vite-ignore */ `${c.base}src/nodes/index.ts`),
      import(/* @vite-ignore */ `${c.base}src/nodes/registry.ts`),
      import(/* @vite-ignore */ `${c.base}src/compiler/glsl-generator.ts`),
      import(/* @vite-ignore */ `${c.base}src/compiler/ir-compiler.ts`),
    ])
    nodesMod.initializeNodeLibrary()
    const compileGraph = glslMod.compileGraph
    const compileGraphIR = irMod.compileGraphIR
    const registry = registryMod.nodeRegistry

    const node = (id: string, type: string, params: Record<string, unknown>) =>
      ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params } })
    const edge = (id: string, s: string, sh: string, t: string, th: string) =>
      ({ id, source: s, sourceHandle: sh, target: t, targetHandle: th })

    function buildPlan(nodeType: string, params: Record<string, unknown>) {
      const def = registry.get(nodeType)
      if (!def) throw new Error(`unknown node ${nodeType}`)
      const out = (def.outputs.find((o: any) => o.type === 'color') || def.outputs[0])
      if (!out) throw new Error(`${nodeType} has no output`)
      const nodes = [
        node('n', nodeType, params),
        node('out', 'fragment_output', { anchor: 'center', alpha: 1, alphaOp: 'multiply', quality: 'high' }),
      ]
      const edges = [edge('e', 'n', out.id, 'out', 'color')]
      const plan: any = compileGraph(nodes as any, edges as any)
      if (!plan.success) throw new Error(`glsl: ${JSON.stringify(plan.errors)}`)
      const ir = compileGraphIR(nodes as any, edges as any)
      if (!ir) throw new Error('ir null')
      plan.wgsl = { passes: ir.passes }
      return plan
    }

    const open: Record<string, { canvas: HTMLCanvasElement; renderer: any } | null> = {}
    async function renderer(backend: string) {
      if (backend in open) return open[backend]
      try {
        const canvas = document.createElement('canvas')
        canvas.style.display = 'block'
        document.body.appendChild(canvas)
        const mod = backend === 'webgpu'
          ? await import(/* @vite-ignore */ `${c.base}src/webgpu/renderer.ts`)
          : await import(/* @vite-ignore */ `${c.base}src/webgl/renderer.ts`)
        const r = backend === 'webgpu' ? new mod.WebGPUShaderRenderer() : new mod.WebGL2ShaderRenderer()
        await r.init(canvas)
        r.setAnimated(false)
        r.setQualityTier('high')
        open[backend] = { canvas, renderer: r }
      } catch {
        open[backend] = null
      }
      return open[backend]
    }

    function grab(canvas: HTMLCanvasElement) {
      const out = document.createElement('canvas')
      out.width = canvas.width
      out.height = canvas.height
      const ctx = out.getContext('2d', { willReadFrequently: true })!
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, out.width, out.height)
      ctx.drawImage(canvas, 0, 0)
      const px = ctx.getImageData(0, 0, out.width, out.height).data
      let bin = ''
      const CH = 0x8000
      for (let i = 0; i < px.length; i += CH) bin += String.fromCharCode.apply(null, px.subarray(i, i + CH) as unknown as number[])
      return { width: out.width, height: out.height, b64: btoa(bin) }
    }

    ;(window as any).__cc = {
      async capture(req: { backend: string; nodeType: string; params: Record<string, unknown>; size: number }) {
        try {
          const rr = await renderer(req.backend)
          if (!rr) return { ok: false, error: 'backend unavailable' }
          const { canvas, renderer: r } = rr
          canvas.style.width = `${req.size}px`
          canvas.style.height = `${req.size}px`
          const plan = buildPlan(req.nodeType, req.params)
          r.setAnchor([0.5, 0.5])
          const res = r.updateRenderPlan(plan)
          if (!res.success) throw new Error(`updateRenderPlan: ${res.error}`)
          if (plan.userUniforms?.length) {
            r.updateUniforms(plan.userUniforms.map((u: any) => ({ name: u.name, value: u.value })))
          }
          r.render()
          return { ok: true, ...grab(canvas) }
        } catch (e: any) {
          return { ok: false, error: String(e?.message ?? e) }
        }
      },
    }

    const avail = { webgpu: !!(await renderer('webgpu')), webgl2: !!(await renderer('webgl2')) }
    return avail
  }, { base })
}

// --- node contracts ----------------------------------------------------------
// auto_uv generators are anchor-relative → resize-INVARIANT (centre-crop matches).
// Spatially-varying params so the misaligned-crop control genuinely differs.
const INVARIANT: Array<{ label: string; type: string; params: Record<string, unknown> }> = [
  { label: 'gradient(pinned)', type: 'gradient', params: { gradientType: 'linear', drawMode: 'pinned' } },
  { label: 'checkerboard', type: 'checkerboard', params: {} },
  { label: 'stripes', type: 'stripes', params: {} },
  { label: 'dots', type: 'dots', params: {} },
  { label: 'noise', type: 'noise', params: {} },
  { label: 'fbm', type: 'fbm', params: {} },
]
// REAL-node negative control: gradient STRETCH fills the canvas from v_uv, so it
// SCALES with size by design — resize-VARIANT. Asserting it does scale proves the
// invariance metric detects genuine resolution-dependence (not just rubber-stamps).
const VARIANT: Array<{ label: string; type: string; params: Record<string, unknown> }> = [
  { label: 'gradient(stretch)', type: 'gradient', params: { gradientType: 'linear', drawMode: 'stretch' } },
]
/** A resize-variant node's centre-crop must differ from the smaller render by at least this. */
const VARIANT_MIN_FRAC = 0.05

async function main() {
  let server: ViteDevServer | undefined
  let browser: Browser | undefined
  let failures = 0
  const fail = (m: string) => { console.log(`  [FAIL] ${m}`); failures++ }
  const pass = (m: string) => console.log(`  [PASS] ${m}`)

  try {
    server = await createServer({ configFile: resolve(ROOT, 'vite.config.ts'), root: ROOT, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } })
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    if (!url) throw new Error('vite gave no local URL')
    const base = new URL(url).pathname.endsWith('/') ? new URL(url).pathname : `${new URL(url).pathname}/`
    const origin = new URL(url).origin

    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] })
    const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } })
    page.on('pageerror', (e) => console.error('  [page error]', e.message))
    await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f)' })
    await page.route('**/__cc.html', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>coord-contract</title>' }))
    await page.goto(`${origin}${base}__cc.html`)

    const avail = await installHarness(page, base)
    const backends = (['webgpu', 'webgl2'] as const).filter((b) => avail[b])
    console.log(`  backends: ${backends.join(', ') || '(none)'}`)
    if (backends.length === 0) throw new Error('no GPU backend available — a skip is a FAILURE here')

    const cap = (backend: string, spec: { type: string; params: Record<string, unknown> }, size: number) =>
      page.evaluate((r) => (window as any).__cc.capture(r), { backend, nodeType: spec.type, params: spec.params, size })

    const alignedFrac = async (backend: string, spec: { type: string; params: Record<string, unknown> }) => {
      const s = await cap(backend, spec, SMALL)
      const l = await cap(backend, spec, LARGE)
      if (!s.ok || !l.ok) throw new Error(`capture failed — ${s.error || l.error}`)
      const small = toFrame(s), large = toFrame(l)
      if (large.width !== LARGE || small.width !== SMALL) throw new Error(`unexpected sizes ${small.width}/${large.width}`)
      return { aligned: diffFrac(crop(large, SMALL, CROP), small), misaligned: diffFrac(crop(large, SMALL, 0), small) }
    }

    for (const backend of backends) {
      console.log(`\n[${backend}] resize invariance (centre-crop of ${LARGE} vs ${SMALL})`)
      for (const spec of INVARIANT) {
        try {
          const { aligned, misaligned } = await alignedFrac(backend, spec)
          if (aligned > ALIGNED_MAX_FRAC) {
            fail(`${spec.label}: NOT resize-invariant — centre-crop differs ${(aligned * 100).toFixed(2)}% (content scales/shifts with canvas → u_resolution-vs-u_ref_size mixup?)`)
          } else if (misaligned < DISTINGUISH_MIN_FRAC) {
            fail(`${spec.label}: metric vacuous — misaligned crop only ${(misaligned * 100).toFixed(2)}% (content too uniform; pick varying params)`)
          } else {
            pass(`${spec.label}: resize-invariant (aligned ${(aligned * 100).toFixed(2)}% ≤ ${ALIGNED_MAX_FRAC * 100}%, misaligned ${(misaligned * 100).toFixed(2)}% proves metric bites)`)
          }
        } catch (e: any) { fail(`${spec.label}: ${e.message}`) }
      }
      console.log(`[${backend}] resize-variant controls (must scale with canvas)`)
      for (const spec of VARIANT) {
        try {
          const { aligned } = await alignedFrac(backend, spec)
          if (aligned >= VARIANT_MIN_FRAC) {
            pass(`${spec.label}: resize-variant as expected (centre-crop differs ${(aligned * 100).toFixed(2)}% — the metric detects real scaling)`)
          } else {
            fail(`${spec.label}: expected to SCALE with canvas but centre-crop only differs ${(aligned * 100).toFixed(2)}% — either it became anchor-relative or the metric is broken`)
          }
        } catch (e: any) { fail(`${spec.label}: ${e.message}`) }
      }
    }
  } finally {
    await browser?.close()
    await server?.close()
  }

  console.log('\n' + '='.repeat(60))
  console.log(failures === 0 ? '  coord-contract-gpu: all resize-invariance checks passed' : `  coord-contract-gpu: ${failures} FAILED`)
  console.log('='.repeat(60))
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
