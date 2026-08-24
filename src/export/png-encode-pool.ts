/**
 * PNG encode worker POOL — parallel encoding with ordered reassembly and bounded
 * backpressure.
 *
 * WHY THIS EXISTS: `encodePngWasm` (see `png-encode-wasm.ts`) is fast per frame
 * but main-thread and serial, so a long PNG-sequence export encodes one frame at
 * a time. This pool fans frames out across `poolSize` workers
 * (`png-encode.worker.ts`), each running its own oxipng (single-threaded)
 * encoder off ONE shared compiled `WebAssembly.Module` (compiled once via
 * `compilePngWasmModule()` and structured-cloned into every worker). Three
 * properties matter:
 *
 *   1. PARALLEL   — N workers encode N frames concurrently.
 *   2. ORDERED    — workers finish out of order (frame 3 may beat frame 1), but
 *                   `onEncoded(index, png)` is invoked in STRICT ascending index.
 *                   A completed-buffer + an `nextEmit` cursor reassembles the
 *                   stream; the flush runs on a single async chain so `onEncoded`
 *                   calls never overlap or reorder.
 *   3. BOUNDED    — `submit()` applies backpressure so the caller (engine loop)
 *                   cannot outrun the workers and pile encoded frames in RAM. The
 *                   number of outstanding frames (in flight + completed-but-not-
 *                   yet-emitted) is capped at `window = poolSize + 2`.
 *
 * DETERMINISM: workers use the exact same oxipng (single-threaded) encoder as
 * the serial `encodePngWasm`, so per-frame bytes are identical; the `nextEmit`
 * flush enforces identical delivery order. Same frames in → same bytes to
 * `onEncoded`, same order as a serial loop.
 *
 * FALLBACK: `createPngEncodePool` resolves null (never throws) if the shared WASM
 * module can't be compiled or any worker fails to init — the caller then uses the
 * serial `encodePngWasm` path.
 *
 * Editor-side export code — NOT shipped in the embed player.
 */

import { compilePngWasmModule } from './png-encode-wasm'
import type { PngWorkerReq, PngWorkerRes } from './png-encode.worker'

export interface PngEncodePool {
  /**
   * Dispatch frame `index` for encoding. Resolves once the frame is ACCEPTED
   * (after any backpressure wait) — NOT when it finishes encoding. The encoded
   * PNG is delivered later to `onEncoded(index, png)` in strict index order.
   * Indices must be contiguous ascending from 0.
   */
  submit(index: number, rgba: Uint8ClampedArray, width: number, height: number): Promise<void>
  /** Resolve once every submitted frame has been delivered to `onEncoded` in order. */
  drain(): Promise<void>
  /** Terminate all workers immediately and reject anything pending. Idempotent. */
  dispose(): void
}

export async function createPngEncodePool(opts: {
  poolSize: number
  /** Called in STRICT ascending index order, one at a time (never overlapping). */
  onEncoded: (index: number, png: Uint8Array) => void | Promise<void>
}): Promise<PngEncodePool | null> {
  const { poolSize, onEncoded } = opts
  if (poolSize < 1) return null

  // One compilation shared by every worker; null → WASM unavailable → fallback.
  const wasmModule = await compilePngWasmModule()
  if (!wasmModule) return null

  // Outstanding-frame window. Bounds (in-flight + completed-buffered) frames so a
  // fast producer with one slow frame can't grow the completed buffer without
  // limit. See the backpressure note in `submit` below.
  const encodeWindow = poolSize + 2

  // --- State ---------------------------------------------------------------
  const workers: Worker[] = []
  const free: Worker[] = [] // workers idle and ready for the next encode
  const completed = new Map<number, Uint8Array>() // finished, awaiting in-order flush
  let nextEmit = 0 // lowest index not yet delivered to onEncoded
  let submittedCount = 0 // total frames submitted (indices are 0..submittedCount-1)
  let disposed = false
  let failure: Error | null = null

  // Backpressure waiters: a submit blocked on a slot pushes a resolver here; it is
  // woken when a worker frees OR when nextEmit advances (window opens).
  const slotWaiters: Array<() => void> = []
  // Drain waiters: resolved when nextEmit === submittedCount, rejected on failure.
  const drainWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = []
  // Single async chain that serialises the in-order flush so onEncoded never
  // overlaps or reorders across concurrent worker completions.
  let flushChain: Promise<void> = Promise.resolve()

  const wakeSlotWaiters = (): void => {
    const ws = slotWaiters.splice(0)
    for (const w of ws) w()
  }

  const rejectDrains = (err: Error): void => {
    const ws = drainWaiters.splice(0)
    for (const w of ws) w.reject(err)
  }

  const resolveDrainsIfDone = (): void => {
    if (failure) {
      rejectDrains(failure)
      return
    }
    if (nextEmit === submittedCount) {
      const ws = drainWaiters.splice(0)
      for (const w of ws) w.resolve()
    }
  }

  const fail = (err: unknown): void => {
    if (failure) return
    failure = err instanceof Error ? err : new Error(String(err))
    rejectDrains(failure)
    wakeSlotWaiters() // blocked submits re-check and throw
    dispose()
  }

  const dispose = (): void => {
    if (disposed) return
    // `failure` must be set FIRST, before `disposed`/terminate: a flush microtask
    // queued before an external dispose() can still be pending on the
    // `flushChain`, and `runFlush`'s loop guard is `while (!failure && …)` — it
    // has no other way to know dispose happened. Setting `failure` here makes an
    // already-queued `runFlush` see it truthy and deliver nothing more. The `??`
    // guard means a real error from `fail()` (which sets `failure` before calling
    // `dispose()`) is never overwritten — only the direct-external-dispose path
    // (no prior failure) is affected.
    failure = failure ?? new Error('[png-pool] disposed')
    disposed = true
    for (const w of workers) w.terminate()
    wakeSlotWaiters()
    rejectDrains(failure)
  }

  // Deliver every ready frame at the emit cursor, in order, one at a time.
  const runFlush = async (): Promise<void> => {
    while (!failure && completed.has(nextEmit)) {
      const png = completed.get(nextEmit)!
      completed.delete(nextEmit)
      try {
        await onEncoded(nextEmit, png)
      } catch (err) {
        fail(err)
        return
      }
      nextEmit++
      wakeSlotWaiters() // window advanced — a backpressured submit may proceed
      resolveDrainsIfDone()
    }
    resolveDrainsIfDone()
  }
  const scheduleFlush = (): void => {
    flushChain = flushChain.then(runFlush)
  }

  const handleDone = (worker: Worker, id: number, png: ArrayBuffer): void => {
    free.push(worker)
    completed.set(id, new Uint8Array(png)) // view over the transferred buffer (no copy)
    wakeSlotWaiters()
    scheduleFlush()
  }

  // --- Spawn + init all workers -------------------------------------------
  const initResults: Promise<boolean>[] = []
  for (let i = 0; i < poolSize; i++) {
    let worker: Worker
    try {
      worker = new Worker(new URL('./png-encode.worker.ts', import.meta.url), { type: 'module' })
    } catch {
      break // spawn failed — treated as unavailable below
    }
    workers.push(worker)

    let resolveInit!: (ok: boolean) => void
    initResults.push(new Promise<boolean>((res) => (resolveInit = res)))
    let inited = false

    worker.onmessage = (ev: MessageEvent<PngWorkerRes>): void => {
      const msg = ev.data
      if (!inited) {
        if (msg.type === 'inited') {
          inited = true
          resolveInit(true)
        } else if (msg.type === 'error') {
          resolveInit(false)
        }
        return
      }
      if (msg.type === 'done') handleDone(worker, msg.id, msg.png)
      else if (msg.type === 'error') fail(new Error(msg.error))
    }
    worker.onerror = (): void => {
      if (!inited) resolveInit(false)
      else fail(new Error('[png-pool] worker crashed'))
    }

    const initReq: PngWorkerReq = { type: 'init', module: wasmModule }
    worker.postMessage(initReq)
  }

  // If we couldn't even spawn the full pool, bail to fallback.
  if (workers.length < poolSize) {
    for (const w of workers) w.terminate()
    return null
  }

  const inited = await Promise.all(initResults)
  if (disposed || inited.some((ok) => !ok)) {
    for (const w of workers) w.terminate()
    return null
  }

  // All workers ready.
  free.push(...workers)

  const dispatch = (worker: Worker, index: number, rgba: Uint8ClampedArray, width: number, height: number): void => {
    const req: PngWorkerReq = { type: 'encode', id: index, rgba: rgba.buffer, width, height }
    worker.postMessage(req, [rgba.buffer]) // zero-copy transfer of the pixel buffer
  }

  return {
    async submit(index: number, rgba: Uint8ClampedArray, width: number, height: number): Promise<void> {
      if (failure) throw failure
      if (disposed) throw new Error('[png-pool] submit after dispose')
      submittedCount = Math.max(submittedCount, index + 1)

      // Ensure the pixel view is tight before it gets transferred — a larger
      // backing buffer or a non-zero byteOffset (e.g. a subarray view) would ship
      // stray bytes into the worker. Mirrors `encodePngWasm`'s `tight` check.
      const tight = rgba.byteOffset === 0 && rgba.byteLength === rgba.buffer.byteLength
      const pixels = tight ? rgba : new Uint8ClampedArray(rgba)

      // BACKPRESSURE: accept the frame only when a worker is free AND we are not
      // too far ahead of the emit cursor. The window gate (`index - nextEmit >=
      // window`) is an OR-level condition — it must block even when a worker is
      // free, otherwise a single slow low-index frame lets fast high-index frames
      // pile up unboundedly in `completed`. This throttles the engine loop so RAM
      // stays capped at ~window outstanding frames. (`free.length === 0` is
      // equivalent to `inFlight >= poolSize`.)
      for (;;) {
        if (failure) throw failure
        if (disposed) throw new Error('[png-pool] submit after dispose')
        const windowFull = index - nextEmit >= encodeWindow
        if (!windowFull && free.length > 0) {
          dispatch(free.pop()!, index, pixels, width, height)
          return
        }
        await new Promise<void>((res) => slotWaiters.push(res))
      }
    },

    drain(): Promise<void> {
      if (failure) return Promise.reject(failure)
      return new Promise<void>((resolve, reject) => {
        drainWaiters.push({ resolve, reject })
        resolveDrainsIfDone() // handle the already-drained case
      })
    },

    dispose,
  }
}
