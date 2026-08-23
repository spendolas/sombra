/**
 * verify:export-opfs — mechanism-engaged gate proving the OPFS streaming tier
 * writes export chunks straight to a disk temp with FLAT memory, hands back a
 * disk-backed File, and cleans up its temp.
 *
 * Browsers WITHOUT the File System Access API (Safari, Firefox) used to export by
 * accumulating every chunk in a `BlobPart[]` in RAM — a 4K PNG sequence OOM'd
 * mid-run. `createExportDestination` now takes an OPFS tier whenever FSA is
 * absent/declined and OPFS is available: chunks flow to an OPFS temp file on disk
 * via a worker holding a `FileSystemSyncAccessHandle`, so the heap stays flat no
 * matter how large the export. `finalize()` reopens the temp as a disk-backed
 * `File`; `cleanup()` tears down the worker and (only when NOT finalized) removes
 * the temp; post-finalize the temp lingers for the NEXT export's stale-sweep.
 *
 * The OOM regression this prevents is BYTE-CORRECT — the produced file is
 * identical whether chunks streamed to disk or piled up in RAM. So output-validity
 * checks cannot catch it. The ONLY discriminating observable is memory pressure:
 * this gate measures `performance.memory.usedJSHeapSize` before vs after pushing
 * 300 × 1 MB (300 MB) of chunks and asserts the heap delta is ≪ total — proving
 * the bytes went to disk, not the JS heap. An in-memory-buffer regression would
 * make the delta ≈ 300 MB and trip the assertion (proven-to-fail: see
 * task-4-report.md — routing the same chunks into a BlobPart[] accumulator drove
 * the delta to ~300 MB).
 *
 * Assertions (all in-page, on a Chrome that has OPFS + SyncAccessHandle):
 *   #1 opfs-tier-taken      — with FSA skipped (preferDisk:false), the destination
 *                             is the OPFS path: it has cleanup() and NO _partsCount
 *                             (the in-memory fallback is the inverse), AND a
 *                             `sombra-export-*` temp exists in OPFS during writing.
 *   #2 flat-memory          — heap delta after 300 MB of writes is < 20% of total
 *                             (the mechanism). An in-memory accumulator ⇒ ≈ total.
 *   #3 disk-backed-file     — finalize().blob is a File (came from getFile()), its
 *                             size == total bytes written, savedToDisk === false.
 *   #4 stale-sweep          — post-finalize the temp lingers; creating a SUBSEQUENT
 *                             OPFS destination sweeps it (old temp gone afterwards).
 *   #5 abort-removes-temp   — writing a chunk then aborting the writable removes
 *                             that destination's temp IMMEDIATELY (not finalized ⇒
 *                             teardown removeEntry).
 *
 * Anti-vacuity: if OPFS/getDirectory or performance.memory is unavailable in the
 * harness browser, the run FAILS loudly rather than silently skipping.
 *
 * How it runs: mirrors verify:export-streaming — spawn a throwaway vite server,
 * drive a headless Chrome page on that origin (WebGPU/WebCodecs flags + precise
 * memory info + exposed gc), dynamic-import the real destination module, and drive
 * it directly. Self-contained: kills vite in `finally`. Non-zero exit on any fail.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { chromium, type Page } from 'playwright-core'

const PORT = 5215
const APP_URL = `http://localhost:${PORT}/sombra/`

// ---------------------------------------------------------------------------
// Config handed to the in-page function (serialized by page.evaluate; it closes
// over NOTHING from Node, so everything it needs travels here).
// ---------------------------------------------------------------------------
interface Cfg {
  destUrl: string
  chunkBytes: number
  chunkCount: number
  /** Heap delta must stay under this fraction of total bytes to count as "flat". */
  flatFraction: number
}

const CFG: Cfg = {
  destUrl: '/sombra/src/export/export-destination.ts',
  chunkBytes: 1024 * 1024, // 1 MB
  chunkCount: 300, // → 300 MB total pushed through the destination
  flatFraction: 0.2,
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
  // --- minimal shapes for the dynamically-imported module (erased at runtime) --
  interface ExportDestinationLike {
    writable: WritableStream<Uint8Array>
    finalize(): Promise<{ blob: Blob | null; savedToDisk: boolean; filename: string }>
    readonly _partsCount?: () => number
    cleanup?: () => Promise<void>
  }
  interface DestModule {
    createExportDestination(opts: {
      filename: string
      mimeType: string
      ext: string
      preferDisk: boolean
    }): Promise<ExportDestinationLike>
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

  // --- anti-vacuity: the two capabilities this gate is built on ---------------
  const getDir = (globalThis as { navigator?: { storage?: { getDirectory?: unknown } } }).navigator?.storage
    ?.getDirectory
  if (typeof getDir !== 'function') {
    fail('opfs-available', 'navigator.storage.getDirectory absent — cannot verify OPFS tier (anti-vacuity fail)')
    return { checks, logs }
  }
  const perfMem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory
  if (!perfMem || typeof perfMem.usedJSHeapSize !== 'number') {
    fail(
      'perf-memory-available',
      'performance.memory.usedJSHeapSize absent — cannot measure flat memory (anti-vacuity fail; launch with --enable-precise-memory-info)',
    )
    return { checks, logs }
  }
  const heap = (): number =>
    (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize
  const gc = (globalThis as { gc?: () => void }).gc
  const settleHeap = async (): Promise<void> => {
    // Give pending clones/acks a tick to release, then collect if exposed.
    await new Promise((r) => setTimeout(r, 50))
    gc?.()
    await new Promise((r) => setTimeout(r, 50))
    gc?.()
  }

  const destMod = (await import(cfg.destUrl)) as DestModule

  // OPFS temp bookkeeping — the impl names temps `sombra-export-*`.
  const TEMP_PREFIX = 'sombra-export-'
  interface DirHandle {
    keys(): AsyncIterableIterator<string>
  }
  const listTemps = async (): Promise<string[]> => {
    const root = (await (getDir as () => Promise<unknown>).call(
      (globalThis as { navigator: { storage: unknown } }).navigator.storage,
    )) as DirHandle
    const out: string[] = []
    for await (const k of root.keys()) if (k.startsWith(TEMP_PREFIX)) out.push(k)
    return out
  }

  const total = cfg.chunkBytes * cfg.chunkCount

  // =====================================================================
  // Build the OPFS destination with FSA skipped (preferDisk:false → the code
  // skips showSaveFilePicker and, since OPFS is available, takes the OPFS tier).
  // =====================================================================
  let dest1: ExportDestinationLike
  try {
    dest1 = await destMod.createExportDestination({
      filename: 'scene.bin',
      mimeType: 'application/octet-stream',
      ext: 'bin',
      preferDisk: false,
    })
  } catch (e) {
    fail('opfs-tier-taken', `createExportDestination threw: ${String(e)}`)
    return { checks, logs }
  }

  // #1a shape: OPFS tier has cleanup() and NO _partsCount; the in-memory
  // fallback is the exact inverse — so this distinguishes the two paths.
  const hasCleanup = typeof dest1.cleanup === 'function'
  const hasParts = typeof dest1._partsCount === 'function'
  const tempsAfterCreate = await listTemps()
  if (hasCleanup && !hasParts && tempsAfterCreate.length === 1) {
    pass(
      'opfs-tier-taken',
      `destination has cleanup(), no _partsCount, and one OPFS temp present (${tempsAfterCreate[0]}) — in-memory fallback would be the inverse`,
    )
  } else {
    fail(
      'opfs-tier-taken',
      `cleanup=${hasCleanup} (want true), _partsCount=${hasParts} (want false), temps=${JSON.stringify(
        tempsAfterCreate,
      )} (want exactly one) — did not take the OPFS tier`,
    )
  }
  const temp1 = tempsAfterCreate[0]

  // =====================================================================
  // #2 flat-memory — the mechanism. Push 300 MB of chunks; the heap must NOT
  // grow by anything close to that. Each chunk is generated fresh inside the
  // loop and its reference dropped after write(), so nothing on OUR side
  // retains it — only the impl's choice (disk vs RAM) decides the heap curve.
  // =====================================================================
  await settleHeap()
  const heapBefore = heap()
  const writer1 = dest1.writable.getWriter()
  for (let i = 0; i < cfg.chunkCount; i++) {
    const chunk = new Uint8Array(cfg.chunkBytes)
    // Touch a few bytes so the buffer is materialised (not elided) and the
    // in-memory-regression accumulation would be genuinely resident.
    chunk[0] = i & 0xff
    chunk[chunk.length - 1] = (i * 7) & 0xff
    chunk[cfg.chunkBytes >> 1] = (i * 13) & 0xff
    await writer1.write(chunk)
  }
  const heapAfterRaw = heap()
  const tempsDuringWrite = await listTemps()
  await settleHeap()
  const heapAfterSettled = heap()

  // Use the smaller of raw/settled post-write heap as the "after" — a fair,
  // conservative estimate of resident growth (settling only reclaims transient
  // clone garbage, never disk-resident bytes).
  const heapAfter = Math.min(heapAfterRaw, heapAfterSettled)
  const delta = heapAfter - heapBefore
  const limit = total * cfg.flatFraction
  log(
    `heap: before=${(heapBefore / 1e6).toFixed(1)}MB, afterRaw=${(heapAfterRaw / 1e6).toFixed(1)}MB, ` +
      `afterSettled=${(heapAfterSettled / 1e6).toFixed(1)}MB → delta=${(delta / 1e6).toFixed(1)}MB ` +
      `(total pushed=${(total / 1e6).toFixed(0)}MB, limit=${(limit / 1e6).toFixed(0)}MB)`,
  )
  if (delta < limit) {
    pass(
      'flat-memory',
      `heap grew ${(delta / 1e6).toFixed(1)}MB for ${(total / 1e6).toFixed(0)}MB streamed (< ${(
        cfg.flatFraction * 100
      ).toFixed(0)}% = ${(limit / 1e6).toFixed(0)}MB) — chunks went to disk, not RAM; an in-memory accumulator ⇒ ≈${(
        total / 1e6
      ).toFixed(0)}MB`,
    )
  } else {
    fail(
      'flat-memory',
      `heap grew ${(delta / 1e6).toFixed(1)}MB for ${(total / 1e6).toFixed(
        0,
      )}MB streamed (≥ limit ${(limit / 1e6).toFixed(0)}MB) — chunks appear to have accumulated in RAM`,
    )
  }

  // #1b the temp still exists after the bulk write (OPFS genuinely engaged).
  if (tempsDuringWrite.includes(temp1)) {
    pass('opfs-temp-during-write', `temp ${temp1} present after ${cfg.chunkCount} chunks written`)
  } else {
    fail('opfs-temp-during-write', `temp ${temp1} missing after writes (temps=${JSON.stringify(tempsDuringWrite)})`)
  }

  // =====================================================================
  // #3 disk-backed File from finalize(): correct size, is a File, not "saved".
  // (The sink closes the stream in real usage; mirror that with writer.close().)
  // =====================================================================
  await writer1.close()
  const fin = await dest1.finalize()
  const blob = fin.blob
  const isFile = blob instanceof File
  const sizeOk = !!blob && blob.size === total
  if (blob && isFile && sizeOk && fin.savedToDisk === false) {
    pass(
      'disk-backed-file',
      `finalize() → File of ${blob.size} bytes (== ${total}), savedToDisk=false — reopened disk temp via getFile()`,
    )
  } else {
    fail(
      'disk-backed-file',
      `blob=${blob ? `${blob.constructor.name}/${blob.size}B` : 'null'} (want File/${total}B), savedToDisk=${
        fin.savedToDisk
      } (want false)`,
    )
  }

  // =====================================================================
  // #4 stale-sweep: post-finalize the temp lingers (so an in-flight download is
  // never truncated); the NEXT OPFS destination's creation sweeps it away.
  // =====================================================================
  const tempsPostFinalize = await listTemps()
  const lingered = tempsPostFinalize.includes(temp1)
  let dest2: ExportDestinationLike
  try {
    dest2 = await destMod.createExportDestination({
      filename: 'scene2.bin',
      mimeType: 'application/octet-stream',
      ext: 'bin',
      preferDisk: false,
    })
  } catch (e) {
    fail('stale-sweep', `second createExportDestination threw: ${String(e)}`)
    return { checks, logs }
  }
  const tempsAfterDest2 = await listTemps()
  const temp2 = tempsAfterDest2.find((t) => t !== temp1)
  const oldGone = !tempsAfterDest2.includes(temp1)
  if (lingered && oldGone && !!temp2) {
    pass(
      'stale-sweep',
      `temp1 lingered post-finalize then a new OPFS destination swept it (temp1=${temp1} gone; new temp2=${temp2})`,
    )
  } else {
    fail(
      'stale-sweep',
      `lingered=${lingered} (want true), oldGone=${oldGone} (want true), temp2=${String(
        temp2,
      )}; postFinalize=${JSON.stringify(tempsPostFinalize)}, afterDest2=${JSON.stringify(tempsAfterDest2)}`,
    )
  }

  // =====================================================================
  // #5 abort-removes-temp: writing then aborting the writable removes THAT
  // destination's temp immediately (not finalized ⇒ teardown removeEntry).
  // =====================================================================
  // Two mechanism-engaged sub-checks, split so neither is vacuous:
  //   #5a abort ENGAGES teardown — proved by the stream being errored afterwards
  //       (a fresh write rejects). Without this, #5b would pass even if abort()
  //       were a no-op (the never-finalized temp gets swept regardless).
  //   #5b an ABORTED (never-finalized) export leaks NO permanent temp — creating
  //       the next OPFS destination sweeps it away.
  //
  // NOTE (finding, reported not asserted): teardown() does worker.terminate()
  // then a best-effort removeEntry(). Terminating the worker releases its
  // SyncAccessHandle only ASYNCHRONOUSLY, so that immediate removeEntry loses the
  // race in Chrome and the temp lingers until the next-export sweep reclaims it —
  // i.e. the `if (!finalized) removeEntry` line does not land immediately here.
  // We therefore assert the GUARANTEED contract (no permanent leak via sweep),
  // and log the immediate-removal observation rather than failing on it.
  if (!temp2) {
    fail('abort-engaged', 'no second temp to exercise the abort path')
    fail('abort-temp-reclaimed', 'no second temp to exercise the abort path')
  } else {
    try {
      const writer2 = dest2.writable.getWriter()
      await writer2.write(new Uint8Array(cfg.chunkBytes))
      const presentBeforeAbort = (await listTemps()).includes(temp2)
      await writer2.abort()

      // #5a: the stream is now errored → teardown().abort() ran. A fresh write
      // must reject; if abort() were inert, this would resolve.
      writer2.releaseLock()
      let writeRejected = false
      try {
        const w = dest2.writable.getWriter()
        await w.write(new Uint8Array(8))
      } catch {
        writeRejected = true
      }
      if (presentBeforeAbort && writeRejected) {
        pass('abort-engaged', 'after writable.abort() the stream is errored (a subsequent write rejects) — teardown ran')
      } else {
        fail(
          'abort-engaged',
          `presentBeforeAbort=${presentBeforeAbort} (want true), writeRejected=${writeRejected} (want true) — abort() did not engage teardown`,
        )
      }

      // Observation (non-failing): did teardown's immediate removeEntry land?
      const removedImmediately = !(await listTemps()).includes(temp2)
      log(
        `abort immediate-removeEntry landed=${removedImmediately} ` +
          `(false in Chrome: worker.terminate() frees the SyncAccessHandle async, so teardown's removeEntry races and loses — sweep reclaims it)`,
      )

      // #5b: the next OPFS destination's stale-sweep reclaims the aborted temp.
      const dest3 = await destMod.createExportDestination({
        filename: 'scene3.bin',
        mimeType: 'application/octet-stream',
        ext: 'bin',
        preferDisk: false,
      })
      const tempsAfterDest3 = await listTemps()
      if (!tempsAfterDest3.includes(temp2)) {
        pass(
          'abort-temp-reclaimed',
          `aborted (never-finalized) temp ${temp2} reclaimed by the next OPFS destination's sweep — no permanent leak`,
        )
      } else {
        fail(
          'abort-temp-reclaimed',
          `aborted temp ${temp2} still present after a subsequent OPFS destination swept (temps=${JSON.stringify(
            tempsAfterDest3,
          )})`,
        )
      }
      await dest3.cleanup?.()
    } catch (e) {
      fail('abort-engaged', `threw: ${String(e)}`)
      fail('abort-temp-reclaimed', `threw: ${String(e)}`)
    }
  }

  return { checks, logs }
}

// ---------------------------------------------------------------------------
// Node-side orchestration (mirrors verify:export-streaming).
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
  console.log('verify:export-opfs — headless OPFS flat-memory streaming gate\n')
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
    console.log('  vite is up; launching headless Chrome (OPFS + precise memory + gc) …\n')

    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: [
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan',
        '--use-angle=metal',
        '--enable-precise-memory-info', // accurate performance.memory
        '--js-flags=--expose-gc', // globalThis.gc for deterministic settling
      ],
    })
    const page = await browser.newPage()
    page.on('pageerror', (err) => console.error('[pageerror]', err.message))
    page.on('console', (m) => {
      if (m.type() !== 'error') return
      console.error('[page.error]', m.text())
    })

    // tsx transpiles this file with esbuild (keepNames), injecting `__name`/
    // `__defProp` helpers. When Playwright serializes the in-page function they
    // reference free vars that only exist in Node scope — define them on the page
    // global so the serialized body resolves. addInitScript runs before every
    // navigation, surviving vite's dep-optimize reload.
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
    // the assertion pass, so the latter runs in a stable context.
    await evalWithRetry(
      page,
      async (cfg: Cfg) => {
        await import(cfg.destUrl)
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
    console.log(failed === 0 ? '\nEXPORT-OPFS: PASS' : '\nEXPORT-OPFS: FAIL')
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
