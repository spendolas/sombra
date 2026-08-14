/**
 * verify:video-export — the permanent, mechanism-engaged regression gate for
 * client-side video export.
 *
 * Unlike `self-validate` (which GPU-compiles shader *strings* in a blank page),
 * this gate exercises the WHOLE export path — export renderer, engine, the 3
 * sinks, framing, and quality — inside a real browser, then DECODES every
 * artifact and asserts on the decoded bytes/pixels. A static or broken export
 * fails a decode assertion; none of these checks pass when the mechanism under
 * test is skipped (see the per-assertion notes below).
 *
 * How it runs, and why:
 *   - The engine + sinks are real TS modules that import the compiler, the node
 *     library, `mediabunny`, and WebGPU. They cannot load in a blank page — they
 *     need the vite-served app. So this script spawns `vite` itself, drives a
 *     headless Chrome page at `/sombra/`, builds known graphs via `window.__sombra`,
 *     and dynamic-imports the export modules (the proven runner pattern).
 *   - DECODE uses MediaBunny (`Input`/`VideoSampleSink`) + fflate (`unzipSync`),
 *     imported by their explicit ESM paths so raw page code can load them.
 *     (This is a second MediaBunny instance from the sinks' encode instance;
 *     they only ever exchange Blob bytes, so the "loaded twice" console warning
 *     is benign here.)
 *   - The first `import` of a bare dep (mediabunny, inside a sink) makes vite
 *     optimize deps and reload the page once, destroying the execution context.
 *     A prewarm pass + a retry wrapper absorb that reload.
 *
 * Self-contained: spawns vite on a fixed test port and kills it in `finally`.
 * Exit code is non-zero if ANY assertion fails; a sink unsupported on the host
 * SKIPS (never fails) its assertions and is logged — no silent caps.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { chromium, type Page } from 'playwright-core'

const PORT = 5209
const APP_URL = `http://localhost:${PORT}/sombra/`

// ---------------------------------------------------------------------------
// Config handed to the in-page assertion function (page.evaluate serializes the
// function; it can close over NOTHING from Node, so everything travels here).
// ---------------------------------------------------------------------------
interface Cfg {
  W: number
  H: number
  fps: number
  /** frames for the 12-frame round-trip / determinism / png checks */
  dur12: number
  /** frames for the quality check (more frames = a clearer bitrate signal) */
  dur20: number
  engineUrl: string
  webmUrl: string
  pngUrl: string
  sinksIndexUrl: string
  registryUrl: string
  mediabunnyUrl: string
  fflateUrl: string
}

const CFG: Cfg = {
  W: 160,
  H: 90,
  fps: 12,
  dur12: 12 / 12, // 12 frames
  dur20: 20 / 12, // 20 frames
  engineUrl: '/sombra/src/export/export-engine.ts',
  webmUrl: '/sombra/src/export/sinks/webm-alpha.ts',
  pngUrl: '/sombra/src/export/sinks/png-sequence.ts',
  sinksIndexUrl: '/sombra/src/export/sinks/index.ts',
  registryUrl: '/sombra/src/export/registry.ts',
  mediabunnyUrl: '/sombra/node_modules/mediabunny/dist/modules/src/index.js',
  fflateUrl: '/sombra/node_modules/fflate/esm/browser.js',
}

interface CheckResult {
  name: string
  status: 'pass' | 'fail' | 'skip'
  detail: string
}
interface EvalResult {
  checks: CheckResult[]
  logs: string[]
}

// ---------------------------------------------------------------------------
// In-page assertion body. Runs entirely in the browser — references only its
// `cfg` argument, browser globals, and functions/types declared inside it.
// ---------------------------------------------------------------------------
async function runAssertions(cfg: Cfg): Promise<EvalResult> {
  // --- minimal shapes for the dynamically-imported modules (erased at runtime) ---
  interface SombraBridge {
    clearGraph(): void
    createNode(type: string, position?: { x: number; y: number }, params?: Record<string, unknown>): string
    connect(src: string, tgt: string, srcPort?: string, tgtPort?: string): string
  }
  interface FramingChoice {
    uDpr: number
    anchor: [number, number]
  }
  interface ExportJob {
    sink: unknown
    width: number
    height: number
    fps: number
    durationSec: number
    alpha: boolean
    matte?: string
    quality: 'draft' | 'good' | 'high' | 'max'
    framing: FramingChoice
  }
  interface SinkLike {
    readonly id: string
    isSupported(): Promise<boolean>
  }
  interface EngineModule {
    runExport(job: ExportJob, onProgress: (f: number, t: number) => void): Promise<Blob>
  }
  interface WebmModule {
    makeWebmAlphaSink(): SinkLike
  }
  interface PngModule {
    makePngSequenceSink(): SinkLike
  }
  interface RegistryModule {
    getSinks(): SinkLike[]
    getAvailableSinks(ent: { pro: boolean }): Promise<SinkLike[]>
  }
  interface MbSample {
    readonly displayWidth: number
    readonly displayHeight: number
    draw(ctx: OffscreenCanvasRenderingContext2D, dx: number, dy: number): void
    close(): void
  }
  interface MbTrack {
    readonly displayWidth: number
    readonly displayHeight: number
    canBeTransparent(): Promise<boolean>
  }
  interface MbInput {
    getPrimaryVideoTrack(): Promise<MbTrack | null>
  }
  interface MbVideoSampleSink {
    samples(): AsyncGenerator<MbSample, void, unknown>
    getSample(timestamp: number): Promise<MbSample | null>
  }
  interface MediabunnyModule {
    Input: new (o: { source: unknown; formats: unknown }) => MbInput
    BlobSource: new (b: Blob) => unknown
    ALL_FORMATS: unknown
    VideoSampleSink: new (t: MbTrack) => MbVideoSampleSink
  }
  interface FflateModule {
    unzipSync(u8: Uint8Array): Record<string, Uint8Array>
  }

  const logs: string[] = []
  const checks: CheckResult[] = []
  const log = (m: string): void => {
    logs.push(m)
  }
  const pass = (name: string, detail: string): void => {
    checks.push({ name, status: 'pass', detail })
  }
  const fail = (name: string, detail: string): void => {
    checks.push({ name, status: 'fail', detail })
  }
  const skip = (name: string, detail: string): void => {
    checks.push({ name, status: 'skip', detail })
  }

  const S = (window as unknown as { __sombra: SombraBridge }).__sombra

  const engine = (await import(cfg.engineUrl)) as EngineModule
  const webm = (await import(cfg.webmUrl)) as WebmModule
  const png = (await import(cfg.pngUrl)) as PngModule
  await import(cfg.sinksIndexUrl) // side-effect: registers the 3 built-in sinks
  const registry = (await import(cfg.registryUrl)) as RegistryModule
  const MB = (await import(cfg.mediabunnyUrl)) as MediabunnyModule
  const FF = (await import(cfg.fflateUrl)) as FflateModule

  const framing: FramingChoice = { uDpr: 1, anchor: [0.5, 0.5] }
  const runExport = (job: ExportJob): Promise<Blob> => engine.runExport(job, () => {})

  // ---- decode helpers (independent MediaBunny decode instance) ----
  const openTrack = async (blob: Blob): Promise<MbTrack> => {
    const input = new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS })
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('no primary video track in decoded blob')
    return track
  }
  const countFrames = async (blob: Blob): Promise<{ n: number; dims: Array<[number, number]> }> => {
    const track = await openTrack(blob)
    const sink = new MB.VideoSampleSink(track)
    let n = 0
    const dims: Array<[number, number]> = []
    for await (const s of sink.samples()) {
      n++
      dims.push([s.displayWidth, s.displayHeight])
      s.close()
    }
    return { n, dims }
  }
  // Draw the sample at `tSec` to an alpha-enabled 2D canvas and read one texel's
  // straight (un-premultiplied) RGBA. getImageData always returns straight alpha.
  const readTexel = async (blob: Blob, tSec: number, x: number, y: number): Promise<[number, number, number, number]> => {
    const track = await openTrack(blob)
    const sink = new MB.VideoSampleSink(track)
    const s = await sink.getSample(tSec)
    if (!s) throw new Error(`no sample at t=${tSec}s`)
    const cv = new OffscreenCanvas(s.displayWidth, s.displayHeight)
    const ctx = cv.getContext('2d', { alpha: true })
    if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable')
    s.draw(ctx, 0, 0)
    s.close()
    const d = ctx.getImageData(x, y, 1, 1).data
    return [d[0], d[1], d[2], d[3]]
  }
  // Decode a PNG blob → {w,h, alphaMin, alphaMax} over the whole frame.
  const decodePng = async (bytes: Uint8Array): Promise<{ w: number; h: number; alphaMin: number; alphaMax: number }> => {
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const cv = new OffscreenCanvas(bmp.width, bmp.height)
    const ctx = cv.getContext('2d', { alpha: true })
    if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable')
    ctx.drawImage(bmp, 0, 0)
    const w = bmp.width
    const h = bmp.height
    bmp.close()
    const data = ctx.getImageData(0, 0, w, h).data
    let alphaMin = 255
    let alphaMax = 0
    for (let i = 3; i < data.length; i += 4) {
      const a = data[i]
      if (a < alphaMin) alphaMin = a
      if (a > alphaMax) alphaMax = a
    }
    return { w, h, alphaMin, alphaMax }
  }
  const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }

  // ---- graph builders ----
  const buildAnimated = (): void => {
    S.clearGraph()
    const t = S.createNode('time')
    const hsv = S.createNode('hsv_to_rgb')
    const out = S.createNode('fragment_output')
    S.connect(t, hsv, 'time', 'h') // hue = i/fps → colour cycles frame to frame
    S.connect(hsv, out, 'rgb', 'color')
  }
  const buildAlpha = (): void => {
    S.clearGraph()
    const col = S.createNode('color_constant') // opaque magenta RGB everywhere
    // Horizontal gradient VALUE ramps 0→1 across a central band; clamps to 0 far
    // left and 1 far right, so edge texels are fully transparent/opaque.
    const grad = S.createNode('gradient', { x: 0, y: 0 }, { p0u: 0.44, p1u: 0.56 })
    const out = S.createNode('fragment_output')
    S.connect(col, out, 'color', 'color')
    S.connect(grad, out, 'value', 'alpha') // gradient value → fragment_output alpha input
  }
  const buildNoise = (): void => {
    S.clearGraph()
    const t = S.createNode('time')
    const nz = S.createNode('noise')
    const out = S.createNode('fragment_output')
    S.connect(t, nz, 'time', 'phase') // animate; high-frequency spatial content
    S.connect(nz, out, 'value', 'color')
  }

  // Feature detection up front — gate assertions on real host support.
  const webmSupported = await webm.makeWebmAlphaSink().isSupported()
  const pngSupported = await png.makePngSequenceSink().isSupported()

  // =====================================================================
  // #1 frame count + dims  &  #2 frames vary over time (shared webm export)
  //   Mechanism: engine loops `total = round(dur*fps)` frames driving
  //   u_time = i/fps. #1 fails if the loop count or target size is wrong;
  //   #2 fails if the time drive is constant (a static export → identical
  //   centre pixels at t=0 and t=0.5).
  // =====================================================================
  if (webmSupported) {
    try {
      buildAnimated()
      const blob = await runExport({
        sink: webm.makeWebmAlphaSink(),
        width: cfg.W,
        height: cfg.H,
        fps: cfg.fps,
        durationSec: cfg.dur12,
        alpha: true,
        matte: '#000000',
        quality: 'good',
        framing,
      })
      const { n, dims } = await countFrames(blob)
      const dimsOk = dims.length > 0 && dims.every(([w, h]) => w === cfg.W && h === cfg.H)
      if (n === 12 && dimsOk) pass('frame-count+dims', `decoded ${n} frames, each ${dims[0][0]}x${dims[0][1]}`)
      else fail('frame-count+dims', `expected 12x ${cfg.W}x${cfg.H}, got ${n} frames, first dim ${JSON.stringify(dims[0])}`)

      const p0 = await readTexel(blob, 0, cfg.W / 2, cfg.H / 2)
      const p6 = await readTexel(blob, 0.5, cfg.W / 2, cfg.H / 2)
      const diff = Math.abs(p0[0] - p6[0]) + Math.abs(p0[1] - p6[1]) + Math.abs(p0[2] - p6[2])
      if (diff > 30) pass('frames-vary', `centre pixel Δ=${diff} between t=0 and t=0.5 (rgb ${p0.slice(0, 3)} vs ${p6.slice(0, 3)})`)
      else fail('frames-vary', `centre pixel barely changed (Δ=${diff}) — time drive did not advance`)
    } catch (e) {
      fail('frame-count+dims', `threw: ${String(e)}`)
      fail('frames-vary', `threw: ${String(e)}`)
    }
  } else {
    skip('frame-count+dims', 'webm-alpha sink unsupported on host')
    skip('frames-vary', 'webm-alpha sink unsupported on host')
  }

  // =====================================================================
  // #3 alpha present (webm-alpha)
  //   Mechanism: a graph with an x-varying alpha. Fails if alpha was
  //   dropped (canBeTransparent false), inverted, or premultiplied so the
  //   transparent/opaque edges don't land where expected.
  // =====================================================================
  if (webmSupported) {
    try {
      buildAlpha()
      const blob = await runExport({
        sink: webm.makeWebmAlphaSink(),
        width: cfg.W,
        height: cfg.H,
        fps: cfg.fps,
        durationSec: cfg.dur12,
        alpha: true,
        matte: '#000000',
        quality: 'good',
        framing,
      })
      const track = await openTrack(blob)
      const transparent = await track.canBeTransparent()
      const left = await readTexel(blob, 0, 4, cfg.H / 2) // left band → transparent
      const right = await readTexel(blob, 0, cfg.W - 5, cfg.H / 2) // right band → opaque
      if (transparent && left[3] < 40 && right[3] > 200) {
        pass('alpha-present', `canBeTransparent=true, left α=${left[3]}, right α=${right[3]}`)
      } else {
        fail('alpha-present', `canBeTransparent=${transparent}, left α=${left[3]} (want <40), right α=${right[3]} (want >200)`)
      }
    } catch (e) {
      fail('alpha-present', `threw: ${String(e)}`)
    }
  } else {
    skip('alpha-present', 'webm-alpha sink unsupported on host')
  }

  // =====================================================================
  // #4 PNG sequence  &  #5 determinism (two identical png exports)
  //   #4 mechanism: 12 straight-alpha PNGs at the right size with a
  //   non-constant alpha channel. #5 mechanism: identical graph+settings
  //   render byte-identical PNGs (no wall-clock / RNG leaks into the frame).
  // =====================================================================
  if (pngSupported) {
    try {
      buildAlpha()
      const pngJob = (): ExportJob => ({
        sink: png.makePngSequenceSink(),
        width: cfg.W,
        height: cfg.H,
        fps: cfg.fps,
        durationSec: cfg.dur12,
        alpha: true,
        matte: '#000000',
        quality: 'good',
        framing,
      })
      const zip1 = new Uint8Array(await (await runExport(pngJob())).arrayBuffer())
      const zip2 = new Uint8Array(await (await runExport(pngJob())).arrayBuffer())
      const files1 = FF.unzipSync(zip1)
      const files2 = FF.unzipSync(zip2)
      const names1 = Object.keys(files1).filter((k) => k.endsWith('.png')).sort()

      // #4: count, dims, non-constant alpha per frame
      let dimsOk = names1.length === 12
      let alphaVaries = names1.length > 0
      let firstBad = ''
      for (const name of names1) {
        const info = await decodePng(files1[name])
        if (info.w !== cfg.W || info.h !== cfg.H) {
          dimsOk = false
          if (!firstBad) firstBad = `${name} is ${info.w}x${info.h}`
        }
        if (info.alphaMax - info.alphaMin <= 50) {
          alphaVaries = false
          if (!firstBad) firstBad = `${name} alpha ~constant (${info.alphaMin}..${info.alphaMax})`
        }
      }
      if (names1.length === 12 && dimsOk && alphaVaries) {
        pass('png-sequence', `12 PNGs, each ${cfg.W}x${cfg.H}, alpha channel varies`)
      } else {
        fail('png-sequence', `${names1.length} PNGs; ${firstBad || 'dims/alpha check failed'}`)
      }

      // #5: byte-identical PNG payloads across the two runs
      const names2 = Object.keys(files2).filter((k) => k.endsWith('.png')).sort()
      let identical = names1.length === names2.length && names1.length === 12
      let mismatch = ''
      if (identical) {
        for (const name of names1) {
          if (!files2[name] || !bytesEqual(files1[name], files2[name])) {
            identical = false
            mismatch = name
            break
          }
        }
      }
      if (identical) pass('determinism', `all 12 PNG payloads byte-identical across two exports`)
      else fail('determinism', `PNG payloads differ (${mismatch || 'entry set differs'})`)
    } catch (e) {
      fail('png-sequence', `threw: ${String(e)}`)
      fail('determinism', `threw: ${String(e)}`)
    }
  } else {
    skip('png-sequence', 'png-sequence sink unsupported on host')
    skip('determinism', 'png-sequence sink unsupported on host')
  }

  // =====================================================================
  // #6 quality changes output (webm draft vs max)
  //   Mechanism: the same high-frequency animated content encodes to a
  //   strictly larger file at 'max' than at 'draft'. Fails if the Quality
  //   control is ignored downstream of the modal.
  // =====================================================================
  if (webmSupported) {
    try {
      buildNoise()
      const encodeAt = async (quality: 'draft' | 'max'): Promise<number> => {
        const blob = await runExport({
          sink: webm.makeWebmAlphaSink(),
          width: cfg.W,
          height: cfg.H,
          fps: cfg.fps,
          durationSec: cfg.dur20,
          alpha: true,
          matte: '#000000',
          quality,
          framing,
        })
        return blob.size
      }
      const draft = await encodeAt('draft')
      const max = await encodeAt('max')
      if (max > draft) pass('quality-affects-size', `max=${max}B > draft=${draft}B (${(max / draft).toFixed(2)}x)`)
      else fail('quality-affects-size', `max=${max}B not > draft=${draft}B — quality ignored`)
    } catch (e) {
      fail('quality-affects-size', `threw: ${String(e)}`)
    }
  } else {
    skip('quality-affects-size', 'webm-alpha sink unsupported on host')
  }

  // =====================================================================
  // #7 feature-detect matrix — log what the host supports; a false
  //   isSupported() SKIPS (above), never fails, and is surfaced here.
  // =====================================================================
  try {
    const all = registry.getSinks()
    const avail = await registry.getAvailableSinks({ pro: false })
    const availIds = new Set(avail.map((s) => s.id))
    const skipped = all.filter((s) => !availIds.has(s.id)).map((s) => s.id)
    log(`sinks registered: ${all.map((s) => s.id).join(', ')}`)
    log(`sinks available (isSupported=true): ${[...availIds].join(', ') || '(none)'}`)
    log(skipped.length ? `sinks SKIPPED on this host: ${skipped.join(', ')}` : 'all registered sinks supported on this host')
    pass('feature-detect', `${availIds.size}/${all.length} sinks available`)
  } catch (e) {
    fail('feature-detect', `threw: ${String(e)}`)
  }

  return { checks, logs }
}

// ---------------------------------------------------------------------------
// Node-side orchestration
// ---------------------------------------------------------------------------
function spawnVite(): ChildProcess {
  const bin = new URL('../node_modules/.bin/vite', import.meta.url).pathname
  const child = spawn(bin, ['--port', String(PORT), '--strictPort'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const tail: string[] = []
  const keep = (buf: Buffer): void => {
    tail.push(buf.toString())
    if (tail.length > 40) tail.splice(0, tail.length - 40)
  }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  ;(child as ChildProcess & { _tail: string[] })._tail = tail
  return child
}

async function waitForServer(timeoutMs = 90_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(APP_URL)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`vite dev server did not respond at ${APP_URL} within ${timeoutMs}ms`)
}

async function evalWithRetry<T>(page: Page, fn: (cfg: Cfg) => Promise<T>, cfg: Cfg, attempts = 8): Promise<T> {
  for (let a = 1; a <= attempts; a++) {
    try {
      return await page.evaluate(fn, cfg)
    } catch (e) {
      const msg = String(e)
      const transient = msg.includes('Execution context was destroyed') || msg.includes('navigation')
      if (!transient || a === attempts) throw e
      console.error(`  (attempt ${a}: vite dep-optimize reload destroyed context — waiting + retrying)`)
      await page.waitForFunction(() => !!(window as unknown as { __sombra?: unknown }).__sombra, null, { timeout: 60_000 }).catch(() => {})
    }
  }
  throw new Error('unreachable')
}

async function main(): Promise<number> {
  console.log('verify:video-export — headless export round-trip gate\n')
  console.log(`  spawning vite on :${PORT} …`)
  const vite = spawnVite()
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined

  try {
    try {
      await waitForServer()
    } catch (e) {
      const tail = (vite as ChildProcess & { _tail?: string[] })._tail
      if (tail?.length) console.error('  vite output:\n' + tail.join(''))
      throw e
    }
    console.log('  vite is up; launching headless Chrome (WebGPU) …\n')

    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=metal'],
    })
    const page = await browser.newPage()
    page.on('pageerror', (err) => console.error('[pageerror]', err.message))
    page.on('console', (m) => {
      if (m.type() === 'error') console.error('[page.error]', m.text())
    })

    // tsx transpiles this file with esbuild, which injects a `__name` helper
    // (keepNames) into named functions/arrows. When Playwright serializes
    // `runAssertions` and evaluates it in the page, those `__name(...)` calls
    // reference a free variable that only exists in Node's module scope. Define
    // it (and `__defProp`) on the page global so the serialized body resolves.
    // addInitScript runs before every navigation, so it survives vite's
    // dep-optimize reload too.
    await page.addInitScript(() => {
      const g = globalThis as unknown as Record<string, unknown>
      if (!g.__defProp) g.__defProp = Object.defineProperty
      if (!g.__name) {
        g.__name = (target: unknown, value: string) => {
          try {
            Object.defineProperty(target as object, 'name', { value, configurable: true })
          } catch {
            /* frozen target — name is cosmetic, ignore */
          }
          return target
        }
      }
    })

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForFunction(() => !!(window as unknown as { __sombra?: unknown }).__sombra, null, { timeout: 60_000 })

    // Prewarm: force vite's one-time dep-optimize reload to happen HERE, before
    // the expensive assertion pass, so the latter runs in a stable context.
    await evalWithRetry(
      page,
      async (cfg: Cfg) => {
        await import(cfg.engineUrl)
        await import(cfg.webmUrl)
        await import(cfg.pngUrl)
        await import(cfg.sinksIndexUrl)
        await import(cfg.registryUrl)
        await import(cfg.mediabunnyUrl)
        await import(cfg.fflateUrl)
        return true
      },
      CFG,
    )

    const result = await evalWithRetry(page, runAssertions, CFG)

    for (const line of result.logs) console.log('  · ' + line)
    console.log('')

    let failed = 0
    let skipped = 0
    let passed = 0
    for (const c of result.checks) {
      const tag = c.status === 'pass' ? 'PASS' : c.status === 'fail' ? 'FAIL' : 'SKIP'
      console.log(`  [${tag}] ${c.name} — ${c.detail}`)
      if (c.status === 'fail') failed++
      else if (c.status === 'skip') skipped++
      else passed++
    }
    console.log(`\n  ${passed} passed, ${failed} failed, ${skipped} skipped`)
    console.log(failed === 0 ? '\nVIDEO-EXPORT: PASS' : '\nVIDEO-EXPORT: FAIL')
    return failed === 0 ? 0 : 1
  } finally {
    await browser?.close().catch(() => {})
    vite.kill('SIGTERM')
    // Ensure it is really gone even if SIGTERM is slow.
    setTimeout(() => vite.kill('SIGKILL'), 3_000).unref()
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('runner error:', err)
    process.exit(1)
  })
