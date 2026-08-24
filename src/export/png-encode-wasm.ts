/**
 * WASM PNG encoder — thin wrapper around `@jsquash/oxipng`'s single-threaded
 * codec (Squoosh's oxipng port), used as a re-optimizing PNG encoder.
 *
 * WHY THIS EXISTS: our pure-JS `encodePng` (see `png-encode.ts`) is deterministic
 * but slow — the adaptive per-scanline filtering loop dominates, costing ~1.5–9 s
 * per 4K frame. `@jsquash/png` (the previous encoder here) ran ~20-30x faster but
 * produced files ~3x larger — rejected on size. `optimise_raw` from oxipng's
 * SINGLE-THREADED codec at level 0 (`OXIPNG_LEVEL`, see below) recovers the old
 * fflate size while still running in WASM: benchmarked on a real 4K frame at
 * 1.35 MB / 762 ms vs old fflate's 1.29 MB / 3972 ms — ~5× faster, ≈ same size,
 * and BYTE-DETERMINISTIC (no RNG, no threading nondeterminism). Level 0 is the
 * fastest oxipng level; L1/L2 are 4-9× slower for ≤10% smaller output — not
 * worth it here. `interlace=false` and `optimize_alpha=false` keep straight
 * alpha exact (no alpha-channel "cleanup" that would alter transparent-but-
 * coloured pixels) and avoid interlacing, which only bloats size.
 *
 * We deliberately use the ST codec directly (`codec/pkg/`), NOT the
 * `@jsquash/oxipng/optimise` wrapper — that wrapper auto-selects the
 * MULTI-THREADED codec when running inside a Worker with hardwareConcurrency>1,
 * which needs app-wide COOP/COEP + `initThreadPool`. Our worker pool
 * (`png-encode-pool.ts`) IS the parallelism; each worker runs its own ST
 * instance, so no cross-worker threading setup is needed.
 *
 * This module is the SINGLE entry point to `@jsquash/oxipng` for the app — it
 * owns the `codec/pkg/squoosh_oxipng.js` import and the WASM-URL wiring, keeping
 * the sink clean and giving the worker pool one place to reuse (see
 * `compilePngWasmModule` below).
 *
 * VITE WASM LOADING: the codec's default `init()` resolves its `.wasm` via
 * `new URL('squoosh_oxipng_bg.wasm', import.meta.url)` relative to the codec
 * glue. That path is fragile under Vite's bundling, so we take the documented
 * robust route: import the `.wasm` as a hashed asset URL (`?url`) — Vite emits
 * the file and rewrites this to the correct served/built path — and hand it to
 * `init(url)`. Works identically in dev and in a production build.
 *
 * FALLBACK: `initPngWasm()` never throws — it resolves `false` if the WASM can't
 * be compiled (blocked by CSP, fetch failure, unsupported host). Callers fall
 * back to the pure-JS `encodePng` (fflate) — the true last-resort fallback when
 * WASM is unavailable at all. The init result is memoised so repeated exports
 * compile the module once.
 */

import initOxi, { optimise_raw } from '@jsquash/oxipng/codec/pkg/squoosh_oxipng.js'
import wasmUrl from '@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm?url'

/**
 * oxipng optimization level for ALL PNG export encoding (serial + pooled).
 * L0: byte-deterministic, ≈ old fflate size, fastest oxipng level. Bench: real
 * 4K frame 1.35MB/762ms vs old fflate 1.29MB/3972ms. Keep serial + worker in
 * lockstep on this value so their output stays byte-identical.
 */
export const OXIPNG_LEVEL = 0

// Memoised init: the first caller kicks off compilation; everyone else awaits the
// same promise. Resolves true on success, false on any failure (never rejects).
let initPromise: Promise<boolean> | null = null

/**
 * Initialise the `@jsquash/oxipng` WASM module once. Idempotent and memoised.
 * @returns true if WASM is ready to encode, false if it could not be loaded
 *          (caller must fall back to the pure-JS encoder).
 */
export function initPngWasm(): Promise<boolean> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    try {
      await initOxi(wasmUrl)
      return true
    } catch (err) {
      console.warn('[export] png-wasm: @jsquash/oxipng init failed, falling back to fflate encoder:', err)
      return false
    }
  })()
  return initPromise
}

// Memoised compiled module for sharing across a worker pool. Compiled ONCE on the
// main thread and structured-cloned into each worker via postMessage — every
// worker then runs its own oxipng instance off the same compiled bytecode.
let modulePromise: Promise<WebAssembly.Module | null> | null = null

/**
 * Compile the `@jsquash/oxipng` WASM once, into a `WebAssembly.Module` that can
 * be shared (structured-cloned) with worker threads. Memoised; never rejects —
 * resolves null on any failure so callers fall back to the serial path.
 *
 * A compiled Module is transferable across `postMessage` by structured clone, so
 * a pool of workers can each `init(module)` off ONE compilation. This is separate
 * from `initPngWasm()`, which initialises the main-thread serial encoder in place.
 * The worker's `init` expects the SAME codec (`codec/pkg/squoosh_oxipng`), so this
 * compiled module is valid input to it.
 */
export function compilePngWasmModule(): Promise<WebAssembly.Module | null> {
  if (modulePromise) return modulePromise
  modulePromise = (async () => {
    try {
      // Prefer streaming compile; some hosts serve .wasm with a non-wasm MIME
      // type, which rejects compileStreaming — fall back to buffer compile.
      try {
        return await WebAssembly.compileStreaming(fetch(wasmUrl))
      } catch {
        const bytes = await (await fetch(wasmUrl)).arrayBuffer()
        return await WebAssembly.compile(bytes)
      }
    } catch (err) {
      console.warn('[export] png-wasm: compile of shared module failed, no worker pool:', err)
      return null
    }
  })()
  return modulePromise
}

/**
 * Encode straight-alpha RGBA pixels into a complete PNG file via WASM.
 *
 * @param rgba   Row-major, top-down RGBA bytes, length `width * height * 4`.
 *               Straight (non-premultiplied) alpha — preserved exactly (type 6).
 * @param width  Image width in pixels (>= 1).
 * @param height Image height in pixels (>= 1).
 * @returns A complete PNG file as a Uint8Array.
 * @throws if the WASM module is unavailable — call `initPngWasm()` first and only
 *         use this path when it resolved true.
 */
export async function encodePngWasm(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const expected = width * height * 4
  if (rgba.length !== expected) {
    throw new Error(`[png-wasm] rgba length ${rgba.length} != width*height*4 (${expected})`)
  }
  // `optimise_raw` reads the pixel view directly, so the backing buffer must be
  // EXACTLY the pixel bytes — a larger buffer or a non-zero byteOffset (e.g. a
  // subarray view) would feed stray bytes. getImageData() already returns an
  // exact-sized ClampedArray; copy defensively only when the view isn't tight.
  const tight =
    rgba instanceof Uint8ClampedArray && rgba.byteOffset === 0 && rgba.byteLength === rgba.buffer.byteLength
  const clamped = tight ? (rgba as Uint8ClampedArray) : new Uint8ClampedArray(rgba)
  return optimise_raw(clamped, width, height, OXIPNG_LEVEL, false, false)
}
