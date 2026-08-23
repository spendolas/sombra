/**
 * Frame-scale invariance gate — guards the u_frame_scale/u_dpr split.
 *
 * This is the Task-1 GATE for the `u_frame_scale` refactor
 * (.superpowers/sdd/2026-08-23-frame-scale-export/): before any uniform is
 * split, prove that a scene-locked periodic feature renders at a CONSTANT
 * period in REFERENCE UNITS across the real export configs the app produces
 * (`src/export/framing.ts`), even though those configs vary canvas size AND
 * `u_dpr` independently. If this gate ever regresses once `u_frame_scale`
 * exists, the split broke composition-invariance.
 *
 * NODE CHOICE — why `pixelate`, not `stripes`. The brief that seeded this task
 * suggested `stripes` ("period/spacing in reference px, divides by
 * u_dpr*u_ref_size"). Checked against the actual source (stripes.ts, and
 * checkerboard.ts/dots.ts share the pattern): `coords` (auto_uv) already
 * carries a factor of 1/(u_dpr*u_ref_size), and stripes' own `period` divides
 * `width+gap` by that SAME factor again. Substituting into
 * `fract(coords.x/period)`, the (u_dpr*u_ref_size) term cancels completely —
 * algebra confirmed by direct numeric simulation (see task-1-report.md) — so a
 * Pattern-category stripe's DEVICE-PIXEL period is deliberately
 * `u_dpr`-INDEPENDENT ("pixel-accurate width/gap", the node's own docstring).
 * That is the opposite of what this gate needs: measuring stripes across
 * configs with different `u_dpr` (live-equiv=2, Fit=0.7805, Match/Reveal=1)
 * would show a genuine, real ~2.5x spread — not a broken gate, a wrong choice
 * of fixture.
 *
 * `pixelate` (src/nodes/distort/pixelate.ts) uses the opposite, CORRECT
 * convention for a reference-locked size: `pxl_size = pixelSize * u_dpr`
 * (device px), applied directly to raw `gl_FragCoord`, then converted back via
 * `/ (u_dpr * u_ref_size)` for its own UV output — the `u_dpr` MULTIPLIES
 * before it DIVIDES, so it cancels to a genuinely `u_dpr`-invariant
 * reference-space cell size (`pixelSize / u_ref_size`, exactly). This is also
 * the convention `scripts/verify-pass-size.ts` independently pins for pass
 * scaling ("a px-authored param keeps its cell index"). With NO source wired,
 * `pixelate` falls back to its own deterministic checkerboard
 * (`mod(cell.x+cell.y, 2)`) — periodic, scene-locked, and zero randomness, so
 * `noise`/dither's ban on non-determinism doesn't apply and doesn't bite here.
 *
 * MEASUREMENT. A single horizontal scanline near vertical centre, one channel
 * (the fallback pattern is greyscale: R=G=B). The pattern is unsoftened
 * (hard cell edges, no AA), so cell-boundary crossings are found by
 * thresholding at the row's own midpoint value and averaging consecutive
 * crossing spacings — that average IS `pxl_size` (device px). pixelate sizes
 * that cell by `u_frame_scale` ONLY, so `period_ref = period_device /
 * (frameScale * REF_SIZE)` must land on the same value across all five configs
 * — an exact algebraic invariant, not a fitted tolerance. Crucially, the
 * `supersample` config holds `frameScale` equal to `Fit` while doubling `uDpr`:
 * because density never enters the pattern, its `period_device` (and thus
 * `period_ref`) must match `Fit` exactly, proving the split holds.
 *
 * MECHANISM CHECK: a render that produced no detectable transitions (blank,
 * uniform, or a detector that silently returns 0) FAILS explicitly rather than
 * passing vacuously — see the "mechanism check" test below.
 *
 * FAIL-PROOF: this gate was run once with `period_ref` computed WITHOUT
 * dividing by `uDpr` (i.e. `period_device / REF_SIZE`) to confirm it reports
 * FAILURE — recorded in task-1-report.md — then reverted to the code below.
 *
 * Harness pattern copied from scripts/verify-pass-resolution-gpu.ts /
 * verify-coord-contract-gpu.ts: a throwaway Vite dev server + playwright-core
 * Chrome (`--enable-unsafe-webgpu`), a blank page on that origin, real `src/`
 * modules imported directly — no app, no worker, no React. Render mechanism is
 * the OFFSCREEN EXPORT renderer (`src/export/export-renderer.ts`), which is
 * purpose-built for exactly this: explicit `{timeSec, uDpr, anchor}` per
 * frame, arbitrary target size, deterministic readback.
 *
 * A run that never reaches WebGPU is a FAILURE, not a skip — silent green
 * skips are the exact failure mode this repo forbids.
 *
 * Run: npx tsx scripts/verify-frame-scale-invariance.ts
 */
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright-core'
import { resolve } from 'node:path'
import { test, run, assert } from './blur-bakeoff/lib/test-util'

const ROOT = resolve(import.meta.dirname, '..')

/**
 * The export configs under test — real production `src/export/framing.ts`
 * outputs for view = Match (877×1640), reproduced here as literal numbers so
 * this gate has no import-time dependency on framing.ts (it tests the
 * RENDERER's invariant, not the framing-choice function).
 *
 * `frameScale` (framing/zoom) and `uDpr` (device density) are now two INDEPENDENT
 * axes on `ExportFrameUniforms` (Task 7). The reference-locked pattern (pixelate)
 * scales its cell by `u_frame_scale` ONLY — density must not touch it — so the
 * device period varies with `frameScale` across configs and `period_ref` divides
 * by `frameScale` to recover the invariant.
 *
 * The 4 original export configs carry `dpr = 1` (a 1:1 export), except
 * `live-equiv` which represents the LIVE renderer where frameScale == dpr ==
 * deviceDpr (both 2). The 5th, `supersample`, is the deferred pure-density case
 * (Task 1 report §8): identical `frameScale` to `Fit` (0.7805) but `dpr = 2` —
 * proving that raising density alone leaves `period_ref` unmoved.
 */
const CONFIGS = [
  { name: 'live-equiv', width: 1754, height: 3280, frameScale: 2, uDpr: 2 },
  { name: 'Match', width: 877, height: 1640, frameScale: 1, uDpr: 1 },
  { name: 'Fit', width: 2048, height: 1280, frameScale: 0.7805, uDpr: 1 },
  { name: 'Reveal', width: 2048, height: 1280, frameScale: 1, uDpr: 1 },
  { name: 'supersample', width: 2048, height: 1280, frameScale: 0.7805, uDpr: 2 },
] as const

/** Pixelate's own param, reference px. Large enough for low quantisation error
 *  at every tested `uDpr` (min observed cell ≈ 25 device px at Fit). */
const PIXEL_SIZE = 32

/** How far apart `period_ref` may be across configs, as a fraction of the mean. */
const TOLERANCE_FRAC = 0.03

/** Minimum row contrast (max-min channel value) to call the pattern "present". */
const MIN_CONTRAST = 20

/** Minimum cell-boundary crossings needed for a trustworthy average spacing. */
const MIN_CROSSINGS = 8

interface CaptureReq {
  width: number
  height: number
  frameScale: number
  uDpr: number
}

interface CaptureRes {
  ok: boolean
  error?: string
  width: number
  height: number
  rowY: number
  /** Single-channel (R) luminance row, full width, at `rowY`. */
  row: number[]
  refSize: number
}

// ---------------------------------------------------------------------------
// Measurement (Node side)
// ---------------------------------------------------------------------------

/**
 * Average spacing between hard cell-boundary crossings on a row, in device px.
 * Thresholds at the row's own midpoint (min+max)/2 — valid because the
 * fallback pattern has NO softness/AA, so every transition is a hard step.
 * Returns `crossings: 0` (rather than throwing) for a flat row, so the
 * mechanism-check test can assert on it explicitly instead of the detector
 * silently reporting a vacuous "0 px period".
 */
function measureRowPeriod(row: number[]): { periodDevice: number; crossings: number; min: number; max: number } {
  let min = Infinity
  let max = -Infinity
  for (const v of row) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const mid = (min + max) / 2
  const xs: number[] = []
  let prevAbove = row[0] > mid
  for (let x = 1; x < row.length; x++) {
    const above = row[x] > mid
    if (above !== prevAbove) xs.push(x)
    prevAbove = above
  }
  if (xs.length < 2) return { periodDevice: 0, crossings: xs.length, min, max }
  const diffs: number[] = []
  for (let i = 1; i < xs.length; i++) diffs.push(xs[i] - xs[i - 1])
  const periodDevice = diffs.reduce((a, b) => a + b, 0) / diffs.length
  return { periodDevice, crossings: xs.length, min, max }
}

// ---------------------------------------------------------------------------
// In-page harness
// ---------------------------------------------------------------------------

/**
 * Installed once as `window.__frameScaleGate`. Written as a single stringified
 * function (Playwright serialises the source, so it may reference only its
 * own argument — same constraint as verify-pass-resolution-gpu.ts).
 */
async function installHarness(page: Page, cfg: { base: string }): Promise<{ webgpu: boolean }> {
  return await page.evaluate(async (c) => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const w = window as any

    const [nodesMod, glslMod, irMod, exportMod, imagesMod, constantsMod] = await Promise.all([
      import(/* @vite-ignore */ `${c.base}src/nodes/index.ts`),
      import(/* @vite-ignore */ `${c.base}src/compiler/glsl-generator.ts`),
      import(/* @vite-ignore */ `${c.base}src/compiler/ir-compiler.ts`),
      import(/* @vite-ignore */ `${c.base}src/export/export-renderer.ts`),
      import(/* @vite-ignore */ `${c.base}src/export/export-images.ts`),
      import(/* @vite-ignore */ `${c.base}src/renderer/constants.ts`),
    ])
    nodesMod.initializeNodeLibrary()
    const { compileGraph } = glslMod
    const { compileGraphIR } = irMod
    const { createExportRenderTarget } = exportMod
    const { decodeGraphImages } = imagesMod
    const REFERENCE_SIZE: number = constantsMod.REFERENCE_SIZE

    const node = (id: string, type: string, params: Record<string, unknown> = {}) =>
      ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params } })
    const edge = (id: string, s: string, sh: string, t: string, th: string) =>
      ({ id, source: s, sourceHandle: sh, target: t, targetHandle: th })

    // pixelate (unwired source → deterministic checkerboard fallback) → fragment_output.
    // No coords/source input wired: single pass, no texture boundary.
    const nodes = [
      node('px', 'pixelate', { pixelSize: c.pixelSize }),
      node('out', 'fragment_output', { anchor: 'center', alpha: 1, alphaOp: 'multiply', quality: 'high' }),
    ]
    const edges = [edge('e', 'px', 'color', 'out', 'color')]

    const plan: any = compileGraph(nodes as any, edges as any)
    if (!plan.success) throw new Error(`GLSL compile failed: ${JSON.stringify(plan.errors)}`)
    const ir = compileGraphIR(nodes as any, edges as any)
    if (!ir) throw new Error('IR compile returned null')
    plan.wgsl = { passes: ir.passes }

    const images = await decodeGraphImages(nodes as any)

    let device: any = null
    async function getDevice() {
      if (device) return device
      const adapter = await (navigator as any).gpu?.requestAdapter?.()
      if (!adapter) throw new Error('no WebGPU adapter')
      device = await adapter.requestDevice()
      return device
    }

    w.__frameScaleGate = {
      async capture(req: CaptureReq): Promise<CaptureRes> {
        try {
          const dev = await getDevice()
          const target = createExportRenderTarget(dev, plan, req.width, req.height, images)
          try {
            // All configs anchor-centered, per the task brief.
            target.renderFrame({ timeSec: 0, frameScale: req.frameScale, uDpr: req.uDpr, anchor: [0.5, 0.5] })
            const px = await target.readback()
            const rowY = Math.floor(req.height / 2)
            const row: number[] = new Array(req.width)
            for (let x = 0; x < req.width; x++) row[x] = px[(rowY * req.width + x) * 4] // R channel
            return { ok: true, width: req.width, height: req.height, rowY, row, refSize: REFERENCE_SIZE }
          } finally {
            target.dispose()
          }
        } catch (e: any) {
          return { ok: false, error: String(e?.message ?? e), width: 0, height: 0, rowY: 0, row: [], refSize: 0 }
        }
      },
    }

    let webgpu = false
    try {
      const gpu = (navigator as any).gpu
      if (gpu) webgpu = !!(await gpu.requestAdapter())
    } catch { webgpu = false }
    return { webgpu }
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }, { ...cfg, pixelSize: PIXEL_SIZE })
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

interface Row {
  name: string
  width: number
  height: number
  frameScale: number
  uDpr: number
  periodDevice: number
  periodRef: number
  crossings: number
  contrast: number
}

async function main(): Promise<void> {
  let server: ViteDevServer | null = null
  let browser: Browser | null = null
  const rows: Row[] = []
  let webgpuAvailable = false
  let setupError: string | undefined
  let refSize = 0

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
    const base = new URL(url).pathname.endsWith('/') ? new URL(url).pathname : `${new URL(url).pathname}/`
    const origin = new URL(url).origin

    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: ['--enable-unsafe-webgpu'],
    })
    const page = await browser.newPage({ viewport: { width: 640, height: 640 } })
    page.on('pageerror', (e) => console.error('  [page error]', e.message))
    // tsx compiles this file with esbuild's keepNames, which wraps named
    // functions in `__name(...)`; Playwright ships the callback SOURCE to the
    // page, where that helper does not exist — so provide it.
    await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f)' })
    await page.route('**/__gate.html', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>frame-scale gate</title>' }))
    await page.goto(`${origin}${base}__gate.html`)

    const avail = await installHarness(page, { base })
    webgpuAvailable = avail.webgpu
    console.log(`  webgpu available: ${webgpuAvailable}`)

    if (webgpuAvailable) {
      for (const cfg of CONFIGS) {
        const res = await page.evaluate(
          (r) => (window as never as { __frameScaleGate: { capture(r: CaptureReq): Promise<CaptureRes> } }).__frameScaleGate.capture(r),
          { width: cfg.width, height: cfg.height, frameScale: cfg.frameScale, uDpr: cfg.uDpr } as CaptureReq,
        )
        if (!res.ok) throw new Error(`capture ${cfg.name}: ${res.error}`)
        refSize = res.refSize
        const { periodDevice, crossings, min, max } = measureRowPeriod(res.row)
        rows.push({
          name: cfg.name,
          width: cfg.width,
          height: cfg.height,
          frameScale: cfg.frameScale,
          uDpr: cfg.uDpr,
          periodDevice,
          // pixelate sizes its cell by u_frame_scale ONLY, so the invariant
          // divides by frameScale (framing), not uDpr (density).
          periodRef: periodDevice / (cfg.frameScale * refSize),
          crossings,
          contrast: max - min,
        })
        console.log(`  ${cfg.name}: ${cfg.width}x${cfg.height} frameScale=${cfg.frameScale} uDpr=${cfg.uDpr} periodDevice=${periodDevice.toFixed(3)}px crossings=${crossings} contrast=${(max - min).toFixed(1)}`)
      }
    }
  } catch (e) {
    setupError = e instanceof Error ? e.message : String(e)
  } finally {
    await browser?.close()
    await server?.close()
  }

  // -----------------------------------------------------------------------
  // Gates
  // -----------------------------------------------------------------------

  test('harness reached the page without error', () => {
    assert(!setupError, `setup failed: ${setupError}`)
  })

  // A run that never touched WebGPU proved nothing — fail, do not skip.
  test('WebGPU was available and exercised', () => {
    assert(webgpuAvailable, 'no WebGPU adapter in the headless harness — this gate proved NOTHING, so it fails rather than reading green')
  })

  test('all five configs were captured', () => {
    assert(rows.length === CONFIGS.length, `expected ${CONFIGS.length} captures, got ${rows.length}`)
  })

  // --- Mechanism check: the detector must have actually found the pattern ---
  for (const row of rows) {
    test(`${row.name}: the checkerboard pattern is actually present (mechanism check)`, () => {
      assert(row.contrast >= MIN_CONTRAST,
        `row contrast ${row.contrast.toFixed(1)} < ${MIN_CONTRAST} — this looks like a blank/flat render, not a pattern; a blank frame must FAIL this gate, not pass it`)
      assert(row.crossings >= MIN_CROSSINGS,
        `only ${row.crossings} cell-boundary crossings found (need >= ${MIN_CROSSINGS}) — the period detector did not find a stable, repeating pattern`)
      assert(row.periodDevice > 0, `measured period_device is ${row.periodDevice} — detector found nothing`)
    })
  }

  // --- The invariant: period_ref constant across all five configs ---
  if (rows.length > 0) {
    const mean = rows.reduce((a, r) => a + r.periodRef, 0) / rows.length
    test('period_ref (reference units) is constant across all five export configs', () => {
      for (const row of rows) {
        const relErr = Math.abs(row.periodRef - mean) / mean
        assert(relErr <= TOLERANCE_FRAC,
          `${row.name}: period_ref=${row.periodRef.toFixed(6)} vs mean=${mean.toFixed(6)} — off by ${(relErr * 100).toFixed(2)}%, tolerance is ${(TOLERANCE_FRAC * 100).toFixed(0)}%`)
      }
    })
    console.log(`  mean period_ref: ${mean.toFixed(6)} (REF_SIZE=${refSize})`)
    for (const row of rows) {
      const relErr = Math.abs(row.periodRef - mean) / mean
      console.log(`    ${row.name}: period_ref=${row.periodRef.toFixed(6)} (${(relErr * 100).toFixed(3)}% from mean)`)
    }
  }

  await run('frame-scale-invariance')
}

main().catch((e) => {
  console.error(`✗ frame-scale-invariance: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
  process.exit(1)
})
