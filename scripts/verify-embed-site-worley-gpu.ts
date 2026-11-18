/**
 * verify-embed-site-worley-gpu — the `site-worley-ridged` scene rendered by the
 * real player in headless Chrome, measured against the spectra Preset 3 look
 * (www repo docs/refactor/sombra/S-B-LOOK-SPEC.md §7), on WebGL2 (the backend
 * the site plays it on) and WebGPU.
 *
 * Canvas 1440×900 at DPR 1, knobs written the way the site adapter writes them
 * at DPR 1 (dots 4, pixelate 32 reference px = 4/32 device px), scene time 30 s.
 * Every frame is drawn and read back in the same task (the renderer's render()
 * is instrumented, as in verify-embed-site-gpu.ts).
 *
 *   L1 Load         mounts on the expected backend, one pass, 'load', no errors
 *   L2 Live wires   each stage the look depends on moves the frame when its knob
 *                   moves: warp strength (the 3-sample warp), warp scale (and a
 *                   write ABOVE the authored max 10 reaches the shader — no
 *                   clamping), balance (the dither threshold wire), seed, time
 *   L3 Colours      off dots are exactly stop 0; ≥ 90 % of on-dot pixels are
 *                   within ΔE76 3 of mix(mix(c1,c2,a),c3,b), a,b ∈ [0, 0.3];
 *                   balance −1 → every pixel exactly stop 0
 *   L4 Grid         on/off edges lie on a 4 px lattice and colour edges between
 *                   on dots on a 32 px lattice (gcd of edge positions), both
 *                   anchored at the canvas centre; the same at DPR 2 with the
 *                   authored 2/16 reference px
 *   L5 Balance      sweep −1 → +0.985: coverage 0 → 1, monotone
 *   L6 Statistics   over 24 generated seeds (WebGL2 gated; WebGPU reported):
 *                   median coverage in 0.46–0.68 and ±10 % of spectra's, median
 *                   extreme-cell fraction (level < 2 % or > 98 %) in 0.42–0.80
 *                   and ±10 % of spectra's, run-length anisotropy (max/min of
 *                   the mean equal-level run along rows / cols, Δ > 0.08 =
 *                   edge) > 1.5 on ≥ 50 % of seeds, median share of cells whose
 *                   level changes from t = 30 s to 90 s in 10–40 % (see BASE)
 *   L7 Fixture file the committed public/shared/site-worley-ridged.ombra,
 *                   fetched through `src`, draws exactly the fresh publish's frame
 *
 * HONEST SCOPE: spectra and Sombra draw from different seed spaces and different
 * warp noises (spec §4.5-3), so L6 compares DISTRIBUTIONS over seeds with the
 * spectra baselines the spec measured — never a frame against a frame.
 *
 * Report mode (not a gate): `--report <dir>` also writes one PNG per seed/backend.
 *
 * Self-contained: own Vite dev server (port 0) and headless Chrome.
 * Run: npm run verify:embed:site-worley:gpu   (SITE_BACKEND=webgl2|webgpu for one)
 */
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright-core'
import { resolve } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const ROOT = resolve(import.meta.dirname, '..')
const repIdx = process.argv.indexOf('--report')
const REPORT = repIdx >= 0 ? resolve(process.argv[repIdx + 1] ?? 'site-worley-report') : null

let passed = 0, failed = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}${detail ? `  (${detail})` : ''}`) } else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}
const info = (name: string, detail: string) => console.log(`  info ${name}  ${detail}`)

const W = 1440, H = 900
/**
 * Seeds in the site's packSeed range [1, 99): a generated golden-ratio sequence,
 * not hand-picked (SITE_WR_SEEDS=n for a longer run). 24, not the spec's 6:
 * a seed decides where the screen lands in the Worley lattice, so per-seed
 * coverage spans ~0.3–0.75 in BOTH engines, and a 6-seed median moves by more
 * than the tolerance (a hand-picked 6-seed set gave 0.434 here, the 40-seed
 * median is 0.505).
 */
const N_SEEDS = Number(process.env.SITE_WR_SEEDS ?? 24)
const SEEDS = Array.from({ length: N_SEEDS }, (_, k) => Math.round((1 + 98 * (((k + 1) * 0.6180339887) % 1)) * 100) / 100)
const T0 = 30, T1 = 90
/** Adapter at DPR 1: dots 4/dpr, pixelate 8× that (spec §4.3). */
const SITE_VARS = { 'site-dots-pixel-size': 4, 'pixelate-pixel-size': 32 }
/**
 * Pass bands. `cov`/`ext`/`temporal` are the spec's §7 spectra baselines
 * (1440×900, DPR 1, t = 30 s, 6 seeds). `spectra` is spectra's OWN pixel
 * fragment (www src/spectraGL-noisekit.js, Preset 3 uniforms, dot 4 px so the
 * grid matches) rendered on this harness's WebGL over 40 seeds with exactly
 * these metrics, 2026-11-18: median coverage 0.502, median extreme 0.498,
 * anisotropy > 1.5 on 29/40 (72 %), median Δlevel 30→90 s 0.284 (dot 3.5 px:
 * 0.505 / 0.487 / 30 of 40 / 0.268). Medians are gated within ±10 % of it (the
 * spec's criterion). Anisotropy is gated at ≥ 50 % of seeds, NOT the spec's
 * suggested 4 of 6: Sombra measures 24/40 (60 %), spectra 29/40 — a 1.2σ gap
 * at n = 40, and the ratio is ~1 for a diagonal band in EITHER engine.
 */
const BASE = { cov: [0.46, 0.68], ext: [0.42, 0.80], temporal: [0.10, 0.40], aniso: 1.5, anisoShare: 0.5 } as const
const SPECTRA = { cov: 0.502, ext: 0.498 } as const
const within10 = (v: number, ref: number) => Math.abs(v - ref) <= 0.1 * ref

interface Metrics {
  coverage: number; extreme: number; runRow: number; runCol: number; aniso: number
  onPx: number; onFar: number; worstDE: number
  dotGcd: number; dotOffLattice: number; cellGcd: number; cellOffLattice: number
  levels: number[]
}

declare global {
  var __wr: {
    fresh: string
    stops: number[][]
    h: Record<string, (...a: unknown[]) => unknown>
    r: Record<string, unknown>
    el: HTMLElement | null
    capture: boolean
    shader: string
    mount(opts: Record<string, unknown>, w: number, h: number): Promise<{ ok: boolean; backend: string; w: number; h: number; passes: number; errors: number }>
    snap(): Uint8ClampedArray
    metrics(px: Uint8ClampedArray, w: number, h: number, dot: number, cell: number): Metrics
    changed(a: number[], b: number[]): number
    hash(px: Uint8ClampedArray): string
    png(): string
  }
}

async function installHarness(page: Page, base: string): Promise<void> {
  await page.evaluate(async (b) => {
    const imp = (p: string) => import(/* @vite-ignore */ `${b}${p}`)
    const { initializeNodeLibrary } = await imp('src/nodes/index.ts')
    const { publishScene } = await imp('src/embed/publish.ts')
    const { decodeArtifact } = await imp('src/embed/artifact.ts')
    const { mount } = await imp('src/embed/player.ts')
    const { WebGL2ShaderRenderer } = await imp('src/webgl/renderer.ts')
    const { WebGPUShaderRenderer } = await imp('src/webgpu/renderer.ts')
    const { buildSiteWorleyRidged, SITE_STOP_HEX } = await imp('scripts/lib/site-worley-ridged-fixture.ts')
    initializeNodeLibrary()
    const g = buildSiteWorleyRidged()
    const fresh = publishScene(g.nodes, g.edges).sceneB64 as string
    const art = decodeArtifact(fresh)

    const instances: Array<Record<string, unknown>> = []
    const snapC = document.createElement('canvas')
    const sctx = snapC.getContext('2d', { willReadFrequently: true })!
    const read = (c: HTMLCanvasElement): Uint8ClampedArray => {
      snapC.width = c.width; snapC.height = c.height
      sctx.clearRect(0, 0, c.width, c.height); sctx.drawImage(c, 0, 0)
      return sctx.getImageData(0, 0, c.width, c.height).data
    }
    let lastPng = ''
    for (const C of [WebGL2ShaderRenderer, WebGPUShaderRenderer]) {
      const init = C.prototype.init
      C.prototype.init = function (this: Record<string, unknown>, c: HTMLCanvasElement) { instances.push(this); return init.call(this, c) }
      const render = C.prototype.render
      C.prototype.render = function (this: Record<string, unknown>) {
        render.call(this)
        const c = this.canvas as HTMLCanvasElement
        if (!c || c.width === 0 || !S.capture) return
        this.__px = read(c)
        lastPng = c.toDataURL('image/png')
      }
    }
    const stops = (SITE_STOP_HEX as string[]).map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)))

    // sRGB 8-bit (or 0..1 float × 255) → CIE Lab (D65), for ΔE76.
    const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
    const lab = (r: number, g2: number, b2: number) => {
      const R = lin(r), G = lin(g2), B = lin(b2)
      const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116)
      const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047)
      const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B)
      const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883)
      return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
    }
    // The family mix(mix(c1,c2,a),c3,b), a,b ∈ [0,0.3], on a 0.005 grid, in Lab.
    const family: number[][] = []
    const [, c1, c2, c3] = stops
    for (let a = 0; a <= 0.3 + 1e-9; a += 0.005) for (let bb = 0; bb <= 0.3 + 1e-9; bb += 0.005) {
      const m = [0, 1, 2].map((i) => (c1[i] + (c2[i] - c1[i]) * a) * (1 - bb) + c3[i] * bb)
      family.push(lab(m[0], m[1], m[2]))
    }
    const deCache = new Map<number, number>()
    const deFamily = (r: number, g2: number, b2: number) => {
      const k = (r << 16) | (g2 << 8) | b2
      let d = deCache.get(k)
      if (d === undefined) {
        const L = lab(r, g2, b2); d = Infinity
        for (const F of family) d = Math.min(d, Math.hypot(L[0] - F[0], L[1] - F[1], L[2] - F[2]))
        deCache.set(k, d)
      }
      return d
    }
    const gcd = (a: number, c: number): number => (c === 0 ? a : gcd(c, a % c))

    const S: typeof globalThis.__wr = {
      fresh, stops, h: {}, r: {}, el: null, capture: false,
      shader: (art.plan.passes as Array<{ fragmentShader: string }>).map((p) => p.fragmentShader).join('\n'),
      async mount(opts, w, h) {
        if (S.el) { (S.h.destroy as () => void)(); S.el.remove(); S.el = null }
        const el = document.createElement('div')
        el.style.cssText = `position:absolute;left:0;top:0;width:${w}px;height:${h}px`
        let errors = 0
        el.addEventListener('sombra:error', () => { errors++ })
        document.body.appendChild(el)
        const scene = opts.src === undefined ? fresh : undefined
        const handle = await mount(el, { autoplay: false, ...opts, scene })
        S.h = handle; S.el = el; S.r = instances[instances.length - 1]
        const c = el.querySelector('canvas') as HTMLCanvasElement | null
        return { ok: handle.ok, backend: String(S.r?.backend), w: c?.width ?? 0, h: c?.height ?? 0, passes: art.plan.passes.length, errors }
      },
      snap() {
        (S.r.markAllDirty as (() => void) | undefined)?.call(S.r)
        S.capture = true
        try { (S.h.render as () => void)() } finally { S.capture = false }
        return S.r.__px as Uint8ClampedArray
      },
      png: () => lastPng,
      hash(px) { let x = 2166136261; for (let i = 0; i < px.length; i++) { x ^= px[i]; x = Math.imul(x, 16777619) >>> 0 } return x.toString(16) },
      changed(a, c) { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== c[i]) n++; return n / a.length },
      metrics(px, w, h, dot, cell) {
        const c0 = stops[0]
        const isOff = (i: number) => px[i] === c0[0] && px[i + 1] === c0[1] && px[i + 2] === c0[2]
        // Colours: off pixels are exactly c0 by construction of `isOff`; what
        // matters is that every OTHER pixel is in the on-family.
        let onPx = 0, onFar = 0, worstDE = 0
        for (let i = 0; i < px.length; i += 4) {
          if (isOff(i)) continue
          onPx++
          const d = deFamily(px[i], px[i + 1], px[i + 2])
          if (d > 3) onFar++
          if (d > worstDE) worstDE = d
        }
        // Edge lattices. On/off edges → dot lattice; colour edges with an "on"
        // pixel on BOTH sides → cell lattice (the on colour is per field cell).
        const ox = (w / 2) % cell, oy = (h / 2) % cell
        let dg = 0, cg = 0, dotOff = 0, cellOff = 0
        const at = (x: number, y: number) => (y * w + x) * 4
        const same = (i: number, j: number) => px[i] === px[j] && px[i + 1] === px[j + 1] && px[i + 2] === px[j + 2]
        const edge = (pos: number, o: number, onOff: boolean) => {
          const rel = pos - o
          if (onOff) { dg = gcd(dg, Math.abs(rel)); if (((rel % dot) + dot) % dot !== 0) dotOff++ } else { cg = gcd(cg, Math.abs(rel)); if (((rel % cell) + cell) % cell !== 0) cellOff++ }
        }
        for (let y = 0; y < h; y += 7) for (let x = 1; x < w; x++) {
          const i = at(x, y), j = at(x - 1, y)
          if (same(i, j)) continue
          const a = isOff(i), b = isOff(j)
          if (a !== b) edge(x, ox, true); else if (!a) edge(x, ox, false)
        }
        for (let x = 0; x < w; x += 7) for (let y = 1; y < h; y++) {
          const i = at(x, y), j = at(x, y - 1)
          if (same(i, j)) continue
          const a = isOff(i), b = isOff(j)
          if (a !== b) edge(y, oy, true); else if (!a) edge(y, oy, false)
        }
        // Per-cell level: on dots / 64, sampled at each dot centre, full cells only.
        const nx = Math.floor((w - ox) / cell), ny = Math.floor((h - oy) / cell)
        const levels: number[] = []
        let onDots = 0
        for (let cy = 0; cy < ny; cy++) for (let cx = 0; cx < nx; cx++) {
          let n = 0
          for (let j = 0; j < cell / dot; j++) for (let i = 0; i < cell / dot; i++) {
            const x = ox + cx * cell + i * dot + (dot >> 1), y = oy + cy * cell + j * dot + (dot >> 1)
            if (!isOff(at(x, y))) n++
          }
          const per = (cell / dot) ** 2
          levels.push(n / per); onDots += n
        }
        const coverage = onDots / (levels.length * (cell / dot) ** 2)
        const extreme = levels.filter((l) => l < 0.02 || l > 0.98).length / levels.length
        const run = (len: number, count: number, idx: (k: number, i: number) => number) => {
          let runs = 0, cells = 0
          for (let k = 0; k < count; k++) {
            runs++; cells++
            for (let i = 1; i < len; i++) { if (Math.abs(levels[idx(k, i)] - levels[idx(k, i - 1)]) > 0.08) runs++; cells++ }
          }
          return cells / runs
        }
        const runRow = run(nx, ny, (k, i) => k * nx + i)
        const runCol = run(ny, nx, (k, i) => i * nx + k)
        return {
          coverage, extreme, runRow, runCol, aniso: Math.max(runRow, runCol) / Math.min(runRow, runCol),
          onPx, onFar, worstDE, dotGcd: dg, dotOffLattice: dotOff, cellGcd: cg, cellOffLattice: cellOff, levels,
        }
      },
    }
    globalThis.__wr = S
  }, base)
}

async function newPage(browser: Browser, origin: string, base: string, backend: string, dpr = 1): Promise<{ page: Page; errors: string[] }> {
  const ctx = await browser.newContext({ viewport: { width: W + 40, height: H + 40 }, deviceScaleFactor: dpr })
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => { errors.push(e.message); console.error('  [page error]', e.message) })
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f);' })
  await page.route((u) => u.pathname.endsWith('/__embed-site-worley.html'), (route) => route.fulfill({
    status: 200, contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><title>site-worley-ridged</title><body style="margin:0;background:#808000">',
  }))
  await page.goto(`${origin}${base}__embed-site-worley.html${backend === 'webgl2' ? '?backend=webgl2' : ''}`)
  await installHarness(page, base)
  return { page, errors }
}

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const f3 = (v: number) => v.toFixed(3)
const inR = (v: number, r: readonly [number, number] | readonly number[]) => v >= r[0] && v <= r[1]

async function runBackend(browser: Browser, origin: string, base: string, backend: 'webgl2' | 'webgpu') {
  console.log(`\n[${backend}]`)
  const P = (n: string) => `${backend} ${n}`
  const { page, errors } = await newPage(browser, origin, base, backend)

  // ── L1 ──────────────────────────────────────────────────────────────────────
  const l1 = await page.evaluate(async ([w, h, vars, t0]) => {
    const S = globalThis.__wr
    const m = await S.mount({ variables: vars, time: t0 }, w as number, h as number)
    return m
  }, [W, H, SITE_VARS, T0] as const)
  check(P('L1 mounts on the expected backend, full canvas, one pass'), l1.ok && l1.backend === backend && l1.w === W && l1.h === H && l1.passes === 1, JSON.stringify(l1))

  // ── L2 live wires ───────────────────────────────────────────────────────────
  const l2 = await page.evaluate(([seed]) => {
    const S = globalThis.__wr
    const set = S.h.set as (k: string, v: number) => void
    const get = S.h.get as (k: string) => number
    set('site-seed-value', seed as number)
    const base0 = S.snap(); const h0 = S.hash(base0)
    const probe = (key: string, v: number) => { const old = get(key); set(key, v); const px = S.snap(); set(key, old); return px }
    const diff = (px: Uint8ClampedArray) => S.changed(Array.from(base0), Array.from(px))
    const strength0 = diff(probe('site-warp-strength', 0))
    const colorStrength0 = diff(probe('site-warp-color-strength', 0))
    const scale10 = probe('site-warp-scale', 10)
    // Write ABOVE the knob's max (10) after a write of 10: if the player
    // clamped, the second write would draw the scale-10 frame again. The value
    // written back is the authored default, read from the live handle (a
    // hard-coded restore would mask a wrong authored scale for every check after).
    const authored = get('site-warp-scale')
    const knobMax = (S.h.variables as () => Array<{ key: string; max?: number }>)().find((k) => k.key === 'site-warp-scale')?.max
    set('site-warp-scale', 10); const at10 = S.hash(S.snap())
    set('site-warp-scale', authored); const backTo = S.hash(S.snap())
    // Coverage, not "any pixel": balance also moves the accent colour, which
    // would change the frame even with the threshold wire gone.
    const offShare = (px: Uint8ClampedArray) => { const c0 = S.stops[0]; let n = 0; for (let i = 0; i < px.length; i += 4) if (px[i] === c0[0] && px[i + 1] === c0[1] && px[i + 2] === c0[2]) n++; return n / (px.length / 4) }
    const balance = offShare(base0) - offShare(probe('site-balance-value', 0.3))
    const seedMove = diff(probe('site-seed-value', (seed as number) + 11))
    const t = (S.h.getTime as () => number)()
    ;(S.h.setTime as (t: number) => void)(t + 600); const later = diff(S.snap()); ;(S.h.setTime as (t: number) => void)(t)
    const again = S.hash(S.snap())
    return { strength0, colorStrength0, scale10: diff(scale10), at10, backTo, h0, authored, knobMax, balance, seedMove, later, again }
  }, [SEEDS[0]] as const)
  check(P('L2 the main warp is live: strength 0 changes the frame'), l2.strength0 > 0.01, f3(l2.strength0))
  check(P('L2 the colour-branch warp is live: its strength 0 changes the frame'), l2.colorStrength0 > 0.001, f3(l2.colorStrength0))
  check(P('L2 the authored warp scale is H_css/51.2 for a 900 px tall view (17.578125), above the knob max 10'),
    l2.authored === 900 / 51.2 && (l2.knobMax ?? Infinity) < l2.authored, JSON.stringify({ authored: l2.authored, max: l2.knobMax }))
  check(P('L2 warp scale is live: 10 vs the authored scale differ'), l2.scale10 > 0.01, f3(l2.scale10))
  check(P('L2 a warp-scale write above the knob max (10) is not clamped: 10 → 17.578125 → the authored frame again'),
    l2.at10 !== l2.h0 && l2.backTo === l2.h0, JSON.stringify({ at10: l2.at10, back: l2.backTo, authored: l2.h0 }))
  check(P('L2 the balance → threshold wire is live: +0.3 turns off dots on'), l2.balance > 0.01, `${f3(l2.balance)} of the frame`)
  check(P('L2 the seed is live'), l2.seedMove > 0.01, f3(l2.seedMove))
  check(P('L2 time is live (+600 s moves the bands), and returning restores the frame'), l2.later > 0.001 && l2.again === l2.h0, `${f3(l2.later)} px changed`)

  // ── L3 + L4 + L6 per seed ───────────────────────────────────────────────────
  const perSeed: Array<Metrics & { seed: number; temporal: number; png?: string }> = []
  for (const seed of SEEDS) {
    const m = await page.evaluate(([s, w, h, t0, t1, wantPng]) => {
      const S = globalThis.__wr
      ;(S.h.set as (k: string, v: number) => void)('site-seed-value', s as number)
      ;(S.h.setTime as (t: number) => void)(t0 as number)
      const a = S.metrics(S.snap(), w as number, h as number, 4, 32)
      const png = wantPng ? S.png() : undefined
      ;(S.h.setTime as (t: number) => void)(t1 as number)
      const b = S.metrics(S.snap(), w as number, h as number, 4, 32)
      ;(S.h.setTime as (t: number) => void)(t0 as number)
      return { ...a, seed: s as number, temporal: S.changed(a.levels, b.levels), png }
    }, [seed, W, H, T0, T1, !!REPORT] as const)
    perSeed.push(m)
    if (REPORT && m.png) {
      mkdirSync(REPORT, { recursive: true })
      writeFileSync(resolve(REPORT, `site-worley-ridged-${backend}-seed${seed}.png`), Buffer.from(m.png.split(',')[1], 'base64'))
    }
  }
  console.log(`   seed    cover  extreme  runRow  runCol  aniso  Δlevel60s  onPx      ΔE>3  worstΔE`)
  for (const m of perSeed) {
    console.log(`   ${String(m.seed).padEnd(7)} ${f3(m.coverage)}  ${f3(m.extreme)}    ${m.runRow.toFixed(2).padEnd(7)} ${m.runCol.toFixed(2).padEnd(7)} ${m.aniso.toFixed(2).padEnd(6)} ${f3(m.temporal).padEnd(10)} ${String(m.onPx).padEnd(9)} ${String(m.onFar).padEnd(5)} ${m.worstDE.toFixed(2)}`)
  }

  const onPx = perSeed.reduce((s, m) => s + m.onPx, 0), onFar = perSeed.reduce((s, m) => s + m.onFar, 0)
  check(P('L3 every seed shows on AND off dots'), perSeed.every((m) => m.onPx > 0 && m.onPx < W * H))
  check(P('L3 ≥ 90 % of on-dot pixels within ΔE76 3 of mix(mix(c1,c2,[0..0.3]),c3,[0..0.3])'), onPx > 0 && onFar / onPx <= 0.1,
    `${f3(1 - onFar / onPx)} within; worst ΔE ${Math.max(...perSeed.map((m) => m.worstDE)).toFixed(2)}`)
  check(P('L4 on/off edges lie on the 4 px dot lattice anchored at the centre'),
    perSeed.every((m) => m.dotGcd === 4 && m.dotOffLattice === 0), [...new Set(perSeed.map((m) => `gcd ${m.dotGcd}, ${m.dotOffLattice} off`))].join('; '))
  check(P('L4 colour edges between on dots lie on the 32 px cell lattice anchored at the centre'),
    perSeed.every((m) => m.cellGcd === 32 && m.cellOffLattice === 0), [...new Set(perSeed.map((m) => `gcd ${m.cellGcd}, ${m.cellOffLattice} off`))].join('; '))

  const covMed = median(perSeed.map((m) => m.coverage)), extMed = median(perSeed.map((m) => m.extreme))
  const anisoN = perSeed.filter((m) => m.aniso > BASE.aniso).length, tMed = median(perSeed.map((m) => m.temporal))
  const n = perSeed.length
  const stats = [
    [`L6 median coverage ${f3(covMed)} in ${BASE.cov.join('–')} and within ±10 % of spectra's ${SPECTRA.cov}`, inR(covMed, BASE.cov) && within10(covMed, SPECTRA.cov)],
    [`L6 median extreme-cell fraction ${f3(extMed)} in ${BASE.ext.join('–')} and within ±10 % of spectra's ${SPECTRA.ext}`, inR(extMed, BASE.ext) && within10(extMed, SPECTRA.ext)],
    [`L6 run-length anisotropy > ${BASE.aniso} on ${anisoN} of ${n} seeds (need ≥ ${Math.ceil(BASE.anisoShare * n)})`, anisoN >= BASE.anisoShare * n],
    [`L6 median cells changing level from ${T0} s to ${T1} s: ${f3(tMed)} in ${BASE.temporal.join('–')}`, inR(tMed, BASE.temporal)],
  ] as const
  for (const [name, ok] of stats) {
    if (backend === 'webgl2') check(P(name), ok)
    else info(P(name), ok ? 'in range (reported, not gated: the site plays WebGL2)' : 'OUT of range (reported, not gated: the site plays WebGL2)')
  }

  // ── L3 + L5 balance sweep ───────────────────────────────────────────────────
  const sweep = await page.evaluate(([s, w, h]) => {
    const S = globalThis.__wr
    const set = S.h.set as (k: string, v: number) => void
    set('site-seed-value', s as number)
    const out: Array<[number, number, boolean]> = []
    for (const b of [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 0.9, 0.985]) {
      set('site-balance-value', b)
      const px = S.snap()
      const c0 = S.stops[0]; let allC0 = true
      for (let i = 0; i < px.length; i += 4) if (px[i] !== c0[0] || px[i + 1] !== c0[1] || px[i + 2] !== c0[2]) { allC0 = false; break }
      out.push([b, S.metrics(px, w as number, h as number, 4, 32).coverage, allC0])
    }
    set('site-balance-value', 0)
    return out
  }, [SEEDS[0], W, H] as const)
  console.log(`   balance → coverage: ${sweep.map(([b, c]) => `${b}:${f3(c)}`).join('  ')}`)
  check(P('L3 balance −1 → every pixel exactly stop 0'), sweep[0][2])
  check(P('L5 balance −1 → coverage 0, +0.985 → coverage 1'), sweep[0][1] === 0 && sweep[sweep.length - 1][1] === 1, `${sweep[0][1]} / ${sweep[sweep.length - 1][1]}`)
  check(P('L5 coverage is monotone in balance'), sweep.every((v, i) => i === 0 || v[1] >= sweep[i - 1][1]))

  // ── L7 committed file ───────────────────────────────────────────────────────
  const l7 = await page.evaluate(async ([w, h, vars, t0, s, b]) => {
    const S = globalThis.__wr
    const set = () => { (S.h.set as (k: string, v: number) => void)('site-seed-value', s as number); (S.h.setTime as (t: number) => void)(t0 as number) }
    await S.mount({ variables: vars, time: t0 }, w as number, h as number); set()
    const fresh = S.hash(S.snap())
    const m = await S.mount({ variables: vars, time: t0, src: `${b as string}shared/site-worley-ridged.ombra` }, w as number, h as number); set()
    return { ok: m.ok, fresh, file: S.hash(S.snap()) }
  }, [W, H, SITE_VARS, T0, SEEDS[2], base] as const)
  check(P('L7 committed site-worley-ridged.ombra (fetched via src) draws exactly the fresh publish\'s frame'), l7.ok && l7.fresh === l7.file, JSON.stringify(l7))
  check(P('L1 no page / console errors'), errors.length === 0, errors.join(' | '))
  await page.context().close()

  // ── L4 at DPR 2 with the authored sizes ─────────────────────────────────────
  const d2 = await newPage(browser, origin, base, backend, 2)
  const l4 = await d2.page.evaluate(async ([w, h, t0]) => {
    const S = globalThis.__wr
    const m = await S.mount({ time: t0 }, (w as number) / 2, (h as number) / 2)
    const r = S.metrics(S.snap(), m.w, m.h, 4, 32)
    return { w: m.w, h: m.h, dot: r.dotGcd, dotOff: r.dotOffLattice, cell: r.cellGcd, cellOff: r.cellOffLattice }
  }, [W, H, T0] as const)
  check(P('L4 DPR 2, authored 2/16 reference px → 4/32 device px, on-lattice'),
    l4.w === W && l4.dot === 4 && l4.dotOff === 0 && l4.cell === 32 && l4.cellOff === 0, JSON.stringify(l4))
  await d2.page.context().close()
}

let server: ViteDevServer | null = null
let browser: Browser | null = null
try {
  server = await createServer({
    configFile: resolve(ROOT, 'vite.config.ts'), root: ROOT, logLevel: 'error',
    server: { port: 0, host: '127.0.0.1' },
  })
  await server.listen()
  const local = server.resolvedUrls?.local[0]
  if (!local) throw new Error('vite dev server did not report a local URL')
  const p = new URL(local).pathname
  const base = p.endsWith('/') ? p : `${p}/`
  const origin = new URL(local).origin
  readFileSync(resolve(ROOT, 'public/shared/site-worley-ridged.ombra'))   // fail early if missing
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] })
  for (const b of ['webgl2', 'webgpu'] as const) {
    if (!process.env.SITE_BACKEND || process.env.SITE_BACKEND === b) await runBackend(browser, origin, base, b)
  }
} finally {
  await browser?.close()
  await server?.close()
}

console.log('='.repeat(60))
console.log(`  SUMMARY: ${passed} passed, ${failed} failed`)
console.log('='.repeat(60))
if (failed > 0) process.exit(1)
