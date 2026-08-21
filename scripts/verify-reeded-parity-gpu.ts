/**
 * Reeded Glass pixel byte-equality gate — a repeatable digest of the node's
 * rendered output on a real GPU, so a refactor of src/nodes/transform/reeded-glass.ts
 * can be proven pixel-identical (same digest before and after).
 *
 * WHY A DIGEST, NOT A TOLERANCE. Unlike verify-coord-contract-gpu.ts (which
 * allows AA slack because it compares two DIFFERENT renders), this gate compares
 * a render to ITSELF across a refactor: the only honest pass condition is a
 * byte-for-byte identical output, so it hashes the entire RGBA buffer and prints
 * a stable digest to diff by eye or in CI.
 *
 * THE PROBE. A linear gradient (stretch mode → a smooth ramp along X) feeds
 * reeded_glass's `source` texture input; the ramp running across the ribs makes
 * every rib's refraction visible. reeded → fragment_output. The gradient renders
 * to a texture, reeded samples it (a real two-pass plan, the same pass boundary
 * the wgsl-multipass validator exercises for Reeded).
 *
 * THE BYTE-EQUALITY CONFIG (defaults here):
 *   frost = 0            frost's 16-tap gather goes through hardware bilinear
 *                        filtering, a KNOWN WebGPU-vs-WebGL2 divergence of up to
 *                        51 codes (see the node's emitFrostGather comment +
 *                        docs/research/2026-07-29-frost-backend-divergence.md).
 *                        The gate is only meaningful where that path is OFF.
 *   srt_translateX/Y = 0 translate is where a separate suspected divergence
 *                        lives; kept at 0 for the clean baseline, overridable
 *                        below to CHARACTERISE it later.
 *   direction = vertical vertical ribs, so the X ramp probes across them.
 *   ribWidth/ior/curvature/bow/scale/rotate = node defaults.
 *
 * DETERMINISM IS THE WHOLE POINT. If one backend does not produce an identical
 * digest across two renders in a single process, the gate is worthless — so it
 * renders + reads back TWICE per backend and reports whether the two digests
 * match. An unstable digest is reported as such, never hidden.
 *
 * Each backend has its OWN digest (WebGPU and WebGL2 legitimately differ pixel
 * for pixel — different rasterisers/filtering). The gate is per-backend
 * self-consistency, not cross-backend equality.
 *
 * Runs the real src/ modules via a throwaway Vite dev server imported into a
 * blank page on that origin, same rig as verify-coord-contract-gpu.ts /
 * verify-pass-resolution-gpu.ts. Headless, so devicePixelRatio = 1.
 *
 * Run:  npx tsx scripts/verify-reeded-parity-gpu.ts
 *   flags (all optional, override the byte-equality baseline):
 *     --tx=<px>      srt_translateX   (default 0)
 *     --ty=<px>      srt_translateY   (default 0)
 *     --rotate=<deg> srt_rotate       (default 0)
 *     --frost=<0..1> frost            (default 0 — non-zero is expected to break
 *                                      cross-backend equality; used to characterise)
 *     --size=<px>    render edge      (default 256)
 *     --backend=webgpu|webgl2|both    (default both)
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
// `any` at the page boundary: renderers, plans and capture results cross
// Playwright's serialization untyped, exactly as the sibling GPU scripts do.
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright-core'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

// --- CLI ---------------------------------------------------------------------
function flag(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const TX = Number(flag('tx', '0'))
const TY = Number(flag('ty', '0'))
const ROTATE = Number(flag('rotate', '0'))
const FROST = Number(flag('frost', '0'))
const SIZE = Number(flag('size', '256'))
const BACKEND_SEL = flag('backend', 'both')

/** The reeded_glass params under test. Defaults = the byte-equality config. */
const REEDED_PARAMS: Record<string, unknown> = {
  frost: FROST,
  srt_translateX: TX,
  srt_translateY: TY,
  srt_rotate: ROTATE,
  // Left implicit (node defaults): srt_scale=1, ribWidth=80, ior=1.5,
  // curvature=0.8, bow=1, grain=0, direction='vertical', ribType='straight'.
  direction: 'vertical',
}

// --- digest + sampling (Node side) ------------------------------------------
/** FNV-1a 32-bit over every byte, returned as 8 hex chars. Stable + fast; a
 *  single changed byte changes the digest. Paired with a plain additive sum as
 *  a second, independent witness (two hashes disagree only on a real change). */
function fnv1a(data: Uint8Array): string {
  let h = 0x811c9dc5 >>> 0
  for (let i = 0; i < data.length; i++) {
    h ^= data[i]
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
function byteSum(data: Uint8Array): number {
  let s = 0
  for (let i = 0; i < data.length; i++) s += data[i]
  return s
}
/** RGBA at a pixel, for a human-readable spot-check alongside the digest. */
function pixelAt(data: Uint8Array, size: number, x: number, y: number): string {
  const i = (y * size + x) * 4
  return `(${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]})`
}
function toBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

// --- in-page harness (real src/ modules, real renderers) --------------------
async function installHarness(page: Page, base: string): Promise<{ webgpu: boolean; webgl2: boolean }> {
  return await page.evaluate(async (c) => {
    const [nodesMod, glslMod, irMod] = await Promise.all([
      import(/* @vite-ignore */ `${c.base}src/nodes/index.ts`),
      import(/* @vite-ignore */ `${c.base}src/compiler/glsl-generator.ts`),
      import(/* @vite-ignore */ `${c.base}src/compiler/ir-compiler.ts`),
    ])
    nodesMod.initializeNodeLibrary()
    const compileGraph = glslMod.compileGraph
    const compileGraphIR = irMod.compileGraphIR

    const node = (id: string, type: string, params: Record<string, unknown>) =>
      ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params } })
    const edge = (id: string, s: string, sh: string, t: string, th: string) =>
      ({ id, source: s, sourceHandle: sh, target: t, targetHandle: th })

    /** gradient (X ramp) → reeded_glass.source → fragment_output. */
    function buildPlan(reededParams: Record<string, unknown>) {
      const nodes = [
        node('grad', 'gradient', { gradientType: 'linear', drawMode: 'stretch' }),
        node('reed', 'reeded_glass', reededParams),
        node('out', 'fragment_output', { anchor: 'center', alpha: 1, alphaOp: 'multiply', quality: 'high' }),
      ]
      const edges = [
        edge('e0', 'grad', 'color', 'reed', 'source'),
        edge('e1', 'reed', 'color', 'out', 'color'),
      ]
      const plan: any = compileGraph(nodes as any, edges as any)
      if (!plan.success) throw new Error(`glsl compile: ${JSON.stringify(plan.errors)}`)
      // compileGraph never fills plan.wgsl; every real caller merges IR in by hand
      // (src/embed/publish.ts) — do the same so the WebGPU renderer has its passes.
      const ir = compileGraphIR(nodes as any, edges as any)
      if (!ir) throw new Error('IR compile returned null')
      plan.wgsl = { passes: ir.passes }
      return plan
    }

    const open: Record<string, { canvas: HTMLCanvasElement; renderer: any } | null> = {}
    async function renderer(backend: string) {
      if (backend in open) return open[backend]
      try {
        const canvas = document.createElement('canvas')
        canvas.style.display = 'block'
        canvas.style.width = `${c.size}px`
        canvas.style.height = `${c.size}px`
        document.body.appendChild(canvas)
        const mod = backend === 'webgpu'
          ? await import(/* @vite-ignore */ `${c.base}src/webgpu/renderer.ts`)
          : await import(/* @vite-ignore */ `${c.base}src/webgl/renderer.ts`)
        const r = backend === 'webgpu' ? new mod.WebGPUShaderRenderer() : new mod.WebGL2ShaderRenderer()
        await r.init(canvas)
        // Pin: 'adaptive'/animated would render at 0.75x and time would advance,
        // making the digest describe a different frame each call.
        r.setAnimated(false)
        r.setQualityTier('high')
        open[backend] = { canvas, renderer: r }
      } catch {
        open[backend] = null
      }
      return open[backend]
    }

    /** Composite onto an opaque 2D canvas and read back as base64 RGBA. Must stay
     *  synchronous from render() to getImageData(): WebGL2 has no
     *  preserveDrawingBuffer, so an await would let the frame be discarded. */
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

    ;(window as any).__reed = {
      async capture(req: { backend: string; params: Record<string, unknown> }) {
        try {
          const rr = await renderer(req.backend)
          if (!rr) return { ok: false, error: 'backend unavailable' }
          const { canvas, renderer: r } = rr
          const plan = buildPlan(req.params)
          r.setAnchor([0.5, 0.5])
          const res = r.updateRenderPlan(plan)
          if (!res.success) throw new Error(`updateRenderPlan: ${res.error}`)
          // User uniforms carry the connectable/uniform param values (frost,
          // ribWidth, ...) — an unbound uniform reads as 0, so this is required.
          if (plan.userUniforms?.length) {
            r.updateUniforms(plan.userUniforms.map((u: any) => ({ name: u.name, value: u.value })))
          }
          r.render()
          return { ok: true, passCount: plan.passes.length, wgslPassCount: plan.wgsl.passes.length, ...grab(canvas) }
        } catch (e: any) {
          return { ok: false, error: String(e?.message ?? e) }
        }
      },
    }

    const avail = { webgpu: !!(await renderer('webgpu')), webgl2: !!(await renderer('webgl2')) }
    return avail
  }, { base, size: SIZE })
}

async function main() {
  let server: ViteDevServer | undefined
  let browser: Browser | undefined
  let exitCode = 0

  console.log('=== Reeded Glass pixel byte-equality gate ===')
  console.log(`  config: frost=${FROST} tx=${TX} ty=${TY} rotate=${ROTATE} size=${SIZE} backend=${BACKEND_SEL}`)
  console.log(`  reeded params: ${JSON.stringify(REEDED_PARAMS)}`)

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
    // tsx/esbuild keepNames wraps callbacks in __name(), absent in the page.
    await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f)' })
    await page.route('**/__reed.html', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>reeded parity</title>' }))
    await page.goto(`${origin}${base}__reed.html`)

    const avail = await installHarness(page, base)
    let backends = (['webgpu', 'webgl2'] as const).filter((b) => avail[b])
    if (BACKEND_SEL !== 'both') backends = backends.filter((b) => b === BACKEND_SEL)
    console.log(`  backends exercised: ${backends.join(', ') || '(none)'}`)
    if (backends.length === 0) throw new Error('no GPU backend available — a skip is a FAILURE here, the gate proved nothing')

    const cap = (backend: string) =>
      page.evaluate((r) => (window as any).__reed.capture(r), { backend, params: REEDED_PARAMS })

    for (const backend of backends) {
      console.log(`\n[${backend}]`)
      const r1 = await cap(backend)
      const r2 = await cap(backend)
      if (!r1.ok || !r2.ok) { console.log(`  [FAIL] capture failed — ${r1.error || r2.error}`); exitCode = 1; continue }

      const b1 = toBytes(r1.b64)
      const b2 = toBytes(r2.b64)
      const d1 = fnv1a(b1)
      const d2 = fnv1a(b2)
      const s1 = byteSum(b1)
      const s2 = byteSum(b2)
      const size = r1.width
      const stable = d1 === d2 && s1 === s2 && b1.length === b2.length

      console.log(`  render size: ${r1.width}x${r1.height}  passes: glsl=${r1.passCount} wgsl=${r1.wgslPassCount}  bytes: ${b1.length}`)
      console.log(`  run 1 digest: fnv1a=${d1} sum=${s1}`)
      console.log(`  run 2 digest: fnv1a=${d2} sum=${s2}`)
      console.log(`  IDENTICAL ACROSS RUNS: ${stable ? 'YES' : 'NO'}`)
      const pts: Array<[number, number]> = [
        [size >> 1, size >> 1],
        [size >> 2, size >> 1],
        [(size * 3) >> 2, size >> 1],
        [size >> 1, size >> 2],
        [10, 10],
      ]
      console.log(`  sample pixels (run 1): ${pts.map(([x, y]) => `[${x},${y}]=${pixelAt(b1, size, x, y)}`).join(' ')}`)
      console.log(`  ==> BASELINE DIGEST [${backend}] fnv1a=${d1}`)
      if (!stable) { console.log(`  [FAIL] ${backend} digest is NOT deterministic across two renders — gate is worthless for this backend`); exitCode = 1 }
    }
  } finally {
    await browser?.close()
    await server?.close()
  }

  console.log('\n' + '='.repeat(60))
  console.log(exitCode === 0 ? '  reeded-parity-gpu: digests captured and stable' : '  reeded-parity-gpu: FAILED (unstable or capture error)')
  console.log('='.repeat(60))
  process.exit(exitCode)
}

main().catch((e) => { console.error(e); process.exit(1) })
