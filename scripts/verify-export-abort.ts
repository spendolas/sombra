/**
 * verify:export-abort — mechanism-engaged gate for the per-sink `abort()`
 * teardown (deterministic cancel).
 *
 * On mid-export cancel/throw the engine's `finally` calls `sink.abort()`. Each
 * sink LOCKED the destination writable via `getWriter()` in `begin()`, so the
 * sink is the only party that can release it. `abort()` must therefore:
 *   1. stop the encoder (mediabunny `Output.cancel()` / fflate `Zip.terminate()`),
 *   2. RELEASE its own writer lock, and
 *   3. ABORT the destination writable
 * so the File System Access swap-file handle is discarded deterministically
 * instead of leaked to GC. If any of that is skipped the writable stays locked
 * and/or un-aborted — the exact regression this gate exists to catch.
 *
 * Why an instrumented writable, not the fallback `createExportDestination`:
 * the fallback WritableStream sink only implements `write`, so an `abort()`
 * reaching it is invisible. Here the gate hands each sink its OWN
 * `WritableStream` whose underlying sink records `abort(reason)` and `write`.
 * That makes the two teardown effects DIRECTLY observable:
 *   • `abortCalled === true`  ⇒ the destination writable really was aborted (#3),
 *   • `writable.locked === false` (and a fresh `getWriter()` succeeds) ⇒ the
 *     writer lock was released (#2). We also assert the stream WAS locked right
 *     after `begin()`, so releasing it is a real state change, not vacuous.
 *
 * Two scenarios per applicable sink:
 *   A) happy-begin teardown — begin() + a few frames, then abort() WITHOUT
 *      finish(): assert lockedAfterBegin && !lockedAfterAbort && abortCalled.
 *      Runs for all 3 sinks (mp4, webm-alpha, png-sequence).
 *   B) begin()-FAILURE regression (png, the Critical) — force the throw the code
 *      already guards (`OffscreenCanvas.getContext('2d')` → null) so begin()
 *      throws AFTER `getWriter()` acquired the lock but BEFORE the sink is fully
 *      set up; then abort() (as the engine's finally would). A correct sink still
 *      releases the lock + aborts. The pre-fix sink set its teardown guard at the
 *      END of begin() (after the throw) → guard false → abort() no-ops →
 *      `writable.locked` stays true → this check FAILS. (Proven-to-fail: with the
 *      guard moved back to the end of begin(), png-begin-failure trips with
 *      locked=true; the fix — guard set immediately after getWriter() — passes.)
 *
 * A sink unsupported on the host FAILS loudly (anti-vacuity), never skips.
 *
 * How it runs: mirrors verify:export-streaming — spawn vite, drive a headless
 * Chrome page, dynamic-import the sink modules, drive each sink directly. Exit
 * code is non-zero if ANY assertion fails.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { chromium, type Page } from 'playwright-core'

const PORT = 5213
const APP_URL = `http://localhost:${PORT}/sombra/`

interface Cfg {
  W: number
  H: number
  fps: number
  frames: number
  mp4Url: string
  webmUrl: string
  pngUrl: string
}

const CFG: Cfg = {
  W: 320,
  H: 200,
  fps: 30,
  frames: 3,
  mp4Url: '/sombra/src/export/sinks/webcodecs-mp4.ts',
  webmUrl: '/sombra/src/export/sinks/webm-alpha.ts',
  pngUrl: '/sombra/src/export/sinks/png-sequence.ts',
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

async function runAssertions(cfg: Cfg): Promise<EvalResult> {
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
    isSupported(): Promise<boolean>
    begin(o: SinkOptsLike, writable: WritableStream<Uint8Array>): Promise<void>
    addFrame(frame: VideoFrame, timestampUs: number): Promise<void>
    finish(): Promise<void>
    abort(): Promise<void>
  }
  interface Mp4Module {
    makeMp4Sink(): FrameSinkLike
  }
  interface WebmModule {
    makeWebmAlphaSink(): FrameSinkLike
  }
  interface PngModule {
    makePngSequenceSink(): FrameSinkLike
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

  const mp4 = (await import(cfg.mp4Url)) as Mp4Module
  const webm = (await import(cfg.webmUrl)) as WebmModule
  const png = (await import(cfg.pngUrl)) as PngModule

  // --- instrumented destination writable --------------------------------
  // Records whether abort() reached it and how many chunks were written, so the
  // teardown effects are directly observable.
  interface Instrumented {
    writable: WritableStream<Uint8Array>
    abortCalled: () => boolean
    writes: () => number
  }
  const makeInstrumented = (): Instrumented => {
    let aborted = false
    let writes = 0
    const writable = new WritableStream<Uint8Array>({
      write() {
        writes++
      },
      abort() {
        aborted = true
      },
      close() {},
    })
    return { writable, abortCalled: () => aborted, writes: () => writes }
  }

  // --- synthetic frame generator ----------------------------------------
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

  const opts = (alpha: boolean): SinkOptsLike => ({
    width: cfg.W,
    height: cfg.H,
    fps: cfg.fps,
    alpha,
    matte: '#000000',
    quality: 'good',
  })

  // A fresh getWriter() must succeed once the lock is released; return true iff so.
  const canReacquire = (w: WritableStream<Uint8Array>): boolean => {
    if (w.locked) return false
    try {
      const wr = w.getWriter()
      wr.releaseLock()
      return true
    } catch {
      return false
    }
  }

  // =====================================================================
  // Scenario A — happy-begin teardown, one check per sink.
  // =====================================================================
  const scenarioA = async (
    name: string,
    makeSink: () => FrameSinkLike,
    alpha: boolean,
  ): Promise<void> => {
    let sink: FrameSinkLike
    try {
      sink = makeSink()
      // webm reads its codec from isSupported(); call it on the same instance
      // (also anti-vacuity: an unsupported sink fails loudly below).
      const supported = await sink.isSupported()
      if (!supported) {
        fail(name, `${name} sink reports unsupported on host — cannot verify (anti-vacuity fail)`)
        return
      }
      const inst = makeInstrumented()
      await sink.begin(opts(alpha), inst.writable)
      const lockedAfterBegin = inst.writable.locked
      for (let i = 0; i < cfg.frames; i++) {
        const vf = makeFrame(i)
        await sink.addFrame(vf, Math.round((i * 1e6) / cfg.fps))
        vf.close()
      }
      const writesBeforeAbort = inst.writes()

      // The engine's finally on cancel: abort WITHOUT finish().
      await sink.abort()

      const lockedAfterAbort = inst.writable.locked
      const abortReached = inst.abortCalled()
      const reacquired = canReacquire(inst.writable)
      log(
        `${name}: lockedAfterBegin=${lockedAfterBegin}, writesBeforeAbort=${writesBeforeAbort}, ` +
          `lockedAfterAbort=${lockedAfterAbort}, abortCalled=${abortReached}, reacquired=${reacquired}`,
      )

      // Mechanism-engaged: the sink DID lock the stream, then abort() released
      // that lock AND aborted the destination writable.
      if (lockedAfterBegin && !lockedAfterAbort && abortReached && reacquired) {
        pass(
          name,
          `begin() locked the writable; abort() released the lock (reacquired) and aborted the destination`,
        )
      } else {
        fail(
          name,
          `lockedAfterBegin=${lockedAfterBegin} (want true), lockedAfterAbort=${lockedAfterAbort} (want false), ` +
            `abortCalled=${abortReached} (want true), reacquired=${reacquired} (want true)`,
        )
      }

      // abort() must be idempotent / safe to call again (best-effort, no throw).
      try {
        await sink.abort()
      } catch (e) {
        fail(`${name}-idempotent`, `second abort() threw: ${String(e)}`)
        return
      }
      pass(`${name}-idempotent`, 'second abort() is a safe no-op')
    } catch (e) {
      fail(name, `threw: ${String(e)}`)
    }
  }

  await scenarioA('mp4-abort', () => mp4.makeMp4Sink(), false)
  await scenarioA('webm-abort', () => webm.makeWebmAlphaSink(), true)
  await scenarioA('png-abort', () => png.makePngSequenceSink(), true)

  // =====================================================================
  // Scenario B — png begin()-FAILURE regression (the Critical).
  // Force getContext('2d') → null so begin() throws AFTER getWriter() locked the
  // stream. A correct sink still releases the lock + aborts in abort().
  // =====================================================================
  {
    const name = 'png-begin-failure'
    const origGetContext = OffscreenCanvas.prototype.getContext
    try {
      const inst = makeInstrumented()
      const sink = png.makePngSequenceSink()
      // Override ONLY for begin() so the sink's `cv.getContext('2d')` returns null
      // and begin() throws its guarded error — with the lock already held.
      ;(OffscreenCanvas.prototype as unknown as { getContext: () => null }).getContext = () => null
      let beganThrew = false
      try {
        await sink.begin(opts(true), inst.writable)
      } catch {
        beganThrew = true
      }
      // Restore before anything else touches a canvas.
      OffscreenCanvas.prototype.getContext = origGetContext
      const lockedAfterFailedBegin = inst.writable.locked

      // The engine's finally still runs abort() on the failed begin.
      await sink.abort()
      const lockedAfterAbort = inst.writable.locked
      const abortReached = inst.abortCalled()
      const reacquired = canReacquire(inst.writable)
      log(
        `${name}: beganThrew=${beganThrew}, lockedAfterFailedBegin=${lockedAfterFailedBegin}, ` +
          `lockedAfterAbort=${lockedAfterAbort}, abortCalled=${abortReached}, reacquired=${reacquired}`,
      )

      // beganThrew && lockedAfterFailedBegin prove the bug's precondition (lock
      // acquired, begin() then threw). The fix's assertion: abort() STILL frees
      // the lock and aborts. Pre-fix (guard set late) → lockedAfterAbort stays
      // true → FAIL.
      if (beganThrew && lockedAfterFailedBegin && !lockedAfterAbort && abortReached && reacquired) {
        pass(
          name,
          `begin() threw after acquiring the lock; abort() still released it (reacquired) and aborted the destination`,
        )
      } else {
        fail(
          name,
          `beganThrew=${beganThrew} (want true), lockedAfterFailedBegin=${lockedAfterFailedBegin} (want true), ` +
            `lockedAfterAbort=${lockedAfterAbort} (want false), abortCalled=${abortReached} (want true), reacquired=${reacquired} (want true)`,
        )
      }
    } catch (e) {
      OffscreenCanvas.prototype.getContext = origGetContext
      fail(name, `threw: ${String(e)}`)
    }
  }

  return { checks, logs }
}

// ---------------------------------------------------------------------------
// Node-side orchestration (mirrors verify-export-streaming).
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
      await page.waitForFunction(() => document.readyState === 'complete', null, { timeout: 60_000 }).catch(() => {})
    }
  }
  throw new Error('unreachable')
}

async function main(): Promise<number> {
  console.log('verify:export-abort — headless per-sink abort() teardown gate\n')
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
      if (m.text().includes('Mediabunny was loaded twice')) return
      console.error('[page.error]', m.text())
    })

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

    // Prewarm: force vite's one-time dep-optimize reload before the assertion pass.
    await evalWithRetry(
      page,
      async (cfg: Cfg) => {
        await import(cfg.mp4Url)
        await import(cfg.webmUrl)
        await import(cfg.pngUrl)
        return true
      },
      CFG,
    )

    const result = await evalWithRetry(page, runAssertions, CFG)

    for (const line of result.logs) console.log('  · ' + line)
    console.log('')

    let failed = 0
    let passed = 0
    for (const c of result.checks) {
      const tag = c.status === 'pass' ? 'PASS' : 'FAIL'
      console.log(`  [${tag}] ${c.name} — ${c.detail}`)
      if (c.status === 'fail') failed++
      else passed++
    }
    console.log(`\n  ${passed} passed, ${failed} failed`)
    console.log(failed === 0 ? '\nEXPORT-ABORT: PASS' : '\nEXPORT-ABORT: FAIL')
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
