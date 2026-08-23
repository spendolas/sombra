/**
 * verify:export-streaming — mechanism-engaged gate proving export output is
 * STREAMED incrementally, never assembled as one whole-file buffer.
 *
 * The export pipeline was rearchitected so bytes flow into a WritableStream as
 * they are produced: the PNG sink pushes each frame into a streaming fflate Zip
 * and DROPS it (no `frames[]`), and the video sinks emit through mediabunny's
 * `StreamTarget` (fragmented output) instead of `BufferTarget`. The failure this
 * prevents (holding every frame / building one giant buffer) is BYTE-CORRECT —
 * the produced file is identical — so output-validity checks alone cannot catch
 * a regression. Only the *shape of delivery* distinguishes them.
 *
 * The discriminating observable is the fallback destination's `_partsCount()`
 * (reads `parts.length` inside the impl — one part per accepted chunk). Streaming
 * makes it grow to ≫1 as frames are produced; a "buffer everything then emit
 * once" regression collapses it to 1. This gate asserts, per sink:
 *
 *   #1 chunked-delivery (mp4 + png): after finish(), _partsCount() ≫ 1.
 *      A single-buffer regression → 1 → FAILS.
 *   #2 streaming-during-frames (png): _partsCount() is already ≫1 AFTER the
 *      addFrame loop but BEFORE finish() — proving frames are flushed as they
 *      arrive, not accumulated and dumped at finish(). If parts only appear at
 *      finish() → not streaming → FAILS.
 *   #3 video-uses-StreamTarget: behavioural — mp4 delivers many chunks (as #1) —
 *      PLUS a source-grep backstop (BufferTarget absent, StreamTarget present).
 *   #4 validity backstop: the produced fallback Blob is a well-formed file
 *      (mp4 demuxes via mediabunny to N frames; zip unzips to N PNG entries) so
 *      "streamed" can't pass on garbage.
 *
 * Proven-to-fail: see task-9-report.md — a scratch perturbation that buffers all
 * chunks and writes once collapsed _partsCount() to 1 and tripped #1/#2/#3.
 *
 * How it runs: the sinks import mediabunny/fflate (bare deps) + WebCodecs +
 * OffscreenCanvas — they can't load in a blank page. So (like verify:video-export)
 * this spawns vite, drives a headless Chrome page, dynamic-imports the sink
 * modules, drives each sink DIRECTLY (begin → addFrame×N → finish) with
 * synthetic high-entropy noise frames, and reads `_partsCount()` around finish().
 * A sink unsupported on the host FAILS loudly (anti-vacuity) rather than skipping.
 *
 * Self-contained: spawns vite on a fixed test port and kills it in `finally`.
 * Exit code is non-zero if ANY assertion fails.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { chromium, type Page } from 'playwright-core'

const PORT = 5211
const APP_URL = `http://localhost:${PORT}/sombra/`

// ---------------------------------------------------------------------------
// Config handed to the in-page function (page.evaluate serializes the function;
// it closes over NOTHING from Node, so everything it needs travels here).
// ---------------------------------------------------------------------------
interface Cfg {
  /** Non-trivial export size so PNGs/MP4 fragments are real, multi-chunk output. */
  W: number
  H: number
  fps: number
  frames: number
  destUrl: string
  mp4Url: string
  pngUrl: string
  mediabunnyUrl: string
  fflateUrl: string
}

const CFG: Cfg = {
  W: 2048,
  H: 1280,
  fps: 30,
  frames: 32,
  destUrl: '/sombra/src/export/export-destination.ts',
  mp4Url: '/sombra/src/export/sinks/webcodecs-mp4.ts',
  pngUrl: '/sombra/src/export/sinks/png-sequence.ts',
  mediabunnyUrl: '/sombra/node_modules/mediabunny/dist/modules/src/index.js',
  fflateUrl: '/sombra/node_modules/fflate/esm/browser.js',
}

interface CheckResult {
  name: string
  status: 'pass' | 'fail'
  detail: string
}
interface EvalResult {
  checks: CheckResult[]
  logs: string[]
}

// ---------------------------------------------------------------------------
// In-page body. Runs entirely in the browser — references only its `cfg`
// argument, browser globals, and functions/types declared inside it.
// ---------------------------------------------------------------------------
async function runAssertions(cfg: Cfg): Promise<EvalResult> {
  // --- minimal shapes for the dynamically-imported modules (erased at runtime) ---
  interface SinkOptsLike {
    width: number
    height: number
    fps: number
    alpha: boolean
    matte?: string
    quality: 'draft' | 'good' | 'high' | 'max'
  }
  interface FrameSinkLike {
    readonly id: string
    readonly fileExt: string
    readonly mimeType: string
    isSupported(): Promise<boolean>
    begin(o: SinkOptsLike, writable: WritableStream<Uint8Array>): Promise<void>
    addFrame(frame: VideoFrame, timestampUs: number): Promise<void>
    finish(): Promise<void>
  }
  interface ExportDestinationLike {
    writable: WritableStream<Uint8Array>
    finalize(): Promise<{ blob: Blob | null; savedToDisk: boolean; filename: string }>
    readonly _partsCount?: () => number
  }
  interface DestModule {
    createExportDestination(opts: {
      filename: string
      mimeType: string
      ext: string
      preferDisk: boolean
    }): Promise<ExportDestinationLike>
  }
  interface Mp4Module {
    makeMp4Sink(): FrameSinkLike
  }
  interface PngModule {
    makePngSequenceSink(): FrameSinkLike
  }
  interface MbSample {
    readonly displayWidth: number
    readonly displayHeight: number
    close(): void
  }
  interface MbTrack {
    readonly displayWidth: number
    readonly displayHeight: number
  }
  interface MbInput {
    getPrimaryVideoTrack(): Promise<MbTrack | null>
  }
  interface MbVideoSampleSink {
    samples(): AsyncGenerator<MbSample, void, unknown>
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

  const destMod = (await import(cfg.destUrl)) as DestModule
  const mp4 = (await import(cfg.mp4Url)) as Mp4Module
  const png = (await import(cfg.pngUrl)) as PngModule
  const MB = (await import(cfg.mediabunnyUrl)) as MediabunnyModule
  const FF = (await import(cfg.fflateUrl)) as FflateModule

  // --- synthetic high-entropy frame generator ---------------------------
  // A fresh noise field per frame: RGB filled by a cheap per-frame-seeded
  // xorshift PRNG (opaque alpha). High entropy → PNGs don't compress to
  // nothing and MP4 carries a real bitrate, so each frame is a substantial,
  // multi-chunk payload — the streaming behaviour has something to stream.
  const genCanvas = new OffscreenCanvas(cfg.W, cfg.H)
  const genCtx = genCanvas.getContext('2d')
  if (!genCtx) throw new Error('OffscreenCanvas 2D context unavailable (frame generator)')
  const img = genCtx.createImageData(cfg.W, cfg.H)
  const makeFrame = (i: number): VideoFrame => {
    const data = img.data
    let s = (i + 1) * 0x9e3779b1 || 1
    for (let p = 0; p < data.length; p += 4) {
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      const r = s >>> 0
      data[p] = r & 0xff
      data[p + 1] = (r >>> 8) & 0xff
      data[p + 2] = (r >>> 16) & 0xff
      data[p + 3] = 255
    }
    genCtx.putImageData(img, 0, 0)
    return new VideoFrame(genCanvas, { timestamp: Math.round((i * 1e6) / cfg.fps) })
  }

  interface StreamRun {
    partsAfterBegin: number
    partsAfterFrames: number
    partsAfterFinish: number
    blob: Blob
  }
  // Drive a sink DIRECTLY into a fallback destination, sampling _partsCount()
  // at each phase boundary so we can distinguish "streamed during frames" from
  // "buffered, emitted at finish" from "one whole-file buffer".
  const runSink = async (sink: FrameSinkLike, alpha: boolean): Promise<StreamRun> => {
    const dest = await destMod.createExportDestination({
      filename: `scene.${sink.fileExt}`,
      mimeType: sink.mimeType,
      ext: sink.fileExt,
      preferDisk: false,
    })
    if (typeof dest._partsCount !== 'function') throw new Error('fallback destination missing _partsCount()')
    const opts: SinkOptsLike = {
      width: cfg.W,
      height: cfg.H,
      fps: cfg.fps,
      alpha,
      matte: '#000000',
      quality: 'good',
    }
    await sink.begin(opts, dest.writable)
    const partsAfterBegin = dest._partsCount()
    for (let i = 0; i < cfg.frames; i++) {
      const vf = makeFrame(i)
      await sink.addFrame(vf, Math.round((i * 1e6) / cfg.fps))
      vf.close()
    }
    const partsAfterFrames = dest._partsCount()
    await sink.finish()
    const partsAfterFinish = dest._partsCount()
    const { blob } = await dest.finalize()
    if (!blob) throw new Error('fallback destination produced no blob')
    return { partsAfterBegin, partsAfterFrames, partsAfterFinish, blob }
  }

  // --- decode helpers (validity backstop) -------------------------------
  const countMp4Frames = async (blob: Blob): Promise<{ n: number; w: number; h: number }> => {
    const input = new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS })
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('no primary video track in decoded mp4')
    const sink = new MB.VideoSampleSink(track)
    let n = 0
    for await (const s of sink.samples()) {
      n++
      s.close()
    }
    return { n, w: track.displayWidth, h: track.displayHeight }
  }

  // Feature detection — a false isSupported() FAILS (anti-vacuity), never skips.
  const mp4Supported = await mp4.makeMp4Sink().isSupported()
  const pngSupported = await png.makePngSequenceSink().isSupported()

  // =====================================================================
  // PNG sink — the sharpest streaming signal (deterministic per-frame flush).
  // =====================================================================
  if (!pngSupported) {
    fail('png-streaming', 'png-sequence sink reports unsupported on host — cannot verify (anti-vacuity fail)')
    fail('png-during-frames', 'png-sequence sink unsupported on host')
    fail('png-validity', 'png-sequence sink unsupported on host')
  } else {
    try {
      const r = await runSink(png.makePngSequenceSink(), true)
      log(
        `png parts: afterBegin=${r.partsAfterBegin}, afterFrames=${r.partsAfterFrames}, ` +
          `afterFinish=${r.partsAfterFinish} (frames=${cfg.frames})`,
      )

      // #1 chunked delivery: many separate chunks reached the destination.
      // A buffer-everything regression collapses this to 1.
      if (r.partsAfterFinish >= cfg.frames) {
        pass('png-streaming', `${r.partsAfterFinish} chunks streamed (≥ frames=${cfg.frames}); single-buffer regression → 1`)
      } else {
        fail('png-streaming', `only ${r.partsAfterFinish} chunks (want ≥ frames=${cfg.frames}) — not streamed per frame`)
      }

      // #2 streaming DURING frames: parts already ≫1 before finish(), then MORE
      // at finish() (central directory). If parts only appear at finish → the
      // sink accumulated frames and dumped them → regression.
      if (r.partsAfterFrames >= cfg.frames && r.partsAfterFinish > r.partsAfterFrames) {
        pass(
          'png-during-frames',
          `${r.partsAfterFrames} chunks before finish() (≥ frames) then ${r.partsAfterFinish} after — flushed as frames arrived`,
        )
      } else {
        fail(
          'png-during-frames',
          `afterFrames=${r.partsAfterFrames} (want ≥ ${cfg.frames}), afterFinish=${r.partsAfterFinish} (want > afterFrames) — frames not flushed incrementally`,
        )
      }

      // #4 validity: the streamed zip is well-formed with exactly N PNG entries.
      const zip = new Uint8Array(await r.blob.arrayBuffer())
      const files = FF.unzipSync(zip)
      const names = Object.keys(files).filter((k) => k.endsWith('.png'))
      if (names.length === cfg.frames && names.every((k) => files[k].length > 0)) {
        pass('png-validity', `zip unzips to ${names.length} non-empty PNG entries`)
      } else {
        fail('png-validity', `expected ${cfg.frames} PNG entries, got ${names.length}`)
      }
    } catch (e) {
      fail('png-streaming', `threw: ${String(e)}`)
      fail('png-during-frames', `threw: ${String(e)}`)
      fail('png-validity', `threw: ${String(e)}`)
    }
  }

  // =====================================================================
  // MP4 sink — StreamTarget (fragmented) emits many chunks incrementally.
  // BufferTarget would deliver one final buffer → _partsCount() === 1.
  // =====================================================================
  if (!mp4Supported) {
    fail('mp4-streaming', 'mp4 sink reports unsupported on host — cannot verify (anti-vacuity fail)')
    fail('mp4-validity', 'mp4 sink unsupported on host')
  } else {
    try {
      const r = await runSink(mp4.makeMp4Sink(), false)
      log(
        `mp4 parts: afterBegin=${r.partsAfterBegin}, afterFrames=${r.partsAfterFrames}, ` +
          `afterFinish=${r.partsAfterFinish} (frames=${cfg.frames})`,
      )

      // #1/#3 chunked delivery via StreamTarget (fragmented mp4): the init
      // segment (ftyp+moov) is flushed as its OWN write at begin() — BEFORE any
      // frame or finish() — and the media is written at finalize(). So a healthy
      // StreamTarget shows partsAfterBegin ≥ 1 and partsAfterFinish > that (≥ 2
      // total, header and body delivered as separate writes). A BufferTarget
      // regression buffers the WHOLE file and writes it once at finalize:
      // partsAfterBegin === 0, partsAfterFinish === 1 — which trips BOTH clauses.
      if (r.partsAfterBegin >= 1 && r.partsAfterFinish >= 2 && r.partsAfterFinish > r.partsAfterBegin) {
        pass(
          'mp4-streaming',
          `init segment streamed at begin() (${r.partsAfterBegin} chunk), body at finalize() → ${r.partsAfterFinish} total; BufferTarget regression → begin=0/finish=1`,
        )
      } else {
        fail(
          'mp4-streaming',
          `afterBegin=${r.partsAfterBegin} (want ≥ 1), afterFinish=${r.partsAfterFinish} (want ≥ 2 and > afterBegin) — output not streamed incrementally (BufferTarget?)`,
        )
      }

      // #4 validity: the streamed mp4 demuxes to exactly N frames at export dims.
      const { n, w, h } = await countMp4Frames(r.blob)
      if (r.blob.type === 'video/mp4' && n === cfg.frames && w === cfg.W && h === cfg.H) {
        pass('mp4-validity', `demuxed ${n} frames @ ${w}x${h}`)
      } else {
        fail('mp4-validity', `type=${r.blob.type}, ${n} frames @ ${w}x${h} (want ${cfg.frames} @ ${cfg.W}x${cfg.H})`)
      }
    } catch (e) {
      fail('mp4-streaming', `threw: ${String(e)}`)
      fail('mp4-validity', `threw: ${String(e)}`)
    }
  }

  return { checks, logs }
}

// ---------------------------------------------------------------------------
// Node-side orchestration
// ---------------------------------------------------------------------------

// #3 backstop (Node-side, structural): the video sink source must use
// StreamTarget and must NOT reference BufferTarget. A second, independent signal
// that the video path streams rather than buffers.
function grepVideoSinkSource(): CheckResult {
  try {
    const src = readFileSync(new URL('../src/export/sinks/webcodecs-mp4.ts', import.meta.url), 'utf8')
    const hasStream = /\bStreamTarget\b/.test(src)
    const hasBuffer = /\bBufferTarget\b/.test(src)
    if (hasStream && !hasBuffer) {
      return { name: 'mp4-source-streamtarget', status: 'pass', detail: 'webcodecs-mp4.ts uses StreamTarget, no BufferTarget' }
    }
    return {
      name: 'mp4-source-streamtarget',
      status: 'fail',
      detail: `StreamTarget=${hasStream}, BufferTarget=${hasBuffer} (want StreamTarget present, BufferTarget absent)`,
    }
  } catch (e) {
    return { name: 'mp4-source-streamtarget', status: 'fail', detail: `could not read source: ${String(e)}` }
  }
}

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
      await page.waitForFunction(() => document.readyState === 'complete', null, { timeout: 60_000 }).catch(() => {})
    }
  }
  throw new Error('unreachable')
}

async function main(): Promise<number> {
  console.log('verify:export-streaming — headless incremental-delivery gate\n')
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
    console.log('  vite is up; launching headless Chrome (WebCodecs) …\n')

    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=metal'],
    })
    const page = await browser.newPage()
    page.on('pageerror', (err) => console.error('[pageerror]', err.message))
    page.on('console', (m) => {
      if (m.type() !== 'error') return
      // The gate loads a SECOND mediabunny instance for decode (the sink owns the
      // encode instance); mediabunny logs this once. Benign — suppress only this.
      if (m.text().includes('Mediabunny was loaded twice')) return
      console.error('[page.error]', m.text())
    })

    // tsx transpiles this file with esbuild (keepNames), injecting `__name`/
    // `__defProp` helpers into functions. When Playwright serializes the in-page
    // function they reference free vars that only exist in Node scope — define
    // them on the page global so the serialized body resolves. addInitScript runs
    // before every navigation, surviving vite's dep-optimize reload.
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

    // Prewarm: force vite's one-time dep-optimize reload to happen HERE, before
    // the expensive assertion pass, so the latter runs in a stable context.
    await evalWithRetry(
      page,
      async (cfg: Cfg) => {
        await import(cfg.destUrl)
        await import(cfg.mp4Url)
        await import(cfg.pngUrl)
        await import(cfg.mediabunnyUrl)
        await import(cfg.fflateUrl)
        return true
      },
      CFG,
    )

    const result = await evalWithRetry(page, runAssertions, CFG)

    for (const line of result.logs) console.log('  · ' + line)
    console.log('')

    const allChecks: CheckResult[] = [...result.checks, grepVideoSinkSource()]

    let failed = 0
    let passed = 0
    for (const c of allChecks) {
      const tag = c.status === 'pass' ? 'PASS' : 'FAIL'
      console.log(`  [${tag}] ${c.name} — ${c.detail}`)
      if (c.status === 'fail') failed++
      else passed++
    }
    console.log(`\n  ${passed} passed, ${failed} failed`)
    console.log(failed === 0 ? '\nEXPORT-STREAMING: PASS' : '\nEXPORT-STREAMING: FAIL')
    return failed === 0 ? 0 : 1
  } finally {
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
          /* already gone */
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
