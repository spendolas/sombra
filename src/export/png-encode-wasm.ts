/**
 * WASM PNG encoder — thin wrapper around `@jsquash/png` (Squoosh's PNG codec).
 *
 * WHY THIS EXISTS: our pure-JS `encodePng` (see `png-encode.ts`) is deterministic
 * but slow — the adaptive per-scanline filtering loop dominates, costing ~1.5–9 s
 * per 4K frame. `@jsquash/png` runs the WHOLE encode (filtering + deflate) in
 * WebAssembly: benchmarked ~20–30× faster (445 ms vs 9130 ms on a 4K noise frame)
 * AND deterministic (byte-identical across browsers). It has no tuning params
 * beyond `bitDepth` (we always use 8-bit RGBA, colour type 6 — straight alpha
 * round-trips losslessly). Its `fdeflate` profile trades a little size for speed
 * on very compressible content; that is accepted.
 *
 * This module is the SINGLE entry point to `@jsquash` for the app — it owns the
 * `@jsquash/png/encode` import and the WASM-URL wiring, keeping the sink clean and
 * giving a future worker pool one place to reuse.
 *
 * VITE WASM LOADING: `@jsquash`'s default `init()` resolves its `.wasm` via
 * `new URL('squoosh_png_bg.wasm', import.meta.url)` relative to the codec glue.
 * That path is fragile under Vite's bundling, so we take the documented robust
 * route: import the `.wasm` as a hashed asset URL (`?url`) — Vite emits the file
 * and rewrites this to the correct served/built path — and hand it to `init(url)`.
 * Works identically in dev and in a production build.
 *
 * FALLBACK: `initPngWasm()` never throws — it resolves `false` if the WASM can't
 * be compiled (blocked by CSP, fetch failure, unsupported host). Callers fall
 * back to the pure-JS `encodePng`. The init result is memoised so repeated
 * exports compile the module once.
 */

import encode, { init as jsquashInit } from '@jsquash/png/encode'
import wasmUrl from '@jsquash/png/codec/pkg/squoosh_png_bg.wasm?url'

// Memoised init: the first caller kicks off compilation; everyone else awaits the
// same promise. Resolves true on success, false on any failure (never rejects).
let initPromise: Promise<boolean> | null = null

/**
 * Initialise the `@jsquash` WASM module once. Idempotent and memoised.
 * @returns true if WASM is ready to encode, false if it could not be loaded
 *          (caller must fall back to the pure-JS encoder).
 */
export function initPngWasm(): Promise<boolean> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    try {
      await jsquashInit(wasmUrl)
      return true
    } catch (err) {
      console.warn('[export] png-wasm: @jsquash init failed, falling back to fflate encoder:', err)
      return false
    }
  })()
  return initPromise
}

// Memoised compiled module for sharing across a worker pool. Compiled ONCE on the
// main thread and structured-cloned into each worker via postMessage — every
// worker then runs its own @jsquash instance off the same compiled bytecode.
let modulePromise: Promise<WebAssembly.Module | null> | null = null

/**
 * Compile the `@jsquash` PNG WASM once, into a `WebAssembly.Module` that can be
 * shared (structured-cloned) with worker threads. Memoised; never rejects —
 * resolves null on any failure so callers fall back to the serial path.
 *
 * A compiled Module is transferable across `postMessage` by structured clone, so
 * a pool of workers can each `init(module)` off ONE compilation. This is separate
 * from `initPngWasm()`, which initialises the main-thread serial encoder in place.
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
  // `@jsquash`'s encode reads `imageData.data.buffer`, so the backing buffer must
  // be EXACTLY the pixel bytes — a larger buffer or a non-zero byteOffset (e.g. a
  // subarray view) would feed stray bytes. getImageData() already returns an
  // exact-sized ClampedArray; copy defensively only when the view isn't tight.
  const tight =
    rgba instanceof Uint8ClampedArray && rgba.byteOffset === 0 && rgba.byteLength === rgba.buffer.byteLength
  const clamped = tight ? (rgba as Uint8ClampedArray) : new Uint8ClampedArray(rgba)
  const image = new ImageData(clamped, width, height)
  const buf = await encode(image)
  return new Uint8Array(buf)
}
