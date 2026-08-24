# Multi-Worker PNG Export Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Parallelize PNG-sequence export encoding across a Web Worker pool so large exports are much faster, using the WASM `@jsquash` encoder (deterministic). Keep output byte-identical to the serial path and correctly ordered.

**Architecture:** The export engine already does a GPU `readback()` per frame → a fresh straight-alpha RGBA `Uint8ClampedArray`. Today it wraps that in a VideoFrame and the PNG sink re-extracts RGBA via canvas `getImageData` then encodes serially on the main thread. Instead: hand the readback RGBA straight to a **worker pool** (transfer the buffer, zero-copy), each worker owning a `@jsquash` WASM instance initialized from ONE shared compiled `WebAssembly.Module`. Workers encode in parallel; a collector writes the resulting PNGs into the streaming fflate `Zip` in **strict frame-index order**, with a **bounded in-flight window** so RAM stays capped and render can't outrun the pool. This overlaps GPU render (serial, one device) with CPU encode (parallel), and skips the canvas/getImageData/VideoFrame roundtrip for PNG.

**Tech Stack:** Web Workers (Vite `new Worker(new URL(...), {type:'module'})`), `@jsquash/png` (WASM, shared `WebAssembly.Module`), fflate streaming Zip, TS strict.

**Spec:** this conversation. Determinism (byte-identical to serial), order, bounded memory, speedup, fallback.

## Global Constraints
- TS strict; `npm run lint` + `tsc -b` clean; existing gates green (verify:png-wasm 7/7, verify:png-encode 9/9, verify:export-streaming 6/6, verify:export-abort 7/7, verify:video-export 8/8).
- **Output must be byte-identical to the current serial path** (same @jsquash encoder, same zip). The gate proves it.
- **Ordering:** frames written to the zip in strictly increasing index (workers finish out of order → reassemble).
- **Bounded RAM:** never more than `window` frames' RGBA + encoded PNGs in flight (`window ≈ poolSize + small`). Backpressure the engine loop.
- **Fallback:** if Workers or `@jsquash` WASM are unavailable, fall back to the current serial in-sink encode (with fflate fallback under that). Never fail the export.
- **PNG only.** Video sinks (single stateful WebCodecs encoder) are unchanged.
- Editor-side only; the worker must NOT be pulled into the embed player bundle (verify:embed:bundle stays green).
- Concurrency cap: `Math.min(navigator.hardwareConcurrency ?? 4, CAP)` minus 1 for the main thread; CAP ≈ 6–8. Each 4K encode is ~70–100 MB transient — size the pool + window against that.

## Task 1: PNG encode worker + shared-module compile

**Files:**
- Create: `src/export/png-encode.worker.ts`
- Modify: `src/export/png-encode-wasm.ts` (add a `compilePngWasmModule(): Promise<WebAssembly.Module | null>` that compiles the wasm ONCE for sharing; keep the existing main-thread `initPngWasm`/`encodePngWasm` for the serial fallback).

**Interfaces (Produces):**
```ts
// png-encode-wasm.ts
export function compilePngWasmModule(): Promise<WebAssembly.Module | null> // compiles wasmUrl once; null on failure
// worker protocol
type WReq = { type:'init'; module: WebAssembly.Module } | { type:'encode'; id:number; rgba:ArrayBuffer; width:number; height:number } | { type:'close' }
type WRes = { type:'inited' } | { type:'done'; id:number; png:ArrayBuffer } | { type:'error'; id?:number; error:string }
```
- [ ] Worker: on `init`, call `@jsquash` `init(module)` with the shared compiled `WebAssembly.Module` (wasm-bindgen `init` accepts a Module) → post `inited`. On `encode`, reconstruct `new ImageData(new Uint8ClampedArray(rgba), w, h)`, `await encode(image)` → post `{done, id, png}` transferring the png buffer. Wrap in try/catch → `{error, id}`.
- [ ] `compilePngWasmModule()`: `WebAssembly.compileStreaming(fetch(wasmUrl))` (or compile from the `?url` asset), memoised, returns null on failure (caller falls back to serial). This lets all workers share one compiled module (structured-clone the Module in `postMessage`).
- [ ] Exercised by the Task 4 gate (needs a browser). Commit with Task 2 if it doesn't stand alone.

## Task 2: worker pool with ordered reassembly + bounded backpressure

**Files:** Create `src/export/png-encode-pool.ts`

**Interfaces (Produces):**
```ts
export interface PngEncodePool {
  /** Dispatch a frame for encoding. Resolves when accepted (after backpressure);
   *  the encoded PNG is delivered to `onEncoded(index, png)` IN ORDER, not here. */
  submit(index: number, rgba: Uint8ClampedArray, width: number, height: number): Promise<void>
  /** Await all in-flight encodes; onEncoded has been called for every submitted frame in order. */
  drain(): Promise<void>
  /** Terminate all workers (abort). */
  dispose(): void
}
export async function createPngEncodePool(opts: {
  poolSize: number
  onEncoded: (index: number, png: Uint8Array) => void | Promise<void>   // called in strict index order
}): Promise<PngEncodePool | null>   // null if workers/WASM unavailable → caller uses serial path
```
- [ ] Spawn `poolSize` workers (`new Worker(new URL('./png-encode.worker.ts', import.meta.url), {type:'module'})`); `compilePngWasmModule()` once, `postMessage({type:'init', module})` to each; if compile or any init fails → dispose + return null (fallback).
- [ ] `submit`: assign the frame to a free worker; if none free AND the in-flight window is full (`inFlight >= poolSize` or `index - nextEmit >= window`), await until a slot frees (backpressure — this throttles the engine loop). Transfer `rgba.buffer` to the worker (zero-copy).
- [ ] On a worker `done`: stash `(id, png)`; then drain the ready-in-order buffer — while `completed.has(nextEmit)`, `await onEncoded(nextEmit, png)`, delete, `nextEmit++`. This guarantees `onEncoded` is called in strict order even though workers finish out of order. Free the worker for the next submit.
- [ ] `drain`: resolve once `nextEmit === submittedCount` (all delivered in order).
- [ ] `dispose`: terminate all workers; reject pending.
- [ ] Deterministic: same input frames → `onEncoded` called with identical bytes in identical order as a serial `encodePngWasm` loop (same encoder). Commit (Tasks 1+2 together).

## Task 2.5 (encoder swap): @jsquash/png → @jsquash/oxipng (single-threaded)

Benchmark decided it (REAL lnv4 4K frame, honest numbers): old fflate L6 = 1.29 MB @ 3972 ms (deterministic, "VERY slow"); `@jsquash/png` = 3.98 MB @ 98 ms (= **3.08× larger** than old — this IS the user's "3× larger", confirmed); **oxipng L0 = 1.35 MB @ 762 ms (byte-deterministic ✓, +5% size, 5.2× faster than old fflate)**; oxipng L1 = 1.22 MB @ 2822 ms; native browser = 3.36 MB @ 1185 ms (non-deterministic). Swap the pool's encoder to **oxipng L0, single-threaded** (use oxipng's ST path inside our own workers — do NOT use oxipng's own MT/threadpool, which needs app-wide COOP/COEP; our pool is the parallelism). oxipng L0 gives back the old small size at 5× the speed; in a 4-worker pool → ~190 ms effective/frame, faster than native AND at old deterministic size. Keep fflate as the last-resort fallback.
- Worker (`png-encode.worker.ts`): encode via oxipng ST — import the single-threaded codec (`@jsquash/oxipng/codec/pkg/squoosh_oxipng.js` `optimise_raw(rgba,w,h,level,interlace,optimiseAlpha)`), NOT the auto-MT `@jsquash/oxipng/optimise` wrapper. `level` default **0** (tunable const; L0 is byte-deterministic, ≈old size, fastest), `interlace:false`, `optimiseAlpha:false` (exact straight-alpha determinism).
- Shared module: `compilePngWasmModule` → compile the oxipng ST wasm (`squoosh_oxipng_bg.wasm?url`) for sharing across workers.
- Serial fallback path (`png-encode-wasm.ts` main-thread): also switch to oxipng ST L0 (so serial and pooled produce byte-identical files); keep the pure-JS fflate `encodePng` as the final fallback when WASM is unavailable.
- ALSO fold in the Tasks 1+2 review fixes (same encoder/pool cluster, un-wired downstream): (a) **Important** — `dispose()` must set `failure` before teardown so an already-queued flush microtask can't deliver a stray `onEncoded` after dispose (`png-encode-pool.ts` `dispose()`: `failure = failure ?? new Error('[png-pool] disposed')` first); (b) Minor — add the same `tight` offset/length guard on `rgba` in `submit()`/`dispatch()` that `encodePngWasm` has.
- Dep: `@jsquash/oxipng@2.3.0` (pinned). The old `@jsquash/png` may be removed once nothing references it (or kept if the fallback still uses it — prefer removing to shrink deps if unused).

## Task 3: wire the engine + PNG sink to the pool (with fallback)

**Files:**
- Modify: `src/export/frame-sink.ts` (add optional `addFrameRaw?(rgba, width, height, index, timestampUs): Promise<void>` and keep `addFrame`),
- Modify: `src/export/export-engine.ts` (prefer `addFrameRaw` with the readback RGBA when the sink implements it; else current toVideoFrame+addFrame),
- Modify: `src/export/sinks/png-sequence.ts` (use the pool in `addFrameRaw`; the pool's `onEncoded(index,png)` pushes into the streaming Zip via `ZipPassThrough` in order; fallback: if `createPngEncodePool` returns null, `addFrameRaw` encodes inline (WASM or fflate) — same as today's `addFrame`).

- [ ] Engine: `const rgba = await target.readback()` already happens. If `sink.addFrameRaw`, call it with `rgba` (a fresh copy — safe to transfer) + `i`; skip `toVideoFrame`/`vf.close()`. Else keep the VideoFrame path. Preserve the finalize phase + abort.
   - Confirm `readback()` returns a FRESH array each call (it does — `new Uint8ClampedArray`), so transferring its buffer to a worker can't corrupt a reused buffer. If it were reused, copy before transfer.
- [ ] PNG sink `begin`: create the pool (`createPngEncodePool({poolSize, onEncoded})`); `onEncoded(i,png)` adds a `ZipPassThrough(frame_i.png)` + `push(png,true)` into the existing streaming `Zip` (reuse the current queue/backpressure to the writable). If pool is null → set a serial flag.
- [ ] `addFrameRaw(rgba,w,h,i)`: pool ? `await pool.submit(i,rgba,w,h)` : (inline encode as today, in order). 
- [ ] `finish()`: `await pool?.drain()` (all frames encoded + written in order), then `zip.end()`, await queue, close writable — as today.
- [ ] `abort()`: `pool?.dispose()` + existing teardown.
- [ ] Determinism: the zip entries (names + bytes) must be identical to the serial path. Order guaranteed by the pool's in-order `onEncoded`.

## Task 4: mechanism-engaged gate + verify

**Files:** Create `scripts/verify-png-multiworker.ts` (`verify:png-multiworker`)
- [ ] Browser harness (playwright + vite, like verify-png-wasm). Encode N (e.g. 24) known distinct frames through BOTH the serial path and the pool path; assert:
  - **Byte-identical:** the produced zip (or per-frame PNGs) from the pool == the serial path, frame-for-frame (proves determinism + correct ordering — a reordering bug makes frame bytes land at the wrong index → mismatch).
  - **Order under out-of-order completion:** inject artificial per-worker delay variance (or rely on natural variance) so workers finish out of order, and confirm `onEncoded`/zip order is still strict — the byte-identity check above catches this.
  - **Bounded window (mechanism-engaged):** instrument peak in-flight count; assert it never exceeds the window (proves backpressure works — without it, submitting N frames faster than they encode would blow past the window). Prove-it-fails: raise the window / remove backpressure and show peak exceeds.
  - **Speedup:** assert wall-clock with poolSize>1 is meaningfully less than serial for the same N (or at least that encodes overlapped — e.g. total wall-clock < sum of individual encode times). Not a flaky micro-bench; use a comfortable margin.
  - **Fallback:** simulate workers/WASM unavailable → `createPngEncodePool` returns null → sink still produces a valid zip via the serial path.
  - Fail-loud if the environment can't run it.
- [ ] Register; run; prove-it-fails demonstrated; commit.

## Task 5: full verify + embed boundary + live
- [ ] `lint`, `tsc -b`, `npm run build` (worker + wasm bundling), `verify:embed:bundle` (worker/@jsquash NOT in player), verify:png-multiworker, verify:png-wasm, verify:png-encode, verify:export-streaming, verify:export-abort, verify:video-export.
- [ ] Live (worktree server): export a PNG sequence, confirm it's faster (report a real timing vs serial), the zip opens, frames in order.

## Self-review
- Ordering is the top risk — the byte-identical-vs-serial gate is the guard.
- Transfer safety: readback returns fresh buffers; confirm before transferring.
- Bounded window prevents the RAM blowup that the whole streaming effort fixed — the gate asserts it.
- Fallback keeps single-core / WASM-blocked / worker-blocked environments working.
- Video path untouched; embed boundary preserved.
