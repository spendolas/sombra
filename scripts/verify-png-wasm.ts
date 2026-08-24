/**
 * verify:png-wasm — gate for the WASM PNG encoder (`@jsquash/oxipng`, single-
 * threaded codec, level 0) that now backs the PNG-sequence export, with the
 * pure-JS fflate encoder as fallback.
 *
 * WHAT THIS PROVES (all in real headless Chrome — the oxipng codec loads its
 * .wasm, and the sink drives OffscreenCanvas/VideoFrame, so a blank page can't
 * host it):
 *
 *   #1 wasm-roundtrip (ffmpeg): encodePngWasm() on a fixture that mixes gradient,
 *      opaque, SEMI-TRANSPARENT and fully-transparent-but-coloured pixels →
 *      decode with ffmpeg (/usr/local/bin) → decoded RGBA EQUALS the input
 *      EXACTLY, alpha included. Straight alpha (colour type 6) round-trips
 *      (`optimize_alpha: false` — oxipng never "cleans up" transparent pixels).
 *   #2 wasm-determinism: encodePngWasm() called twice on the same pixels returns
 *      BYTE-IDENTICAL output (the whole reason to prefer it over the browser's
 *      engine-dependent canvas PNG).
 *   #3 wasm-valid-png: the output has the PNG signature, an IHDR declaring 8-bit
 *      colour type 6, and a terminating IEND.
 *   #4 sink-uses-wasm (MECHANISM): drive the REAL png-sequence sink with WASM
 *      available; unzip its frame; assert those bytes EQUAL encodePngWasm(pixels)
 *      and DIFFER from encodePng(pixels) (the fflate fallback). Same pixels,
 *      different encoders → different bytes, so byte-equality to the oxipng
 *      output is proof the sink took the WASM path and NOT the fallback.
 *   #5 fallback-fflate (MECHANISM): in a SECOND page whose WASM fetch is blocked
 *      (simulating CSP/unavailable), drive the same sink; assert initPngWasm()
 *      resolved FALSE, the export still produced a valid non-empty PNG, and its
 *      bytes EQUAL encodePng(pixels) — i.e. it degraded to fflate, never failed.
 *   #6 PROVE IT CAN FAIL: corrupt one IDAT byte of the WASM PNG and confirm the
 *      ffmpeg round-trip no longer matches the source. A gate that can't fail
 *      proves nothing.
 *
 * The two pages are separate JS realms → separate module graphs, so blocking the
 * wasm in the fallback page can't poison oxipng's (promise-memoised) init in the
 * WASM page.
 *
 * Fails LOUD (never silently skips): missing ffmpeg, an unsupported sink, or a
 * fallback page where WASM did NOT get blocked all count as failures.
 *
 * Self-contained: spawns vite on a fixed port, kills it in `finally`. Exit code
 * is non-zero if ANY assertion fails.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright-core'

const PORT = 5217
const APP_URL = `http://localhost:${PORT}/sombra/`

// ---------------------------------------------------------------------------
// Fixtures (generated in Node so ffmpeg-side comparison uses the exact source).
// ---------------------------------------------------------------------------
const W = 40
const H = 30

/** Mixed fixture: gradient + opaque + semi-alpha + transparent-coloured pixels. */
function makeAlphaFixture(width: number, height: number): number[] {
  const rgba: number[] = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      if (idx % 7 === 0) rgba.push(0, 0, 0, 255)
      else if (idx % 7 === 1) rgba.push(255, 255, 255, 255)
      else if (idx % 7 === 2) rgba.push(200, 50, 120, 128)
      else if (idx % 7 === 3) rgba.push(17, 200, 33, 0) // transparent but coloured
      else
        rgba.push(
          Math.round((x * 255) / Math.max(1, width - 1)),
          Math.round((y * 255) / Math.max(1, height - 1)),
          (x + y) & 0xff,
          40 + (idx % 200),
        )
    }
  }
  return rgba
}

/** Fully-OPAQUE fixture (alpha 255) — canvas getImageData round-trips it exactly,
 *  so the sink reads back the same pixels we compare its encode against. */
function makeOpaqueFixture(width: number, height: number): number[] {
  const rgba: number[] = []
  let s = 0x12345678
  for (let i = 0; i < width * height; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    const r = s >>> 0
    rgba.push(r & 0xff, (r >>> 8) & 0xff, (r >>> 16) & 0xff, 255)
  }
  return rgba
}

const ALPHA_SRC = makeAlphaFixture(W, H)
const OPAQUE_SRC = makeOpaqueFixture(W, H)

interface Cfg {
  W: number
  H: number
  pngWasmUrl: string
  pngEncodeUrl: string
  sinkUrl: string
  fflateUrl: string
  alphaSrc: number[]
  opaqueSrc: number[]
}

const CFG: Cfg = {
  W,
  H,
  pngWasmUrl: '/sombra/src/export/png-encode-wasm.ts',
  pngEncodeUrl: '/sombra/src/export/png-encode.ts',
  sinkUrl: '/sombra/src/export/sinks/png-sequence.ts',
  fflateUrl: '/sombra/node_modules/fflate/esm/browser.js',
  alphaSrc: ALPHA_SRC,
  opaqueSrc: OPAQUE_SRC,
}

// ---------------------------------------------------------------------------
// In-page result shapes.
// ---------------------------------------------------------------------------
interface WasmPageResult {
  supported: boolean
  wasmPngA: number[] // encodePngWasm(alphaSrc), first call
  wasmPngB: number[] // encodePngWasm(alphaSrc), second call (determinism)
  determinismEqual: boolean
  sinkFramePng: number[] // frame extracted from the sink's zip (opaque src)
  sinkFrameEqualsWasm: boolean // sink frame == encodePngWasm(opaqueSrc)
  sinkFrameEqualsFflate: boolean // sink frame == encodePng(opaqueSrc) — should be false
  zipEntryCount: number
  logs: string[]
}

interface FallbackPageResult {
  supported: boolean
  wasmBlocked: boolean // initPngWasm() resolved false
  sinkFramePng: number[]
  sinkFrameEqualsFflate: boolean // == encodePng(opaqueSrc) — proves fflate path
  zipEntryCount: number
  logs: string[]
}

// ---------------------------------------------------------------------------
// In-page body: WASM AVAILABLE page.
// ---------------------------------------------------------------------------
async function runWasmPage(cfg: Cfg): Promise<WasmPageResult> {
  interface PngWasmModule {
    initPngWasm(): Promise<boolean>
    encodePngWasm(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): Promise<Uint8Array>
  }
  interface PngEncodeModule {
    encodePng(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, o?: { level?: number }): Uint8Array
  }
  interface SinkOptsLike {
    width: number
    height: number
    fps: number
    alpha: boolean
    matte?: string
    quality: 'draft' | 'good' | 'high' | 'max'
  }
  interface FrameSinkLike {
    isSupported(): Promise<boolean>
    begin(o: SinkOptsLike, writable: WritableStream<Uint8Array>): Promise<void>
    addFrame(frame: VideoFrame, timestampUs: number): Promise<void>
    finish(): Promise<void>
  }
  interface SinkModule {
    makePngSequenceSink(): FrameSinkLike
  }
  interface FflateModule {
    unzipSync(u8: Uint8Array): Record<string, Uint8Array>
  }

  const logs: string[] = []
  const bytesEqual = (a: Uint8Array, b: Uint8Array | number[]): boolean => {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }

  const wasmMod = (await import(cfg.pngWasmUrl)) as PngWasmModule
  const encMod = (await import(cfg.pngEncodeUrl)) as PngEncodeModule
  const sinkMod = (await import(cfg.sinkUrl)) as SinkModule
  const FF = (await import(cfg.fflateUrl)) as FflateModule

  const ok = await wasmMod.initPngWasm()
  logs.push(`initPngWasm() => ${ok}`)
  if (!ok) {
    // WASM should be available on this page; if not, the whole gate is vacuous.
    return {
      supported: false,
      wasmPngA: [],
      wasmPngB: [],
      determinismEqual: false,
      sinkFramePng: [],
      sinkFrameEqualsWasm: false,
      sinkFrameEqualsFflate: false,
      zipEntryCount: 0,
      logs,
    }
  }

  // --- #1/#2 direct encode of the ALPHA fixture (no canvas) -------------------
  const alpha = new Uint8ClampedArray(cfg.alphaSrc)
  const a = await wasmMod.encodePngWasm(alpha, cfg.W, cfg.H)
  const b = await wasmMod.encodePngWasm(alpha, cfg.W, cfg.H)
  const determinismEqual = bytesEqual(a, Array.from(b))

  // --- #4 drive the REAL sink with the OPAQUE fixture ------------------------
  const sink = sinkMod.makePngSequenceSink()
  const supported = await sink.isSupported()
  let sinkFramePng: number[] = []
  let sinkFrameEqualsWasm = false
  let sinkFrameEqualsFflate = false
  let zipEntryCount = 0
  if (supported) {
    // Paint the opaque fixture onto a canvas → VideoFrame (what the engine feeds).
    const cv = new OffscreenCanvas(cfg.W, cfg.H)
    const ctx = cv.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    const imgData = new ImageData(new Uint8ClampedArray(cfg.opaqueSrc), cfg.W, cfg.H)
    ctx.putImageData(imgData, 0, 0)
    const vf = new VideoFrame(cv, { timestamp: 0 })

    // Collect the streamed zip bytes.
    const parts: Uint8Array[] = []
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        parts.push(chunk)
      },
    })
    await sink.begin({ width: cfg.W, height: cfg.H, fps: 30, alpha: true, matte: '#000000', quality: 'good' }, writable)
    await sink.addFrame(vf, 0)
    vf.close()
    await sink.finish()

    const total = parts.reduce((n, p) => n + p.length, 0)
    const zip = new Uint8Array(total)
    let off = 0
    for (const p of parts) {
      zip.set(p, off)
      off += p.length
    }
    const files = FF.unzipSync(zip)
    const names = Object.keys(files).filter((k) => k.endsWith('.png'))
    zipEntryCount = names.length
    const frame = files[names[0]]
    sinkFramePng = Array.from(frame)

    // The pixels the sink actually read back (opaque → getImageData is exact).
    const opaque = new Uint8ClampedArray(cfg.opaqueSrc)
    const wasmFrame = await wasmMod.encodePngWasm(opaque, cfg.W, cfg.H)
    const fflateFrame = encMod.encodePng(opaque, cfg.W, cfg.H, { level: 6 })
    sinkFrameEqualsWasm = bytesEqual(frame, Array.from(wasmFrame))
    sinkFrameEqualsFflate = bytesEqual(frame, Array.from(fflateFrame))
    logs.push(
      `sink frame ${frame.length}B; ==wasm:${sinkFrameEqualsWasm} ==fflate:${sinkFrameEqualsFflate}; ` +
        `wasm ${wasmFrame.length}B fflate ${fflateFrame.length}B`,
    )
  }

  return {
    supported,
    wasmPngA: Array.from(a),
    wasmPngB: Array.from(b),
    determinismEqual,
    sinkFramePng,
    sinkFrameEqualsWasm,
    sinkFrameEqualsFflate,
    zipEntryCount,
    logs,
  }
}

// ---------------------------------------------------------------------------
// In-page body: WASM BLOCKED page (fallback). window.fetch is overridden before
// this runs so the @jsquash wasm fetch rejects — simulating CSP/unavailable.
// ---------------------------------------------------------------------------
async function runFallbackPage(cfg: Cfg): Promise<FallbackPageResult> {
  interface PngWasmModule {
    initPngWasm(): Promise<boolean>
  }
  interface PngEncodeModule {
    encodePng(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, o?: { level?: number }): Uint8Array
  }
  interface SinkOptsLike {
    width: number
    height: number
    fps: number
    alpha: boolean
    matte?: string
    quality: 'draft' | 'good' | 'high' | 'max'
  }
  interface FrameSinkLike {
    isSupported(): Promise<boolean>
    begin(o: SinkOptsLike, writable: WritableStream<Uint8Array>): Promise<void>
    addFrame(frame: VideoFrame, timestampUs: number): Promise<void>
    finish(): Promise<void>
  }
  interface SinkModule {
    makePngSequenceSink(): FrameSinkLike
  }
  interface FflateModule {
    unzipSync(u8: Uint8Array): Record<string, Uint8Array>
  }

  const logs: string[] = []
  const bytesEqual = (a: Uint8Array, b: Uint8Array | number[]): boolean => {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }

  const wasmMod = (await import(cfg.pngWasmUrl)) as PngWasmModule
  const encMod = (await import(cfg.pngEncodeUrl)) as PngEncodeModule
  const sinkMod = (await import(cfg.sinkUrl)) as SinkModule
  const FF = (await import(cfg.fflateUrl)) as FflateModule

  // initPngWasm should catch the blocked fetch and resolve false.
  const wasmOk = await wasmMod.initPngWasm()
  const wasmBlocked = wasmOk === false
  logs.push(`initPngWasm() (fetch blocked) => ${wasmOk}`)

  const sink = sinkMod.makePngSequenceSink()
  const supported = await sink.isSupported()
  let sinkFramePng: number[] = []
  let sinkFrameEqualsFflate = false
  let zipEntryCount = 0
  if (supported) {
    const cv = new OffscreenCanvas(cfg.W, cfg.H)
    const ctx = cv.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    const imgData = new ImageData(new Uint8ClampedArray(cfg.opaqueSrc), cfg.W, cfg.H)
    ctx.putImageData(imgData, 0, 0)
    const vf = new VideoFrame(cv, { timestamp: 0 })

    const parts: Uint8Array[] = []
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        parts.push(chunk)
      },
    })
    await sink.begin({ width: cfg.W, height: cfg.H, fps: 30, alpha: true, matte: '#000000', quality: 'good' }, writable)
    await sink.addFrame(vf, 0)
    vf.close()
    await sink.finish()

    const total = parts.reduce((n, p) => n + p.length, 0)
    const zip = new Uint8Array(total)
    let off = 0
    for (const p of parts) {
      zip.set(p, off)
      off += p.length
    }
    const files = FF.unzipSync(zip)
    const names = Object.keys(files).filter((k) => k.endsWith('.png'))
    zipEntryCount = names.length
    const frame = files[names[0]]
    sinkFramePng = Array.from(frame)

    const opaque = new Uint8ClampedArray(cfg.opaqueSrc)
    const fflateFrame = encMod.encodePng(opaque, cfg.W, cfg.H, { level: 6 })
    sinkFrameEqualsFflate = bytesEqual(frame, Array.from(fflateFrame))
    logs.push(`fallback sink frame ${frame.length}B; ==fflate:${sinkFrameEqualsFflate}`)
  }

  return { supported, wasmBlocked, sinkFramePng, sinkFrameEqualsFflate, zipEntryCount, logs }
}

// ---------------------------------------------------------------------------
// Node-side helpers.
// ---------------------------------------------------------------------------
let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    passed++
    console.log(`  [PASS] ${name} — ${detail}`)
  } else {
    failed++
    console.log(`  [FAIL] ${name} — ${detail}`)
  }
}

function ffmpegPath(): string | null {
  for (const c of ['/usr/local/bin/ffmpeg', 'ffmpeg']) {
    try {
      execFileSync(c, ['-version'], { stdio: 'ignore' })
      return c
    } catch {
      /* next */
    }
  }
  return null
}

function ffmpegDecode(ffmpeg: string, png: Uint8Array, dir: string, tag: string): Uint8Array | null {
  const inPath = join(dir, `${tag}.png`)
  const outPath = join(dir, `${tag}.raw`)
  writeFileSync(inPath, png)
  try {
    execFileSync(ffmpeg, ['-y', '-i', inPath, '-f', 'rawvideo', '-pix_fmt', 'rgba', outPath], { stdio: 'ignore' })
  } catch {
    return null
  }
  return new Uint8Array(readFileSync(outPath))
}

function arraysEqual(a: Uint8Array, b: number[] | Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function isValidPng(png: Uint8Array): { ok: boolean; detail: string } {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < sig.length; i++) if (png[i] !== sig[i]) return { ok: false, detail: 'bad signature' }
  // IHDR starts at byte 16 (8 sig + 4 len + 4 type). Depth @ +8, colourType @ +9.
  const depth = png[16 + 8]
  const colourType = png[16 + 9]
  const iendPresent = png.length >= 12 && (() => {
    const t = png.subarray(png.length - 8, png.length - 4)
    return String.fromCharCode(t[0], t[1], t[2], t[3]) === 'IEND'
  })()
  if (depth !== 8 || colourType !== 6) return { ok: false, detail: `IHDR depth=${depth} colourType=${colourType}` }
  if (!iendPresent) return { ok: false, detail: 'no trailing IEND' }
  return { ok: true, detail: `sig+IHDR(8/6)+IEND ok, ${png.length}B` }
}

// ---------------------------------------------------------------------------
// Orchestration.
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
      /* not up */
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
      await page.waitForFunction(() => document.readyState === 'complete', null, { timeout: 60_000 }).catch(() => {})
    }
  }
  throw new Error('unreachable')
}

// esbuild (tsx) injects __name/__defProp helper refs into serialized functions;
// define them on the page so the serialized body resolves (see verify-export-*).
const HELPER_INIT = (): void => {
  const g = globalThis as unknown as Record<string, unknown>
  if (!g.__defProp) g.__defProp = Object.defineProperty
  if (!g.__name) {
    g.__name = (target: unknown, value: string) => {
      try {
        Object.defineProperty(target as object, 'name', { value, configurable: true })
      } catch {
        /* frozen */
      }
      return target
    }
  }
}

async function main(): Promise<number> {
  console.log('verify:png-wasm — @jsquash/oxipng (ST, L0) WASM PNG encoder gate (round-trip + determinism + fallback)\n')

  const ffmpeg = ffmpegPath()
  if (!ffmpeg) {
    console.error('  [FATAL] ffmpeg not found at /usr/local/bin/ffmpeg or on PATH — required for the round-trip check.')
    return 1
  }

  const dir = mkdtempSync(join(tmpdir(), 'png-wasm-'))
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
    console.log('  vite is up; launching headless Chrome …\n')

    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=metal'],
    })

    // ================= PAGE 1: WASM AVAILABLE =================
    const pageOk = await browser.newPage()
    pageOk.on('pageerror', (err) => console.error('[pageerror:ok]', err.message))
    pageOk.on('console', (m) => {
      if (m.type() === 'error') console.error('[page.error:ok]', m.text())
    })
    await pageOk.addInitScript(HELPER_INIT)
    await pageOk.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    // Prewarm to absorb vite's one-time dep-optimize reload.
    await evalWithRetry(
      pageOk,
      async (cfg: Cfg) => {
        await import(cfg.pngWasmUrl)
        await import(cfg.pngEncodeUrl)
        await import(cfg.sinkUrl)
        await import(cfg.fflateUrl)
        return true
      },
      CFG,
    )
    const okRes = await evalWithRetry(pageOk, runWasmPage, CFG)
    for (const l of okRes.logs) console.log('  · ' + l)

    if (!okRes.supported) {
      check('wasm-available', false, 'initPngWasm() returned false OR sink unsupported on host — cannot verify (anti-vacuity)')
    } else {
      // #3 valid PNG
      const wasmPng = new Uint8Array(okRes.wasmPngA)
      const v = isValidPng(wasmPng)
      check('wasm-valid-png', v.ok, v.detail)

      // #1 round-trip via ffmpeg (exact, incl alpha)
      const raw = ffmpegDecode(ffmpeg, wasmPng, dir, 'wasm')
      check(
        'wasm-roundtrip-ffmpeg',
        raw !== null && arraysEqual(raw, ALPHA_SRC),
        raw === null ? 'ffmpeg decode failed' : `ffmpeg rawvideo rgba (${raw.length}B) == input exactly incl alpha`,
      )

      // #2 determinism
      check(
        'wasm-determinism',
        okRes.determinismEqual && arraysEqual(wasmPng, okRes.wasmPngB),
        `two encodePngWasm() calls byte-identical (${okRes.wasmPngA.length}B each)`,
      )

      // #4 sink uses WASM path (mechanism)
      check(
        'sink-uses-wasm',
        okRes.zipEntryCount === 1 && okRes.sinkFrameEqualsWasm && !okRes.sinkFrameEqualsFflate,
        `sink frame == @jsquash output (${okRes.sinkFrameEqualsWasm}) and != fflate output (${!okRes.sinkFrameEqualsFflate}); zip entries=${okRes.zipEntryCount}`,
      )

      // #6 PROVE IT CAN FAIL — corrupt one IDAT byte, ffmpeg must not match.
      const corrupt = wasmPng.slice()
      // locate first IDAT data offset
      let pos = 8
      let idatOff = -1
      const readU32 = (b: Uint8Array, o: number): number => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
      while (pos < corrupt.length) {
        const len = readU32(corrupt, pos)
        const type = String.fromCharCode(corrupt[pos + 4], corrupt[pos + 5], corrupt[pos + 6], corrupt[pos + 7])
        if (type === 'IDAT') {
          idatOff = pos + 8 + Math.floor(len / 2)
          break
        }
        pos = pos + 8 + len + 4
      }
      let failProof = false
      if (idatOff >= 0) {
        corrupt[idatOff] ^= 0xff
        const badRaw = ffmpegDecode(ffmpeg, corrupt, dir, 'corrupt')
        // ffmpeg may reject the corrupt stream (null) or decode different pixels.
        failProof = badRaw === null || !arraysEqual(badRaw, ALPHA_SRC)
      }
      check(
        'fail-proof-idat-corrupt',
        failProof,
        idatOff < 0 ? 'could not locate IDAT to perturb' : 'flipping one IDAT byte breaks the round-trip — gate CAN fail',
      )
    }

    await pageOk.close()

    // ================= PAGE 2: WASM BLOCKED (fallback) =================
    const pageFb = await browser.newPage()
    pageFb.on('pageerror', (err) => console.error('[pageerror:fb]', err.message))
    pageFb.on('console', (m) => {
      if (m.type() === 'error') console.error('[page.error:fb]', m.text())
    })
    await pageFb.addInitScript(HELPER_INIT)
    // Block the @jsquash wasm fetch BEFORE any module loads — simulates CSP /
    // network-blocked WASM. Only explicit fetch() of the .wasm is affected; ES
    // module imports use the module loader, not fetch(), so vite still works.
    await pageFb.addInitScript(() => {
      const realFetch = globalThis.fetch.bind(globalThis)
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
        if (url.includes('squoosh_oxipng_bg') || url.endsWith('.wasm')) {
          return Promise.reject(new Error('[test] wasm fetch blocked'))
        }
        return realFetch(input as RequestInfo, init)
      }) as typeof fetch
    })
    await pageFb.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await evalWithRetry(
      pageFb,
      async (cfg: Cfg) => {
        await import(cfg.pngWasmUrl)
        await import(cfg.pngEncodeUrl)
        await import(cfg.sinkUrl)
        await import(cfg.fflateUrl)
        return true
      },
      CFG,
    )
    const fbRes = await evalWithRetry(pageFb, runFallbackPage, CFG)
    for (const l of fbRes.logs) console.log('  · ' + l)

    // Mechanism guard: the fallback test is only meaningful if WASM really was
    // blocked. If init unexpectedly succeeded, FAIL loud (not a silent skip).
    check(
      'fallback-wasm-blocked',
      fbRes.wasmBlocked,
      fbRes.wasmBlocked ? 'initPngWasm() resolved false with wasm fetch blocked' : 'WASM was NOT blocked — fallback path not exercised',
    )
    if (!fbRes.supported) {
      check('fallback-fflate', false, 'sink unsupported on fallback host — cannot verify (anti-vacuity)')
    } else {
      const fbPng = new Uint8Array(fbRes.sinkFramePng)
      const v = isValidPng(fbPng)
      const fbRaw = ffmpegDecode(ffmpeg, fbPng, dir, 'fallback')
      check(
        'fallback-fflate',
        fbRes.zipEntryCount === 1 &&
          v.ok &&
          fbRes.sinkFrameEqualsFflate &&
          fbRaw !== null &&
          arraysEqual(fbRaw, OPAQUE_SRC),
        `valid PNG (${v.ok}) via fflate (==fflate:${fbRes.sinkFrameEqualsFflate}), ffmpeg round-trip exact (${fbRaw !== null && arraysEqual(fbRaw, OPAQUE_SRC)}), zip entries=${fbRes.zipEntryCount}`,
      )
    }

    await pageFb.close()

    console.log(`\n  ${passed} passed, ${failed} failed`)
    console.log(failed === 0 ? '\nPNG-WASM: PASS' : '\nPNG-WASM: FAIL')
    return failed === 0 ? 0 : 1
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await browser?.close().catch(() => {})
    await new Promise<void>((resolve) => {
      if (vite.exitCode !== null || vite.signalCode !== null) {
        resolve()
        return
      }
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      vite.once('exit', done)
      vite.kill('SIGTERM')
      setTimeout(() => {
        try {
          vite.kill('SIGKILL')
        } catch {
          /* gone */
        }
        setTimeout(done, 250)
      }, 3_000).unref()
    })
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('runner error:', err)
    process.exit(1)
  })
