/**
 * verify:png-multiworker — mechanism-engaged gate for the PNG encode worker
 * POOL (`createPngEncodePool`, `src/export/png-encode-pool.ts`) that fans
 * PNG-sequence export frames across `poolSize` workers, each running its own
 * oxipng (single-threaded, L0) codec off one shared compiled WASM module.
 *
 * WHAT THIS PROVES (all in real headless Chrome — the pool spawns real
 * `Worker`s that load real oxipng WASM, so a blank page can't host it):
 *
 *   #1 byte-identical pool == serial (determinism + ordering, the core guard):
 *      encode N=24 content-distinct frames both via the serial `encodePngWasm`
 *      reference loop and via the pool; every `deliver[i]` must byte-equal
 *      `serialPng[i]`. Anti-vacuity: the pool must be non-null on this page —
 *      if wasm/workers were unavailable here the whole gate is moot.
 *   #2 strict in-order delivery (mechanism-engaged): `onEncoded` fired in
 *      strict ascending index order despite out-of-order worker completion
 *      (frames alternate high-entropy-noise/flat-gradient so completion times
 *      differ). Cross-index discriminator: `deliver[0]` must NOT byte-equal
 *      `serialPng[1]` — proves the equality checks above actually discriminate
 *      rather than passing because every frame happens to encode identically.
 *   #3 bounded window (mechanism-engaged): a large slow frame 0 blocks the
 *      emit cursor while N-1 small fast frames race ahead and complete;
 *      instrumented `accepted`/`delivered` counters (from OUTSIDE the pool)
 *      show `peak = max(accepted - delivered)` stays `<= poolSize+2` (backpressure
 *      held) AND `>= 2` (frames really overlapped — a peak of 1 would mean
 *      fully serial execution, making the bound vacuous).
 *   #4 speedup: wall-clock the serial reference loop vs a fresh pool run over
 *      the same N base-size frames. Asserted (`poolMs < serialMs * 0.75`) only
 *      when `hardwareConcurrency >= 4`; logged but not asserted on smaller
 *      hosts so the gate stays non-flaky on small CI boxes.
 *   #5 fallback (SECOND page, wasm fetch blocked): `createPngEncodePool`
 *      called directly must resolve null (anti-vacuity: if it doesn't, the
 *      wasm block failed and the fallback path was never exercised — FAIL
 *      loud). The REAL `makePngSequenceSink` driven end-to-end via
 *      `addFrameRaw` must still yield a valid zip: exactly N `.png` entries
 *      named `frame_00000.png`..`frame_000{N-1}.png`, each passing
 *      `isValidPng`, and at least one round-trips via ffmpeg to its source
 *      pixels exactly.
 *   #6 PROVE IT CAN FAIL: flip one IDAT byte of `serialPng[0]` and confirm the
 *      SAME byte-equality comparison used in #1 now reports NOT-equal against
 *      `deliver[0]`. A gate that can't fail proves nothing.
 *   #7 workers-terminated-after-finish (THIRD page, mechanism-engaged regression
 *      for the worker-leak fix): before any module import, the page's global
 *      `Worker` constructor is wrapped to count constructions and `.terminate()`
 *      calls. A REAL successful export is then driven through the actual
 *      `makePngSequenceSink()` — `begin()` → 10 `addFrameRaw` calls → `finish()`.
 *      Asserts `constructed >= 1` (anti-vacuity: a pool actually ran) AND
 *      `terminated === constructed` (every worker the export created was torn
 *      down by `finish()`'s `pool?.dispose()`). Deleting that `dispose()` call
 *      makes this check fail (`terminated < constructed`) while the other 14
 *      checks stay green — this is the check that would have caught the
 *      original worker-leak bug.
 *
 * Frames are generated IN-PAGE (a seeded xorshift32 keyed on frame index) so
 * every frame is content-distinct and reruns are identical, without shipping
 * ~14M pixel bytes across the Node/page boundary. The pool TRANSFERS each
 * submitted buffer, so every submit builds a FRESH `Uint8ClampedArray` copy
 * from an in-page pristine master frame; the serial reference encode gets its
 * own separate fresh copy.
 *
 * Fails LOUD (never silently skips): missing ffmpeg, an unsupported sink, or a
 * fallback page where wasm did NOT get blocked all count as failures.
 *
 * Self-contained: spawns vite on a fixed DISTINCT port (5218, avoiding
 * verify-png-wasm's 5217), kills it in `finally`. Exit code is non-zero if ANY
 * assertion fails.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright-core'

const PORT = 5218
const APP_URL = `http://localhost:${PORT}/sombra/`

// ---------------------------------------------------------------------------
// Config shared with in-page code.
// ---------------------------------------------------------------------------
interface Cfg {
  poolUrl: string
  wasmUrl: string
  sinkUrl: string
  fflateUrl: string
  n: number
  w: number
  h: number
  largeW: number
  largeH: number
  smallW: number
  smallH: number
  poolSize: number
}

const CFG: Cfg = {
  poolUrl: '/sombra/src/export/png-encode-pool.ts',
  wasmUrl: '/sombra/src/export/png-encode-wasm.ts',
  sinkUrl: '/sombra/src/export/sinks/png-sequence.ts',
  fflateUrl: '/sombra/node_modules/fflate/esm/browser.js',
  n: 24,
  w: 480,
  h: 320,
  largeW: 1280,
  largeH: 960,
  smallW: 64,
  smallH: 64,
  poolSize: 4,
}

// ---------------------------------------------------------------------------
// In-page result shapes.
// ---------------------------------------------------------------------------
interface MainResult {
  wasmOk: boolean
  poolSupported: boolean
  allBytesEqual: boolean
  mismatchIndex: number
  order: number[]
  orderCorrect: boolean
  discriminatorOk: boolean
  idatFound: boolean
  corruptionDetected: boolean
  boundedSupported: boolean
  boundedPeak: number
  boundedWindow: number
  boundedWindowOk: boolean
  boundedEngagedOk: boolean
  hardwareConcurrency: number
  speedupSupported: boolean
  serialMs: number
  poolMs: number
  logs: string[]
}

interface FallbackResult {
  poolBlocked: boolean
  supported: boolean
  zipEntryCount: number
  namesOk: boolean
  allValidPngSig: boolean
  firstPng: number[]
  firstPixels: number[]
  logs: string[]
}

interface WorkersResult {
  supported: boolean
  constructed: number
  terminated: number
  logs: string[]
}

// ---------------------------------------------------------------------------
// In-page body: MAIN page (wasm + workers available). Runs checks #1, #2, #3,
// #4, #6 — all share the same pristine per-frame master pixel buffers.
// ---------------------------------------------------------------------------
async function runMain(cfg: Cfg): Promise<MainResult> {
  interface PoolHandle {
    submit(index: number, rgba: Uint8ClampedArray, width: number, height: number): Promise<void>
    drain(): Promise<void>
    dispose(): void
  }
  interface PoolModule {
    createPngEncodePool(opts: {
      poolSize: number
      onEncoded: (index: number, png: Uint8Array) => void | Promise<void>
    }): Promise<PoolHandle | null>
  }
  interface WasmModule {
    initPngWasm(): Promise<boolean>
    encodePngWasm(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Promise<Uint8Array>
  }

  const logs: string[] = []
  const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }

  // Seeded xorshift32 fill — deterministic per (seed, w, h, mode); reruns are
  // byte-identical. 'noise' = high-entropy (slow to encode), 'flat' = smooth
  // gradient (fast to encode) — the difficulty split is what makes worker
  // completions race out of order.
  const fillFrame = (seed: number, w: number, h: number, mode: 'noise' | 'flat'): Uint8ClampedArray => {
    const buf = new Uint8ClampedArray(w * h * 4)
    let s = (seed * 2654435761) >>> 0
    if (s === 0) s = 0x9e3779b9
    const next = (): number => {
      s ^= s << 13
      s >>>= 0
      s ^= s >>> 17
      s ^= s << 5
      s >>>= 0
      return s
    }
    if (mode === 'noise') {
      for (let i = 0; i < w * h; i++) {
        const r = next()
        buf[i * 4] = r & 0xff
        buf[i * 4 + 1] = (r >>> 8) & 0xff
        buf[i * 4 + 2] = (r >>> 16) & 0xff
        buf[i * 4 + 3] = 255
      }
    } else {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4
          buf[i] = Math.round((x * 255) / Math.max(1, w - 1))
          buf[i + 1] = Math.round((y * 255) / Math.max(1, h - 1))
          buf[i + 2] = (seed * 37) & 0xff
          buf[i + 3] = 255
        }
      }
    }
    return buf
  }

  const wasmMod = (await import(cfg.wasmUrl)) as WasmModule
  const poolMod = (await import(cfg.poolUrl)) as PoolModule

  const wasmOk = await wasmMod.initPngWasm()
  logs.push(`initPngWasm() => ${wasmOk}`)
  if (!wasmOk) {
    return {
      wasmOk: false,
      poolSupported: false,
      allBytesEqual: false,
      mismatchIndex: -1,
      order: [],
      orderCorrect: false,
      discriminatorOk: false,
      idatFound: false,
      corruptionDetected: false,
      boundedSupported: false,
      boundedPeak: 0,
      boundedWindow: cfg.poolSize + 2,
      boundedWindowOk: false,
      boundedEngagedOk: false,
      hardwareConcurrency: navigator.hardwareConcurrency ?? 0,
      speedupSupported: false,
      serialMs: 0,
      poolMs: 0,
      logs,
    }
  }

  const N = cfg.n
  const master: Uint8ClampedArray[] = []
  for (let i = 0; i < N; i++) master.push(fillFrame(i, cfg.w, cfg.h, i % 2 === 0 ? 'noise' : 'flat'))
  const freshCopy = (i: number): Uint8ClampedArray => new Uint8ClampedArray(master[i])

  // --- #1/#2/#6: serial reference vs pool -----------------------------------
  const serialPng: Uint8Array[] = []
  for (let i = 0; i < N; i++) serialPng.push(await wasmMod.encodePngWasm(freshCopy(i), cfg.w, cfg.h))

  const deliver: (Uint8Array | undefined)[] = new Array(N)
  const order: number[] = []
  const pool = await poolMod.createPngEncodePool({
    poolSize: cfg.poolSize,
    onEncoded: (index, png) => {
      deliver[index] = png
      order.push(index)
    },
  })
  const poolSupported = pool !== null

  let allBytesEqual = false
  let mismatchIndex = -1
  let orderCorrect = false
  let discriminatorOk = false
  let idatFound = false
  let corruptionDetected = false

  if (poolSupported) {
    for (let i = 0; i < N; i++) await pool.submit(i, freshCopy(i), cfg.w, cfg.h)
    await pool.drain()
    pool.dispose()

    allBytesEqual = true
    for (let i = 0; i < N; i++) {
      const d = deliver[i]
      if (!d || !bytesEqual(d, serialPng[i])) {
        allBytesEqual = false
        mismatchIndex = i
        break
      }
    }

    orderCorrect = order.length === N && order.every((v, idx) => v === idx)

    const d0 = deliver[0]
    discriminatorOk = d0 !== undefined && !bytesEqual(d0, serialPng[1])

    // #6 PROVE IT CAN FAIL: flip one IDAT byte of the serial reference and
    // confirm the SAME comparison used above now reports NOT-equal.
    const src = serialPng[0]
    const corrupt = src.slice()
    const readU32 = (b: Uint8Array, o: number): number =>
      ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
    let pos = 8
    let idatOff = -1
    while (pos < corrupt.length) {
      const len = readU32(corrupt, pos)
      const type = String.fromCharCode(corrupt[pos + 4], corrupt[pos + 5], corrupt[pos + 6], corrupt[pos + 7])
      if (type === 'IDAT') {
        idatOff = pos + 8 + Math.floor(len / 2)
        break
      }
      pos = pos + 8 + len + 4
    }
    if (idatOff >= 0 && d0 !== undefined) {
      idatFound = true
      corrupt[idatOff] ^= 0xff
      corruptionDetected = !bytesEqual(corrupt, d0)
    }
  }

  // --- #3: bounded window ----------------------------------------------------
  const boundedWindow = cfg.poolSize + 2
  let boundedSupported = false
  let boundedPeak = 0
  let boundedWindowOk = false
  let boundedEngagedOk = false
  {
    let accepted = 0
    let delivered = 0
    let peak = 0
    const pool2 = await poolMod.createPngEncodePool({
      poolSize: cfg.poolSize,
      onEncoded: () => {
        delivered++
        peak = Math.max(peak, accepted - delivered)
      },
    })
    boundedSupported = pool2 !== null
    if (pool2) {
      const largeFrame = fillFrame(90001, cfg.largeW, cfg.largeH, 'noise')
      const smallFrames: Uint8ClampedArray[] = []
      for (let i = 1; i < N; i++) smallFrames.push(fillFrame(90000 + i, cfg.smallW, cfg.smallH, 'noise'))

      await pool2.submit(0, new Uint8ClampedArray(largeFrame), cfg.largeW, cfg.largeH)
      accepted++
      peak = Math.max(peak, accepted - delivered)
      for (let i = 1; i < N; i++) {
        await pool2.submit(i, new Uint8ClampedArray(smallFrames[i - 1]), cfg.smallW, cfg.smallH)
        accepted++
        peak = Math.max(peak, accepted - delivered)
      }
      await pool2.drain()
      pool2.dispose()
      boundedPeak = peak
      boundedWindowOk = peak <= boundedWindow
      boundedEngagedOk = peak >= 2
    }
  }

  // --- #4: speedup -------------------------------------------------------
  const hardwareConcurrency = navigator.hardwareConcurrency ?? 0
  let speedupSupported = false
  let serialMs = 0
  let poolMs = 0
  {
    const t0 = performance.now()
    for (let i = 0; i < N; i++) await wasmMod.encodePngWasm(freshCopy(i), cfg.w, cfg.h)
    serialMs = performance.now() - t0

    const pool3 = await poolMod.createPngEncodePool({
      poolSize: cfg.poolSize,
      onEncoded: () => {
        /* speedup timing only, delivery order already verified above */
      },
    })
    speedupSupported = pool3 !== null
    if (pool3) {
      const t1 = performance.now()
      for (let i = 0; i < N; i++) await pool3.submit(i, freshCopy(i), cfg.w, cfg.h)
      await pool3.drain()
      poolMs = performance.now() - t1
      pool3.dispose()
    }
  }

  return {
    wasmOk,
    poolSupported,
    allBytesEqual,
    mismatchIndex,
    order,
    orderCorrect,
    discriminatorOk,
    idatFound,
    corruptionDetected,
    boundedSupported,
    boundedPeak,
    boundedWindow,
    boundedWindowOk,
    boundedEngagedOk,
    hardwareConcurrency,
    speedupSupported,
    serialMs,
    poolMs,
    logs,
  }
}

// ---------------------------------------------------------------------------
// In-page body: FALLBACK page. window.fetch is overridden before this runs so
// the @jsquash wasm fetch rejects — createPngEncodePool must resolve null, and
// the REAL sink must still complete via its serial-inline / fflate path.
// ---------------------------------------------------------------------------
async function runFallback(cfg: Cfg): Promise<FallbackResult> {
  interface PoolHandle {
    submit(index: number, rgba: Uint8ClampedArray, width: number, height: number): Promise<void>
    drain(): Promise<void>
    dispose(): void
  }
  interface PoolModule {
    createPngEncodePool(opts: {
      poolSize: number
      onEncoded: (index: number, png: Uint8Array) => void | Promise<void>
    }): Promise<PoolHandle | null>
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
    addFrameRaw?(rgba: Uint8ClampedArray, width: number, height: number, index: number, timestampUs: number): Promise<void>
    finish(): Promise<void>
  }
  interface SinkModule {
    makePngSequenceSink(): FrameSinkLike
  }
  interface FflateModule {
    unzipSync(u8: Uint8Array): Record<string, Uint8Array>
  }

  const logs: string[] = []

  const fillFrame = (seed: number, w: number, h: number, mode: 'noise' | 'flat'): Uint8ClampedArray => {
    const buf = new Uint8ClampedArray(w * h * 4)
    let s = (seed * 2654435761) >>> 0
    if (s === 0) s = 0x9e3779b9
    const next = (): number => {
      s ^= s << 13
      s >>>= 0
      s ^= s >>> 17
      s ^= s << 5
      s >>>= 0
      return s
    }
    if (mode === 'noise') {
      for (let i = 0; i < w * h; i++) {
        const r = next()
        buf[i * 4] = r & 0xff
        buf[i * 4 + 1] = (r >>> 8) & 0xff
        buf[i * 4 + 2] = (r >>> 16) & 0xff
        buf[i * 4 + 3] = 255
      }
    } else {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4
          buf[i] = Math.round((x * 255) / Math.max(1, w - 1))
          buf[i + 1] = Math.round((y * 255) / Math.max(1, h - 1))
          buf[i + 2] = (seed * 37) & 0xff
          buf[i + 3] = 255
        }
      }
    }
    return buf
  }

  const isValidPngBytes = (png: Uint8Array): boolean => {
    const sig = [137, 80, 78, 71, 13, 10, 26, 10]
    for (let i = 0; i < 8; i++) if (png[i] !== sig[i]) return false
    const depth = png[16 + 8]
    const colourType = png[16 + 9]
    if (depth !== 8 || colourType !== 6) return false
    if (png.length < 12) return false
    const t = png.subarray(png.length - 8, png.length - 4)
    return String.fromCharCode(t[0], t[1], t[2], t[3]) === 'IEND'
  }

  const poolMod = (await import(cfg.poolUrl)) as PoolModule
  const sinkMod = (await import(cfg.sinkUrl)) as SinkModule
  const FF = (await import(cfg.fflateUrl)) as FflateModule

  // Anti-vacuity: the pool must be unavailable on this page — called directly.
  const poolDirect = await poolMod.createPngEncodePool({
    poolSize: cfg.poolSize,
    onEncoded: () => {
      /* never reached — pool must resolve null with wasm blocked */
    },
  })
  const poolBlocked = poolDirect === null
  logs.push(`createPngEncodePool() with wasm blocked => ${poolDirect === null ? 'null' : 'NON-NULL (unexpected)'}`)

  const N = cfg.n
  const master: Uint8ClampedArray[] = []
  for (let i = 0; i < N; i++) master.push(fillFrame(i, cfg.w, cfg.h, i % 2 === 0 ? 'noise' : 'flat'))

  const sink = sinkMod.makePngSequenceSink()
  const supported = await sink.isSupported()
  let zipEntryCount = 0
  let namesOk = false
  let allValidPngSig = false
  let firstPng: number[] = []
  let firstPixels: number[] = []

  if (supported) {
    const parts: Uint8Array[] = []
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        parts.push(chunk)
      },
    })
    await sink.begin({ width: cfg.w, height: cfg.h, fps: 30, alpha: true, matte: '#000000', quality: 'good' }, writable)
    for (let i = 0; i < N; i++) {
      await sink.addFrameRaw!(new Uint8ClampedArray(master[i]), cfg.w, cfg.h, i, i * 33333)
    }
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

    const expected = new Set<string>()
    for (let i = 0; i < N; i++) expected.add(`frame_${String(i).padStart(5, '0')}.png`)
    const got = new Set(names)
    namesOk = got.size === expected.size && [...expected].every((nm) => got.has(nm))

    allValidPngSig = names.every((nm) => isValidPngBytes(files[nm]))

    const firstName = 'frame_00000.png'
    if (files[firstName]) {
      firstPng = Array.from(files[firstName])
      firstPixels = Array.from(master[0])
    }
    logs.push(`fallback zip: ${zipEntryCount} entries, namesOk=${namesOk}, allValidPngSig=${allValidPngSig}`)
  }

  return { poolBlocked, supported, zipEntryCount, namesOk, allValidPngSig, firstPng, firstPixels, logs }
}

// ---------------------------------------------------------------------------
// In-page body: WORKER-LIFECYCLE page. `globalThis.Worker` is wrapped (before
// any module import) to count constructions and `.terminate()` calls, then a
// REAL successful export is driven through the actual `makePngSequenceSink()`
// so the assertion exercises the production `finish()` → `pool?.dispose()`
// path, not a test-harness-only `dispose()` call.
// ---------------------------------------------------------------------------
async function runWorkersTerminated(cfg: Cfg): Promise<WorkersResult> {
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
    addFrameRaw?(rgba: Uint8ClampedArray, width: number, height: number, index: number, timestampUs: number): Promise<void>
    finish(): Promise<void>
  }
  interface SinkModule {
    makePngSequenceSink(): FrameSinkLike
  }

  const logs: string[] = []
  const stats = (globalThis as unknown as { __workerStats: { constructed: number; terminated: number } }).__workerStats

  const fillFrame = (seed: number, w: number, h: number): Uint8ClampedArray => {
    const buf = new Uint8ClampedArray(w * h * 4)
    let s = (seed * 2654435761) >>> 0
    if (s === 0) s = 0x9e3779b9
    const next = (): number => {
      s ^= s << 13
      s >>>= 0
      s ^= s >>> 17
      s ^= s << 5
      s >>>= 0
      return s
    }
    for (let i = 0; i < w * h; i++) {
      const r = next()
      buf[i * 4] = r & 0xff
      buf[i * 4 + 1] = (r >>> 8) & 0xff
      buf[i * 4 + 2] = (r >>> 16) & 0xff
      buf[i * 4 + 3] = 255
    }
    return buf
  }

  const sinkMod = (await import(cfg.sinkUrl)) as SinkModule
  const sink = sinkMod.makePngSequenceSink()
  const supported = await sink.isSupported()
  logs.push(`png-sequence isSupported() => ${supported}`)

  if (!supported) {
    return { supported: false, constructed: stats.constructed, terminated: stats.terminated, logs }
  }

  // 10 frames — enough to engage the pool (poolSize is hardwareConcurrency-1,
  // capped at 8) across more than one dispatch round per worker.
  const N = 10
  const w = cfg.smallW
  const h = cfg.smallH
  const parts: Uint8Array[] = []
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      parts.push(chunk)
    },
  })

  await sink.begin({ width: w, height: h, fps: 30, alpha: true, matte: '#000000', quality: 'good' }, writable)
  for (let i = 0; i < N; i++) {
    await sink.addFrameRaw!(fillFrame(i, w, h), w, h, i, i * 33333)
  }
  await sink.finish()

  logs.push(`after finish(): constructed=${stats.constructed}, terminated=${stats.terminated}`)

  return { supported: true, constructed: stats.constructed, terminated: stats.terminated, logs }
}

// ---------------------------------------------------------------------------
// Node-side helpers (copied from the verify-png-wasm template).
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
  const depth = png[16 + 8]
  const colourType = png[16 + 9]
  const iendPresent =
    png.length >= 12 &&
    (() => {
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
// define them on the page so the serialized body resolves (see verify-png-wasm).
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
  console.log('verify:png-multiworker — PNG encode pool gate (determinism/order, bounded window, speedup, fallback)\n')

  const ffmpeg = ffmpegPath()
  if (!ffmpeg) {
    console.error('  [FATAL] ffmpeg not found at /usr/local/bin/ffmpeg or on PATH — required for the round-trip check.')
    return 1
  }

  const dir = mkdtempSync(join(tmpdir(), 'png-multiworker-'))
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

    // ================= PAGE 1: MAIN (wasm + workers available) =================
    const pageMain = await browser.newPage()
    pageMain.on('pageerror', (err) => console.error('[pageerror:main]', err.message))
    pageMain.on('console', (m) => {
      if (m.type() === 'error') console.error('[page.error:main]', m.text())
    })
    await pageMain.addInitScript(HELPER_INIT)
    await pageMain.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    // Prewarm to absorb vite's one-time dep-optimize reload.
    await evalWithRetry(
      pageMain,
      async (cfg: Cfg) => {
        await import(cfg.wasmUrl)
        await import(cfg.poolUrl)
        return true
      },
      CFG,
    )

    console.log('  running main-page checks (this spawns several worker pools; may take a bit) …')
    const mainRes = await evalWithRetry(pageMain, runMain, CFG, 3)
    for (const l of mainRes.logs) console.log('  · ' + l)

    if (!mainRes.wasmOk) {
      check('wasm-available', false, 'initPngWasm() returned false on main page — cannot verify (anti-vacuity)')
    } else {
      // #1
      check(
        'pool-available',
        mainRes.poolSupported,
        mainRes.poolSupported ? 'createPngEncodePool() returned a live pool' : 'pool resolved null — anti-vacuity, cannot verify',
      )
      if (mainRes.poolSupported) {
        check(
          'byte-identical-vs-serial',
          mainRes.allBytesEqual,
          mainRes.allBytesEqual
            ? `all ${CFG.n} deliver[i] == serialPng[i] byte-for-byte`
            : `mismatch at index ${mainRes.mismatchIndex}`,
        )

        // #2
        check(
          'strict-in-order-delivery',
          mainRes.orderCorrect,
          mainRes.orderCorrect
            ? `onEncoded fired in strict order 0..${CFG.n - 1}`
            : `order was [${mainRes.order.join(',')}]`,
        )
        check(
          'order-discriminator-mechanism',
          mainRes.discriminatorOk,
          mainRes.discriminatorOk
            ? 'deliver[0] != serialPng[1] — distinct frames really produce distinct bytes'
            : 'deliver[0] == serialPng[1] — frames were not actually distinct, checks above would be vacuous',
        )

        // #6 (uses the same comparison + data as #1/#2, so it lives here)
        check(
          'fail-proof-idat-corrupt',
          mainRes.idatFound && mainRes.corruptionDetected,
          !mainRes.idatFound
            ? 'could not locate IDAT to perturb'
            : 'flipping one IDAT byte of serialPng[0] breaks byte-equality vs deliver[0] — gate CAN fail',
        )
      }

      // #3
      check(
        'bounded-window-available',
        mainRes.boundedSupported,
        mainRes.boundedSupported ? 'second pool created for the bounded-window check' : 'pool resolved null — anti-vacuity',
      )
      if (mainRes.boundedSupported) {
        check(
          'bounded-window',
          mainRes.boundedWindowOk,
          `peak outstanding = ${mainRes.boundedPeak}, window = poolSize+2 = ${mainRes.boundedWindow} → ${mainRes.boundedWindowOk ? 'held' : 'EXCEEDED'}`,
        )
        check(
          'bounded-window-engaged',
          mainRes.boundedEngagedOk,
          `peak = ${mainRes.boundedPeak} >= 2 (frames overlapped; peak=1 would mean fully serial execution)`,
        )
      }

      // #4
      const ratio = mainRes.serialMs > 0 ? mainRes.poolMs / mainRes.serialMs : NaN
      if (!mainRes.speedupSupported) {
        check('speedup', false, 'third pool resolved null — anti-vacuity, cannot verify speedup')
      } else if (mainRes.hardwareConcurrency >= 4) {
        check(
          'speedup',
          mainRes.poolMs < mainRes.serialMs * 0.75,
          `serial=${mainRes.serialMs.toFixed(1)}ms pool=${mainRes.poolMs.toFixed(1)}ms ratio=${ratio.toFixed(3)} (hardwareConcurrency=${mainRes.hardwareConcurrency}, threshold 0.75)`,
        )
      } else {
        check(
          'speedup',
          true,
          `NOT ASSERTED (hardwareConcurrency=${mainRes.hardwareConcurrency} < 4): serial=${mainRes.serialMs.toFixed(1)}ms pool=${mainRes.poolMs.toFixed(1)}ms ratio=${ratio.toFixed(3)}`,
        )
      }
    }

    await pageMain.close()

    // ================= PAGE 2: FALLBACK (wasm fetch blocked) =================
    const pageFb = await browser.newPage()
    pageFb.on('pageerror', (err) => console.error('[pageerror:fb]', err.message))
    pageFb.on('console', (m) => {
      if (m.type() === 'error') console.error('[page.error:fb]', m.text())
    })
    await pageFb.addInitScript(HELPER_INIT)
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
        await import(cfg.poolUrl)
        await import(cfg.sinkUrl)
        await import(cfg.fflateUrl)
        return true
      },
      CFG,
    )
    const fbRes = await evalWithRetry(pageFb, runFallback, CFG)
    for (const l of fbRes.logs) console.log('  · ' + l)

    // Mechanism guard: the fallback test is only meaningful if the pool really
    // was unavailable. If it unexpectedly succeeded, FAIL loud (not a silent skip).
    check(
      'fallback-pool-blocked',
      fbRes.poolBlocked,
      fbRes.poolBlocked
        ? 'createPngEncodePool() resolved null with wasm fetch blocked'
        : 'pool was NON-NULL — wasm was NOT blocked, fallback path not exercised',
    )
    if (!fbRes.supported) {
      check('fallback-sink', false, 'sink unsupported on fallback host — cannot verify (anti-vacuity)')
    } else {
      check('fallback-zip-entry-count', fbRes.zipEntryCount === CFG.n, `zip has ${fbRes.zipEntryCount} .png entries (expected ${CFG.n})`)
      check(
        'fallback-entry-names',
        fbRes.namesOk,
        fbRes.namesOk ? `frame_00000.png..frame_${String(CFG.n - 1).padStart(5, '0')}.png all present` : 'entry names did not match the expected set',
      )
      check('fallback-all-valid-png-sig', fbRes.allValidPngSig, 'every entry passes PNG signature+IHDR(8/6)+IEND check')

      if (fbRes.firstPng.length === 0) {
        check('fallback-ffmpeg-roundtrip', false, 'frame_00000.png missing from zip — cannot verify')
      } else {
        const png = new Uint8Array(fbRes.firstPng)
        const v = isValidPng(png)
        const raw = ffmpegDecode(ffmpeg, png, dir, 'fallback-frame0')
        check(
          'fallback-ffmpeg-roundtrip',
          v.ok && raw !== null && arraysEqual(raw, fbRes.firstPixels),
          raw === null
            ? 'ffmpeg decode failed'
            : `frame_00000.png valid (${v.detail}); ffmpeg rawvideo rgba (${raw.length}B) == source pixels exactly (${arraysEqual(raw, fbRes.firstPixels)})`,
        )
      }
    }

    await pageFb.close()

    // ================= PAGE 3: WORKER-LIFECYCLE (regression for the pool-dispose fix) =================
    const pageWk = await browser.newPage()
    pageWk.on('pageerror', (err) => console.error('[pageerror:wk]', err.message))
    pageWk.on('console', (m) => {
      if (m.type() === 'error') console.error('[page.error:wk]', m.text())
    })
    await pageWk.addInitScript(HELPER_INIT)
    // Wrap the global Worker constructor BEFORE any module import, so every
    // `new Worker(...)` the pool performs (inside png-encode-pool.ts) and every
    // `.terminate()` call is counted from outside the code under test.
    await pageWk.addInitScript(() => {
      const RealWorker = globalThis.Worker
      const stats = { constructed: 0, terminated: 0 }
      class InstrumentedWorker extends RealWorker {
        constructor(scriptURL: string | URL, options?: WorkerOptions) {
          super(scriptURL, options)
          stats.constructed++
        }
        terminate(): void {
          stats.terminated++
          super.terminate()
        }
      }
      ;(globalThis as unknown as { Worker: typeof Worker }).Worker = InstrumentedWorker
      ;(globalThis as unknown as { __workerStats: typeof stats }).__workerStats = stats
    })
    await pageWk.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await evalWithRetry(
      pageWk,
      async (cfg: Cfg) => {
        await import(cfg.wasmUrl)
        await import(cfg.sinkUrl)
        return true
      },
      CFG,
    )
    // Baseline AFTER the app has mounted: the full app (not a blank harness
    // page) is loaded at APP_URL, and it independently starts its own worker(s)
    // (e.g. the compiler worker) on mount, unrelated to the PNG encode pool —
    // and does so on its own async schedule. Poll until the counts are stable
    // for 300ms before snapshotting, so that startup churn is fully absorbed
    // into the baseline rather than leaking into the window attributed to the
    // export below. Diff baseline vs the post-finish() snapshot so only workers
    // constructed/terminated INSIDE the sink.begin()..finish() window (i.e. the
    // pool's own workers) count toward the assertion.
    const baseline = await evalWithRetry(
      pageWk,
      async () => {
        const s = (globalThis as unknown as { __workerStats: { constructed: number; terminated: number } }).__workerStats
        let last = { c: s.constructed, t: s.terminated }
        let stableMs = 0
        while (stableMs < 300) {
          await new Promise((r) => setTimeout(r, 50))
          const cur = { c: s.constructed, t: s.terminated }
          if (cur.c === last.c && cur.t === last.t) {
            stableMs += 50
          } else {
            stableMs = 0
            last = cur
          }
        }
        return { constructed: s.constructed, terminated: s.terminated }
      },
      CFG,
    )
    const wkRes = await evalWithRetry(pageWk, runWorkersTerminated, CFG)
    for (const l of wkRes.logs) console.log('  · ' + l)

    const wkConstructed = wkRes.constructed - baseline.constructed
    const wkTerminated = wkRes.terminated - baseline.terminated
    console.log(
      `  · baseline (app-startup, unrelated workers): constructed=${baseline.constructed} terminated=${baseline.terminated}`,
    )
    console.log(`  · delta attributable to this export: constructed=${wkConstructed} terminated=${wkTerminated}`)

    if (!wkRes.supported) {
      check('workers-terminated-after-finish', false, 'png-sequence sink unsupported on this page — cannot verify (anti-vacuity)')
    } else {
      check(
        'workers-terminated-after-finish',
        wkConstructed >= 1 && wkTerminated === wkConstructed,
        wkConstructed <= 0
          ? 'no Worker was constructed by this export — pool path did not run (anti-vacuity, cannot verify the dispose fix)'
          : `constructed=${wkConstructed}, terminated=${wkTerminated} — ${
              wkTerminated === wkConstructed ? 'finish() disposed every worker the export created' : 'LEAK: finish() left workers alive'
            }`,
      )
    }

    await pageWk.close()

    console.log(`\n  ${passed} passed, ${failed} failed`)
    console.log(failed === 0 ? '\nPNG-MULTIWORKER: PASS' : '\nPNG-MULTIWORKER: FAIL')
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
