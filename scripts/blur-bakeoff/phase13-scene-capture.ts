/**
 * Phase 13 — capture the USER'S REAL SCENE (`shaders/face dr.sombra`) at NATIVE
 * device resolution and classify the ragged rib edges in it.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every screenshot path available to an agent resamples the canvas, and the
 * evidence we need is single-pixel. Two separate resampling steps stack up:
 *
 *   1. The scene is TIME-LIVE (a Time node feeds the noise + warp phases), so the
 *      renderer runs at `ANIMATED_DPR_SCALE = 0.75` — the canvas BACKING STORE is
 *      0.75x the device-pixel size of its own CSS box, and the compositor upscales
 *      it to the display. (src/webgpu/renderer.ts:500, :844 — `dpr =
 *      min(devicePixelRatio, 2) * currentDprScale`.)
 *   2. `elementHandle.screenshot()` captures at the context `deviceScaleFactor`,
 *      i.e. `dpr * cssW` px, while the backing store is `dpr * dprScale * cssW`.
 *      The ratio is exactly `dprScale`, INDEPENDENT of deviceScaleFactor — so
 *      whenever `dprScale < 1` an element screenshot CANNOT be made to equal
 *      `canvas.width x canvas.height`. There is no flag that fixes it.
 *
 * So this harness does not screenshot the canvas at all for its measurements. It
 * reads the WebGPU swapchain texture back byte-for-byte:
 *
 *   - `GPUCanvasContext.prototype.configure` is patched (page-side, via
 *     addInitScript — `src/` is NOT modified) to OR in `COPY_SRC` usage.
 *   - `getCurrentTexture` is patched to remember the frame's canvas texture.
 *   - `GPUQueue.prototype.submit` is patched so that, on an armed frame, a
 *     `copyTextureToBuffer` is submitted from inside the SAME rAF callback the app
 *     rendered in — before the texture expires at the update-the-rendering step.
 *
 * That yields exact backing-store pixels at any `dprScale`, with zero resampling
 * and no canvas colour management in the path. `elementHandle.screenshot()` is
 * still taken for every variant and its dimensions recorded, both to prove the
 * mismatch above and because in the `dprScale == 1` variants the two paths MUST
 * agree — which is the harness's own correctness check.
 *
 * VARIANTS (all from a fresh re-import of the scene, so nothing drifts)
 *   A_as_shipped   untouched — time live at speed 0.031, dprScale 0.75
 *   B_frozen       Time.speed = 0. Content frozen, u_time STILL in the shader so
 *                  `isTimeLiveAtOutput` stays true and dprScale stays 0.75.
 *                  This is the comparison baseline: every other variant differs
 *                  from it in exactly one param.
 *   C_frozen_hiq   B + fragment_output.quality = 'high' → ANIMATED_DPR_SCALE 1.0.
 *                  Same content, same code path, full device resolution.
 *                  B vs C isolates the 0.75 downscale ALONE.
 *   D_static       B + both Time edges removed → u_time unused →
 *                  isTimeLiveAtOutput false → STATIC_DPR_SCALE 1.0. Cross-checks C
 *                  via a different route (content differs: phases fall to 0).
 *   E/F/G/H        B + curvature 0.77 / 0.80 / 2.15@hiq / bow 0 / ribWidth 81
 *
 * Measurements (all in 8-bit luma code units, on native backing pixels):
 *   transition  — per row crossing the strongest seam, how many pixels land
 *                 strictly between the two plateaus (0 = hard cut, 1 = one AA px)
 *   position    — per-row seam column, its spread and its run-length structure
 *                 (flat runs of equal position = STAIRCASE)
 *   beading     — pixel-to-pixel variation of the darkest value ALONG the seam,
 *                 against the same statistic at the rib CENTRE (content control)
 * The measures are validated on four synthetic stimuli with known answers before
 * any real number is reported (`--stage=validate`).
 *
 * Read-only w.r.t. `src/`. Writes only `reports/blur-bakeoff/phase13/`.
 * Uses the ALREADY-RUNNING dev server; never starts one, never touches port 5173.
 *
 * Run:
 *   npx tsx scripts/blur-bakeoff/phase13-scene-capture.ts
 *   npx tsx scripts/blur-bakeoff/phase13-scene-capture.ts --stage=validate
 *   npx tsx scripts/blur-bakeoff/phase13-scene-capture.ts --only=B_frozen,C_frozen_hiq
 *   npx tsx scripts/blur-bakeoff/phase13-scene-capture.ts --headed
 */
import fs from 'node:fs'
import path from 'node:path'

import { chromium, type Page } from 'playwright-core'

import { encodePng } from './lib/png.ts'
import type { Rgba8 } from './lib/image.ts'

const REPO = process.cwd()
const OUT = path.join(REPO, 'reports', 'blur-bakeoff', 'phase13')
const SCENE = path.join(REPO, 'shaders', 'face dr.sombra')

/** ALREADY RUNNING — do not start another, and never touch 5173 (user's server). */
const APP_URL = 'http://localhost:49950/sombra/'

/** Context DPR. 2 is what a retina Mac reports and what the app caps to. */
const DEVICE_SCALE = 2
/** Chosen so the docked preview canvas lands near the user's measured 893x347 CSS. */
const VIEWPORT = { width: 1280, height: 800 }

/** Magnification for the nearest-neighbour crops. */
const MAG = 6
/** Rows/px of the seam-centred square crop (native px, before magnification). */
const CROP = 96
/** Along-seam strip crop, native px. */
const STRIP_W = 40
const STRIP_H = 150
/** Escalating attempts to force one render out of a non-animated plan. */
const NUDGES = 3

const arg = (k: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.slice(k.length + 3) : undefined
}
const flag = (k: string): boolean => process.argv.includes(`--${k}`)

// ---------------------------------------------------------------------------
// Page-side capture shim. Injected before app scripts; src/ untouched.
// ---------------------------------------------------------------------------

const CAPTURE_SHIM = `(() => {
  const cap = {
    armed: false, pending: null, error: null, submits: 0, skipped: 0,
    isWebGPU: false, isWebGL2: false, format: null, device: null,
    lastTex: null, freshTex: false, canvasW: 0, canvasH: 0, gpuErrors: [], deviceLost: null,
    mainFrames: 0,
  };
  window.__cap = cap;

  const b64 = (bytes) => {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(s);
  };

  if (typeof GPUCanvasContext !== 'undefined') {
    const origCfg = GPUCanvasContext.prototype.configure;
    GPUCanvasContext.prototype.configure = function (cfg) {
      cap.isWebGPU = true;
      cap.format = cfg.format;
      // Take the device FROM THE CONFIG, not from the last requestDevice(): the app
      // creates throwaway devices (WGSL validation probes) and destroys them, and
      // copyTextureToBuffer on a destroyed device fails with
      // "Device was lost before mapping was resolved". cfg.device is by definition
      // the device that owns this canvas' textures.
      this.__p13dev = cfg.device;
      const usage = (cfg.usage === undefined ? GPUTextureUsage.RENDER_ATTACHMENT : cfg.usage)
        | GPUTextureUsage.COPY_SRC;
      return origCfg.call(this, Object.assign({}, cfg, { usage: usage }));
    };

    const origGet = GPUCanvasContext.prototype.getCurrentTexture;
    GPUCanvasContext.prototype.getCurrentTexture = function () {
      const t = origGet.call(this);
      // Only the MAIN canvas: it is an HTMLCanvasElement attached to the document.
      // Preview thumbnails share the GPUDevice but not a live DOM canvas.
      const c = this.canvas;
      if (c && typeof HTMLCanvasElement !== 'undefined' && c instanceof HTMLCanvasElement && c.isConnected) {
        cap.lastTex = t; cap.canvasW = c.width; cap.canvasH = c.height;
        cap.mainFrames++;
        if (this.__p13dev) cap.device = this.__p13dev;
        // Marks the texture as belonging to the CURRENT frame. Preview thumbnails
        // share this GPUDevice and submit their own work; without this flag an
        // armed capture fired on a preview's submit and copied the PREVIOUS
        // frame's already-expired canvas texture, which reads back all zeros.
        cap.freshTex = true;
      }
      return t;
    };

    const origReqDev = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = function () {
      return origReqDev.apply(this, arguments).then((d) => {
        cap.device = d;
        try {
          d.addEventListener('uncapturederror', (ev) => {
            if (cap.gpuErrors.length < 20) cap.gpuErrors.push(String(ev.error).slice(0, 300));
          });
        } catch (e) { /* older impls */ }
        try { d.lost.then((info) => { cap.deviceLost = String(info && info.reason) + ': ' + String(info && info.message); }); }
        catch (e) { /* ignore */ }
        return d;
      });
    };

    const origSubmit = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function (bufs) {
      const r = origSubmit.call(this, bufs);
      cap.submits++;
      if (cap.armed && cap.lastTex && cap.device && !cap.freshTex) cap.skipped++;
      if (cap.armed && cap.lastTex && cap.device && cap.freshTex) {
        cap.armed = false;
        cap.freshTex = false;
        const tex = cap.lastTex;
        try {
          const w = tex.width, h = tex.height;
          const bpr = Math.ceil(w * 4 / 256) * 256;
          const dev = cap.device;
          const buf = dev.createBuffer({
            size: bpr * h,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
          const enc = dev.createCommandEncoder();
          enc.copyTextureToBuffer(
            { texture: tex },
            { buffer: buf, bytesPerRow: bpr, rowsPerImage: h },
            { width: w, height: h, depthOrArrayLayers: 1 },
          );
          // Same rAF callback as the app's own submit → the canvas texture has
          // not expired yet.
          origSubmit.call(this, [enc.finish()]);
          cap.pending = buf.mapAsync(GPUMapMode.READ).then(() => {
            const src = new Uint8Array(buf.getMappedRange()).slice();
            buf.unmap(); buf.destroy();
            const out = new Uint8Array(w * h * 4);
            for (let y = 0; y < h; y++) {
              out.set(src.subarray(y * bpr, y * bpr + w * 4), y * w * 4);
            }
            return { w: w, h: h, format: cap.format, path: 'webgpu-readback', b64: b64(out) };
          }).catch((e) => { cap.error = 'map: ' + String(e); return null; });
        } catch (e) {
          cap.error = 'copy: ' + String(e);
        }
      }
      // ALWAYS clear: only a submit issued with no intervening submit since the
      // main canvas' getCurrentTexture can hold a live canvas texture. A stale
      // flag left set by an earlier frame is exactly the expired-texture bug.
      cap.freshTex = false;
      return r;
    };
  }

  // WebGL2 fallback: force preserveDrawingBuffer so readPixels after present works.
  const origGetCtx = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (type === 'webgl2' || type === 'webgl') {
      cap.isWebGL2 = true;
      attrs = Object.assign({}, attrs || {}, { preserveDrawingBuffer: true });
      const gl = origGetCtx.call(this, type, attrs);
      if (gl) cap.gl = gl;
      return gl;
    }
    return origGetCtx.call(this, type, attrs);
  };
})()`

// ---------------------------------------------------------------------------
// Node-side capture driver
// ---------------------------------------------------------------------------

interface Grab {
  ok: boolean
  error?: string
  w: number
  h: number
  format: string | null
  path: string
  data: Uint8ClampedArray
  backend: 'webgpu' | 'webgl2' | 'unknown'
  submits: number
}

/** Arm the shim and wait for the app's next submitted frame. */
async function grabNative(page: Page, nudge: () => Promise<void>): Promise<Grab> {
  const arm = async () =>
    page.evaluate(async () => {
      const cap = (window as never as { __cap: Record<string, unknown> }).__cap
      cap.pending = null
      cap.error = null
      cap.armed = true
    })

  const collect = async (budgetMs: number) =>
    page.evaluate(async (budget: number) => {
      const cap = (window as never as { __cap: Record<string, unknown> }).__cap as {
        pending: Promise<unknown> | null
        error: string | null
        armed: boolean
        isWebGPU: boolean
        isWebGL2: boolean
        submits: number
      }
      const t0 = Date.now()
      while (!cap.pending && Date.now() - t0 < budget) {
        await new Promise((r) => requestAnimationFrame(() => r(null)))
      }
      if (!cap.pending) {
        return {
          ok: false,
          error: cap.error ?? 'no frame submitted in budget',
          backend: cap.isWebGPU ? 'webgpu' : cap.isWebGL2 ? 'webgl2' : 'unknown',
          submits: cap.submits,
        }
      }
      const res = (await cap.pending) as { w: number; h: number; format: string; path: string; b64: string } | null
      if (!res) {
        return { ok: false, error: cap.error ?? 'readback returned null', backend: 'webgpu', submits: cap.submits }
      }
      return { ok: true, ...res, backend: 'webgpu', submits: cap.submits }
    }, budgetMs)

  await arm()
  let r = (await collect(700)) as Record<string, unknown>
  // A NON-animated plan renders once, on request, and that render already happened
  // during the settle — so there is no frame to catch. Escalate until one is drawn.
  // ARM BEFORE NUDGING. Nudging first draws the frame, the shim captures it into
  // cap.pending, and then arm() would zero cap.pending again — throwing away the
  // one frame we asked for and then waiting forever for another. That is why
  // D_static reported "no frame submitted" while the counter showed 4 frames drawn.
  for (let attempt = 0; !r.ok && attempt < NUDGES; attempt++) {
    await arm()
    await nudge()
    r = (await collect(3000)) as Record<string, unknown>
  }
  if (!r.ok) {
    return {
      ok: false, error: String(r.error), w: 0, h: 0, format: null, path: 'none',
      data: new Uint8ClampedArray(0), backend: r.backend as Grab['backend'], submits: Number(r.submits ?? 0),
    }
  }
  const raw = Buffer.from(String(r.b64), 'base64')
  const w = Number(r.w)
  const h = Number(r.h)
  const data = new Uint8ClampedArray(w * h * 4)
  const bgra = String(r.format ?? '').startsWith('bgra')
  for (let i = 0; i < w * h; i++) {
    const s = i * 4
    if (bgra) {
      data[s] = raw[s + 2]
      data[s + 1] = raw[s + 1]
      data[s + 2] = raw[s]
    } else {
      data[s] = raw[s]
      data[s + 1] = raw[s + 1]
      data[s + 2] = raw[s + 2]
    }
    data[s + 3] = raw[s + 3]
  }
  return {
    ok: true, w, h, format: (r.format as string) ?? null, path: String(r.path),
    data, backend: 'webgpu', submits: Number(r.submits ?? 0),
  }
}

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------

function toRgba8(g: Grab): Rgba8 {
  return { width: g.w, height: g.h, data: g.data }
}

/** BT.709 luma on the 0..255 code scale (units: 8-bit code values). */
function luma(img: Rgba8): Float32Array {
  const n = img.width * img.height
  const L = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    L[i] = 0.2126 * img.data[i * 4] + 0.7152 * img.data[i * 4 + 1] + 0.0722 * img.data[i * 4 + 2]
  }
  return L
}

function crop(img: Rgba8, x0: number, y0: number, w: number, h: number): Rgba8 {
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.max(0, y0 + y))
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.max(0, x0 + x))
      const s = (sy * img.width + sx) * 4
      const d = (y * w + x) * 4
      out[d] = img.data[s]
      out[d + 1] = img.data[s + 1]
      out[d + 2] = img.data[s + 2]
      out[d + 3] = 255 // force opaque: the crops are for human reading
    }
  }
  return { width: w, height: h, data: out }
}

/** Nearest-neighbour magnify — no interpolation, so one source px stays one block. */
function magnify(img: Rgba8, k: number): Rgba8 {
  const w = img.width * k
  const h = img.height * k
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const sy = (y / k) | 0
    for (let x = 0; x < w; x++) {
      const sx = (x / k) | 0
      const s = (sy * img.width + sx) * 4
      const d = (y * w + x) * 4
      out[d] = img.data[s]
      out[d + 1] = img.data[s + 1]
      out[d + 2] = img.data[s + 2]
      out[d + 3] = 255
    }
  }
  return { width: w, height: h, data: out }
}

/**
 * Per-crop min/max contrast stretch on luma, applied equally to R/G/B so hue is
 * preserved.
 *
 * This scene's ENTIRE frame spans ~30 of 255 code values (blur radius 51, then the
 * warp's srt_scale 4.35 magnifies that blurred result), so the rib artefact is
 * real but only ~10 codes tall — invisible at native contrast and easily mistaken
 * for a clean gradient. The stretch is a VIEWING aid only: every number in the
 * report is computed on the unstretched pixels, and the raw crop is written too.
 */
function stretch(img: Rgba8): Rgba8 {
  const L = luma(img)
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < L.length; i++) {
    if (L[i] < lo) lo = L[i]
    if (L[i] > hi) hi = L[i]
  }
  const span = Math.max(1e-6, hi - lo)
  const out = new Uint8ClampedArray(img.data.length)
  for (let i = 0; i < L.length; i++) {
    const gain = 255 / span
    for (let c = 0; c < 3; c++) out[i * 4 + c] = (img.data[i * 4 + c] - lo) * gain
    out[i * 4 + 3] = 255
  }
  return { width: img.width, height: img.height, data: out }
}

/** Row where this seam is locally sharpest — the most diagnostic place to crop. */
function sharpestRow(L: Float32Array, w: number, h: number, xs: number, m: number): number {
  let bestY = (h / 2) | 0
  let best = -1
  for (let y = m; y < h - m; y++) {
    let mx = 0
    for (let dx = -POS_HALF; dx < POS_HALF; dx++) {
      const x = Math.min(w - 2, Math.max(0, xs + dx))
      mx = Math.max(mx, Math.abs(L[y * w + x + 1] - L[y * w + x]))
    }
    if (mx > best) {
      best = mx
      bestY = y
    }
  }
  return bestY
}

function writePng(file: string, img: Rgba8): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, encodePng(img))
}

// ---------------------------------------------------------------------------
// Seam metrics
// ---------------------------------------------------------------------------

interface SeamMetrics {
  /** analytic seam period in device px = ribWidth * u_dpr * srt_scale */
  periodPxAnalytic: number
  /** period recovered from the image by autocorrelation of the column edge score */
  periodPxMeasured: number
  seamContrast: number
  strongestSeamX: number
  seamColumns: number[]
  rowsQualifying: number
  rowsTotal: number
  stepMedian: number
  /** pixels strictly between the plateaus (10%..90% of the step) */
  transitionMedian: number
  transitionMean: number
  transitionP90: number
  hardCutFraction: number
  /** Fraction of rows where the transition/position measure hit its own window
   *  edge. Anything above ~0.05 means that measure is censored, not measured. */
  transitionSaturatedFrac: number
  posSaturatedFrac: number
  /** Fraction of the local feature amplitude carried by the single sharpest pixel
   *  boundary: 1.0 = hard cut / zero transition px, 0.5 = one AA px, 0.14 = ~8 px.
   *  The only seam-core measure here that is immune to the rib's soft shoulder. */
  maxAdjacentJumpMedian: number
  jumpShareMedian: number
  jumpShareP90: number
  jumpRows: number
  /** A seam can be a NOTCH (dark line, plateaus equal on both sides) rather than
   *  a STEP. Then the step metrics above have nothing to measure, so these carry
   *  the signal instead. */
  notchDepthMedian: number
  notchWidthMedian: number
  /**
   * Staircase measures, computed on the per-row seam column AFTER removing a
   * linear fit in y. Detrending is essential: the seam in this scene is OBLIQUE,
   * so raw posStd/runLength mostly measure the seam's SLOPE, not its raggedness.
   * A perfectly rendered straight oblique edge sampled at one sample/px quantises
   * its position to integers, giving posResidStd ~0.29 px (uniform quantisation)
   * and ZERO reversals. Excess residual, and any reversal against the fitted
   * slope, is raggedness that quantisation alone cannot produce.
   */
  posSlopePxPerRow: number
  posResidStd: number
  posReversalFrac: number
  /** per-row seam column, in px relative to the nominal seam */
  posStd: number
  posRange: number
  posChangeFraction: number
  meanRunLength: number
  /** darkest value in the seam window, tracked down the seam */
  beadMeanAbsDiff: number
  beadStd: number
  /** same statistic at the rib CENTRE — pure content, no seam */
  controlMeanAbsDiff: number
  controlStd: number
  beadRatio: number
  contentVertGradient: number
}

function columnEdgeScore(L: Float32Array, w: number, h: number, m: number): Float64Array {
  const s = new Float64Array(w)
  for (let x = m; x < w - m - 1; x++) {
    let acc = 0
    let n = 0
    for (let y = m; y < h - m; y++) {
      acc += Math.abs(L[y * w + x + 1] - L[y * w + x])
      n++
    }
    s[x] = n ? acc / n : 0
  }
  return s
}

/** Period from the normalised autocorrelation of the column edge score. */
function measurePeriod(s: Float64Array, w: number, m: number, lo: number, hi: number): number {
  const xs: number[] = []
  for (let x = m; x < w - m - 1; x++) xs.push(s[x])
  const mean = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
  const c = xs.map((v) => v - mean)
  let best = { lag: 0, r: -Infinity }
  for (let lag = Math.max(2, Math.floor(lo)); lag <= Math.min(hi, c.length - 4); lag++) {
    let num = 0
    let n = 0
    for (let i = 0; i + lag < c.length; i++) {
      num += c[i] * c[i + lag]
      n++
    }
    const r = n ? num / n : 0
    if (r > best.r) best = { lag, r }
  }
  return best.lag
}

function bestPhase(s: Float64Array, w: number, P: number, m: number): { phase: number; cols: number[] } {
  let best = { phase: 0, score: -1 }
  for (let ph = 0; ph < P; ph += 0.25) {
    let acc = 0
    let n = 0
    for (let k = 0; ; k++) {
      const x = Math.round(ph + k * P)
      if (x >= w - m - 2) break
      if (x < m) continue
      acc += s[x]
      n++
    }
    if (n > 0 && acc / n > best.score) best = { phase: ph, score: acc / n }
  }
  const cols: number[] = []
  for (let k = 0; ; k++) {
    const x = Math.round(best.phase + k * P)
    if (x >= w - m - 2) break
    if (x < m) continue
    cols.push(x)
  }
  return { phase: best.phase, cols }
}

/**
 * All seam statistics for ONE vertical seam at nominal column `xs`.
 *
 * `HALF` is the half-window in px used for both the plateau reference and the
 * "darkest value" search. 4 px is wide enough to contain any 1-2 px AA ramp and
 * narrow enough that the source image's own structure does not dominate.
 */
const HALF = 4
/**
 * Half-window for the PLATEAU reference and the transition count.
 *
 * 12, not 4. With HALF=4 the counting window was 7 px wide and the scene reported
 * a transition of 6 — i.e. the measure was SATURATED and "6" really meant ">=6,
 * cannot tell". 12 gives a 23-px window, still only ~19% of the 120-px rib period,
 * so the plateau references stay inside the same rib. `transitionSaturatedFrac`
 * reports how often even this window is exceeded, so saturation can never again be
 * mistaken for a measurement.
 */
const PLATEAU_HALF = 12
/**
 * Half-window for the per-row seam POSITION search. 10, not 4: with HALF=4 the
 * reported `posRange` was 7 px for nearly every variant, which is exactly the
 * window width — censored, not measured.
 */
const POS_HALF = 10
/**
 * Rows below this step magnitude carry no seam signal to measure.
 *
 * 3 codes, not 8. This scene's source is blurred with radius 51 and then MAGNIFIED
 * 4.35x by the warp's srt_scale, so the whole frame spans ~30 code values and an
 * 8-code threshold admitted only 17-45 of 312 rows — a biased sample of the very
 * strongest rows. 3 codes is still ~15x the measured vertical content gradient
 * (~0.2 codes/px) and ~6x the 8-bit quantisation step, and `rowsQualifying` is
 * reported alongside every number so the sample size is never hidden.
 */
const MIN_STEP = 3

/**
 * Follow ONE seam down the image, row by row.
 *
 * A fixed nominal column cannot measure this scene: the seam is oblique, so over
 * 300 rows it walks far outside any fixed +-10 px window, and the position spread
 * then reports the seam's SLOPE plus window saturation instead of its raggedness.
 * (Measured: a synthetic CLEAN oblique edge of slope 0.4 px/row scored
 * posResidStd 6.59 px against a true value of ~0.29.)
 *
 * So: start at the row where the seam is locally sharpest, and step outwards in
 * both directions, each row searching only +-TRACK_HALF px around the PREVIOUS
 * row's position. Slopes up to TRACK_HALF px/row are followed exactly, and what
 * remains in the residual is raggedness.
 */
const TRACK_HALF = 3

function trackSeam(L: Float32Array, w: number, h: number, xs: number, y0: number, m: number): Int32Array {
  const track = new Int32Array(h).fill(-1)
  const findNear = (y: number, centre: number) => {
    let bestD = -1
    let bestX = centre
    for (let dx = -TRACK_HALF; dx < TRACK_HALF; dx++) {
      const x = Math.min(w - 2, Math.max(0, centre + dx))
      const d = Math.abs(L[y * w + x + 1] - L[y * w + x])
      if (d > bestD) {
        bestD = d
        bestX = x
      }
    }
    return bestX
  }
  track[y0] = findNear(y0, xs)
  for (let y = y0 + 1; y < h - m; y++) track[y] = findNear(y, track[y - 1])
  for (let y = y0 - 1; y >= m; y--) track[y] = findNear(y, track[y + 1])
  return track
}

function seamStats(L: Float32Array, w: number, h: number, xs: number, m: number, period: number, y0: number) {
  const track = trackSeam(L, w, h, xs, y0, m)
  const transitions: number[] = []
  const steps: number[] = []
  const positions: number[] = []
  const dark: number[] = []
  const control: number[] = []
  const notchDepth: number[] = []
  const notchWidth: number[] = []
  const jumpAmps: number[] = []
  const jumpShares: number[] = []
  let rowsTotal = 0

  for (let y = m; y < h - m; y++) {
    rowsTotal++
    const row = (x: number) => L[y * w + Math.min(w - 1, Math.max(0, x))]
    // Every per-row measure is centred on the TRACKED seam for this row, not on a
    // fixed column, so none of them silently measure the seam's slope.
    const xs = track[y]
    const xc = xs + Math.round(period / 2) // rib centre, same row

    // darkest value inside the seam window, and at the rib centre (content control)
    let dmin = Infinity
    for (let dx = -HALF; dx <= HALF; dx++) dmin = Math.min(dmin, row(xs + dx))
    dark.push(dmin)
    let cmin = Infinity
    for (let dx = -HALF; dx <= HALF; dx++) cmin = Math.min(cmin, row(xc + dx))
    control.push(cmin)

    // notch view: how far the seam dips below the mean of the two flanks, and how
    // many px stay below half that depth
    const plateau = (row(xs - HALF) + row(xs + HALF)) * 0.5
    const depth = plateau - dmin
    notchDepth.push(depth)
    if (depth > MIN_STEP) {
      let wcount = 0
      for (let dx = -HALF; dx <= HALF; dx++) if (row(xs + dx) < plateau - depth * 0.5) wcount++
      notchWidth.push(wcount)
    }

    const lft = row(xs - PLATEAU_HALF)
    const rgt = row(xs + PLATEAU_HALF)
    const step = rgt - lft
    if (Math.abs(step) < MIN_STEP) continue
    steps.push(Math.abs(step))

    // pixels strictly between the plateaus
    let inter = 0
    for (let dx = -PLATEAU_HALF + 1; dx <= PLATEAU_HALF - 1; dx++) {
      const t = (row(xs + dx) - lft) / step
      if (t > 0.1 && t < 0.9) inter++
    }
    transitions.push(inter)

    // The tracked column IS the edge position for this row.
    const bestX = xs
    const bestD = Math.abs(row(xs + 1) - row(xs))
    positions.push(bestX)

    // How much of the LOCAL feature amplitude is delivered by the single sharpest
    // pixel boundary. Scale-free, and the only measure here that isolates the seam
    // core from the rib's own soft magnification shoulder: 1.0 = a hard cut with
    // zero transition px, 0.5 = one antialiased px, ~0.14 = spread over ~8 px.
    let plo = Infinity
    let phi = -Infinity
    for (let dx = -3; dx <= 4; dx++) {
      const v = row(bestX + dx)
      if (v < plo) plo = v
      if (v > phi) phi = v
    }
    const amp = phi - plo
    if (amp >= MIN_STEP) {
      jumpAmps.push(bestD)
      jumpShares.push(bestD / amp)
    }
  }
  const transitionMax = 2 * PLATEAU_HALF - 1

  // vertical content gradient in a band beside the seam (never on it)
  let vg = 0
  let vn = 0
  for (let y = m; y < h - m - 1; y++) {
    for (let dx = HALF + 2; dx <= HALF + 8; dx++) {
      const x = Math.min(w - 1, xs + dx)
      vg += Math.abs(L[(y + 1) * w + x] - L[y * w + x])
      vn++
    }
  }

  const median = (a: number[]) => {
    if (!a.length) return NaN
    const s = [...a].sort((p, q) => p - q)
    return s[(s.length / 2) | 0]
  }
  const mean = (a: number[]) => (a.length ? a.reduce((p, q) => p + q, 0) / a.length : NaN)
  const std = (a: number[]) => {
    if (a.length < 2) return NaN
    const mu = mean(a)
    return Math.sqrt(a.reduce((p, q) => p + (q - mu) ** 2, 0) / (a.length - 1))
  }
  const mad = (a: number[]) => {
    if (a.length < 2) return NaN
    let acc = 0
    for (let i = 1; i < a.length; i++) acc += Math.abs(a[i] - a[i - 1])
    return acc / (a.length - 1)
  }
  const p90 = (a: number[]) => {
    if (!a.length) return NaN
    const s = [...a].sort((p, q) => p - q)
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]
  }

  // Linear detrend of position(y): slope, residual spread, and reversals.
  let slope = NaN
  let residStd = NaN
  let reversalFrac = NaN
  if (positions.length >= 8) {
    const n = positions.length
    let sx = 0
    let sy = 0
    let sxx = 0
    let sxy = 0
    for (let i = 0; i < n; i++) {
      sx += i
      sy += positions[i]
      sxx += i * i
      sxy += i * positions[i]
    }
    const den = n * sxx - sx * sx
    slope = den ? (n * sxy - sx * sy) / den : 0
    const intercept = (sy - slope * sx) / n
    let acc = 0
    for (let i = 0; i < n; i++) acc += (positions[i] - (intercept + slope * i)) ** 2
    residStd = Math.sqrt(acc / (n - 2))
    // A step opposite in sign to the overall slope is a genuine reversal.
    let rev = 0
    let steps = 0
    for (let i = 1; i < n; i++) {
      const d = positions[i] - positions[i - 1]
      if (d === 0) continue
      steps++
      if (Math.sign(d) !== Math.sign(slope) && slope !== 0) rev++
    }
    reversalFrac = steps ? rev / steps : 0
  }

  // run-length structure of the per-row seam position: flat runs = staircase
  let runs = 0
  let changes = 0
  for (let i = 0; i < positions.length; i++) {
    if (i === 0 || positions[i] !== positions[i - 1]) {
      runs++
      if (i > 0) changes++
    }
  }

  return {
    rowsTotal,
    rowsQualifying: transitions.length,
    stepMedian: median(steps),
    transitionMedian: median(transitions),
    transitionMean: mean(transitions),
    transitionP90: p90(transitions),
    hardCutFraction: transitions.length ? transitions.filter((v) => v === 0).length / transitions.length : NaN,
    transitionSaturatedFrac: transitions.length
      ? transitions.filter((v) => v >= transitionMax).length / transitions.length
      : NaN,
    // With a tracker there is no fixed window to saturate against; what matters is
    // whether the tracker ever hit its own per-row step limit.
    posSaturatedFrac: positions.length > 1
      ? positions.slice(1).filter((v, i) => Math.abs(v - positions[i]) >= TRACK_HALF - 1).length /
        (positions.length - 1)
      : NaN,
    maxAdjacentJumpMedian: median(jumpAmps),
    jumpShareMedian: median(jumpShares),
    jumpShareP90: p90(jumpShares),
    jumpRows: jumpShares.length,
    notchDepthMedian: median(notchDepth),
    notchWidthMedian: median(notchWidth),
    posSlopePxPerRow: slope,
    posResidStd: residStd,
    posReversalFrac: reversalFrac,
    posStd: std(positions),
    posRange: positions.length ? Math.max(...positions) - Math.min(...positions) : NaN,
    posChangeFraction: positions.length > 1 ? changes / (positions.length - 1) : NaN,
    meanRunLength: runs ? positions.length / runs : NaN,
    beadMeanAbsDiff: mad(dark),
    beadStd: std(dark),
    controlMeanAbsDiff: mad(control),
    controlStd: std(control),
    beadRatio: mad(control) ? mad(dark) / mad(control) : NaN,
    contentVertGradient: vn ? vg / vn : NaN,
  }
}

function analyseSeams(img: Rgba8, periodAnalytic: number, margin = 24): SeamMetrics {
  const L = luma(img)
  const s = columnEdgeScore(L, img.width, img.height, margin)
  const measured = measurePeriod(
    s, img.width, margin,
    Math.max(4, periodAnalytic * 0.5),
    Math.min(img.width / 3, periodAnalytic * 2),
  )
  const { cols } = bestPhase(s, img.width, periodAnalytic, margin)
  let overall = 0
  let on = 0
  for (let x = margin; x < img.width - margin - 1; x++) {
    overall += s[x]
    on++
  }
  const meanAll = on ? overall / on : 0
  const meanSeam = cols.length ? cols.reduce((a, x) => a + s[x], 0) / cols.length : 0
  let strongest = cols[0] ?? margin
  for (const x of cols) if (s[x] > s[strongest]) strongest = x
  const st = seamStats(L, img.width, img.height, strongest, margin, periodAnalytic, sharpestRow(L, img.width, img.height, strongest, margin))
  return {
    periodPxAnalytic: periodAnalytic,
    periodPxMeasured: measured,
    seamContrast: meanAll ? meanSeam / meanAll : NaN,
    strongestSeamX: strongest,
    seamColumns: cols,
    ...st,
  }
}

// ---------------------------------------------------------------------------
// Metric validation on synthetic stimuli with known answers
// ---------------------------------------------------------------------------

function synth(w: number, h: number, f: (x: number, y: number) => number): Rgba8 {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.round(Math.min(255, Math.max(0, f(x, y))))
      const d = (y * w + x) * 4
      data[d] = v
      data[d + 1] = v
      data[d + 2] = v
      data[d + 3] = 255
    }
  }
  return { width: w, height: h, data }
}

/**
 * Build a 1-D periodic profile of period `P` with ONE discontinuity per period
 * (like a real rib seam: the lens map is continuous inside a rib and jumps only
 * at the seam). Level alternates between `lo` and `hi` every half period, and
 * `edit` may reshape the neighbourhood of every boundary identically.
 *
 * Reshaping EVERY boundary the same way is the point: an earlier version of this
 * validation antialiased only the rising edges, so the detector correctly locked
 * onto the untouched falling edges and reported 0 transition px. The stimulus was
 * wrong, not the measure — but the measure only earns trust once the stimulus
 * cannot be gamed that way.
 */
function profile(W: number, P: number, lo: number, hi: number): { p: Float64Array; boundaries: number[] } {
  const P2 = P / 2
  const p = new Float64Array(W)
  for (let x = 0; x < W; x++) p[x] = Math.floor(x / P2) % 2 === 1 ? hi : lo
  const boundaries: number[] = []
  for (let b = P2; b < W; b += P2) boundaries.push(b)
  return { p, boundaries }
}

function validateMetrics(): { name: string; expect: string; got: Record<string, number>; pass: boolean }[] {
  const W = 480
  const H = 300
  const P = 120
  const LO = 60
  const HI = 200

  const rows: { name: string; expect: string; got: Record<string, number>; pass: boolean }[] = []
  const pick = (m: SeamMetrics) => ({
    transitionMedian: m.transitionMedian,
    hardCutFraction: +m.hardCutFraction.toFixed(3),
    notchDepthMedian: +m.notchDepthMedian.toFixed(1),
    notchWidthMedian: m.notchWidthMedian,
    jumpShareMedian: +m.jumpShareMedian.toFixed(3),
    beadMeanAbsDiff: +m.beadMeanAbsDiff.toFixed(3),
    posStd: +m.posStd.toFixed(3),
    posResidStd: +m.posResidStd.toFixed(3),
    posReversalFrac: +m.posReversalFrac.toFixed(3),
    meanRunLength: +m.meanRunLength.toFixed(1),
    periodPxMeasured: m.periodPxMeasured,
  })
  const from1d = (p: Float64Array, rowShift?: (y: number) => number) =>
    synth(W, H, (x, y) => p[Math.min(W - 1, Math.max(0, x - (rowShift ? rowShift(y) : 0)))])

  // 1. hard step at every boundary, constant down the seam (KNOWN GOOD)
  {
    const { p } = profile(W, P, LO, HI)
    const m = analyseSeams(from1d(p), P)
    rows.push({
      name: 'hard-step',
      expect: 'transition 0, bead ~0, posStd 0, jumpShare 1.0 (hard cut)',
      got: pick(m),
      pass: m.transitionMedian === 0 && m.beadMeanAbsDiff < 0.01 && m.posStd < 0.01
        && Math.abs(m.jumpShareMedian - 1) < 0.02,
    })
  }
  // 2. exactly one antialiased pixel at EVERY boundary
  {
    const { p, boundaries } = profile(W, P, LO, HI)
    for (const b of boundaries) if (b - 1 < W) p[b - 1] = (LO + HI) / 2
    const m = analyseSeams(from1d(p), P)
    rows.push({
      name: 'one-px-AA',
      expect: 'transition 1, jumpShare ~0.5 (one AA px)',
      got: pick(m),
      pass: m.transitionMedian === 1 && Math.abs(m.jumpShareMedian - 0.5) < 0.06,
    })
  }
  // 3. broad smooth ramp across 8 px at EVERY boundary
  {
    const { p, boundaries } = profile(W, P, LO, HI)
    for (const b of boundaries) {
      const a = p[Math.max(0, b - 5)]
      const c = p[Math.min(W - 1, b + 4)]
      for (let k = 0; k < 8; k++) {
        const x = b - 4 + k
        if (x >= 0 && x < W) p[x] = a + ((c - a) * (k + 0.5)) / 8
      }
    }
    const m = analyseSeams(from1d(p), P)
    rows.push({
      name: 'broad-ramp-8px',
      expect: 'transition >= 5, jumpShare <= 0.25 (spread over ~8 px)',
      got: pick(m),
      pass: m.transitionMedian >= 5 && m.jumpShareMedian <= 0.25,
    })
  }
  // 4. beaded: the darkest seam pixel alternates row to row (KNOWN BAD)
  {
    const { p, boundaries } = profile(W, P, LO, HI)
    const bset = new Set(boundaries.map((b) => b - 1))
    const img = synth(W, H, (x, y) => (bset.has(x) ? (y % 2 ? 30 : 90) : p[Math.min(W - 1, x)]))
    const m = analyseSeams(img, P)
    rows.push({
      name: 'beaded',
      expect: 'bead ~30 codes (dark value alternates 30/60)',
      got: pick(m),
      pass: m.beadMeanAbsDiff > 20,
    })
  }
  // 5. staircase: the whole pattern shifts 1 px every 10 rows
  {
    const { p } = profile(W, P, LO, HI)
    const m = analyseSeams(from1d(p, (y) => Math.floor(y / 10) % 4), P)
    rows.push({
      name: 'staircase',
      expect: 'transition 0, posStd > 0.5, runLen ~10',
      got: pick(m),
      pass: m.transitionMedian === 0 && m.posStd > 0.5 && m.meanRunLength > 5,
    })
  }
  // 5b. CLEAN OBLIQUE edge: slope 0.4 px/row, no jitter. Quantisation only.
  {
    const { p } = profile(W, P, LO, HI)
    const m = analyseSeams(from1d(p, (y) => Math.round(y * 0.4)), P)
    rows.push({
      name: 'oblique-clean',
      expect: 'residStd <= 0.45, reversals 0',
      got: pick(m),
      pass: m.posResidStd <= 0.45 && m.posReversalFrac === 0,
    })
  }
  // 5c. RAGGED OBLIQUE edge: same slope plus deterministic +-1 px jitter (KNOWN BAD)
  {
    const { p } = profile(W, P, LO, HI)
    const jitter = (y: number) => (y % 3 === 0 ? 1 : y % 3 === 1 ? -1 : 0)
    const m = analyseSeams(from1d(p, (y) => Math.round(y * 0.4) + jitter(y)), P)
    rows.push({
      name: 'oblique-ragged',
      expect: 'residStd > 0.6, reversals > 0.2',
      got: pick(m),
      pass: m.posResidStd > 0.6 && m.posReversalFrac > 0.2,
    })
  }
  // 6. NOTCH: a 1-px dark line, identical plateaus either side. The step metrics
  //    have nothing to measure here; the notch metrics must carry it.
  {
    const p = new Float64Array(W).fill(HI)
    const bset = new Set<number>()
    for (let b = P; b < W; b += P) {
      p[b] = 40
      bset.add(b)
    }
    const m = analyseSeams(from1d(p), P)
    rows.push({
      name: 'notch-1px',
      expect: 'notchDepth ~160, notchWidth 1, transition rows ~0',
      got: pick(m),
      pass: m.notchDepthMedian > 120 && m.notchWidthMedian === 1,
    })
  }
  // 7. period estimator on a single-discontinuity-per-period sawtooth
  {
    const p = new Float64Array(W)
    for (let x = 0; x < W; x++) p[x] = LO + (HI - LO) * ((x % P) / P)
    const m = analyseSeams(from1d(p), P)
    rows.push({
      name: 'period-sawtooth',
      expect: `periodPxMeasured == ${P}`,
      got: pick(m),
      pass: m.periodPxMeasured === P,
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

interface Variant {
  id: string
  desc: string
  /** node-id → param overrides, applied after a fresh import */
  params?: Record<string, Record<string, unknown>>
  /** drop the Time→* edges so u_time leaves the shader entirely */
  cutTime?: boolean
}

const REEDED = 'reeded_glass-1784049273586'
const TIME = 'def-time'
const OUTPUT = 'def-output'
const BLUR = 'blur-1785192733582'
const WARP = 'warp-1785192279448'

const FROZEN = { [TIME]: { speed: 0 } }
const HIQ = { [OUTPUT]: { quality: 'high' } }

const VARIANTS: Variant[] = [
  { id: 'A_as_shipped', desc: 'untouched scene, time live at speed 0.031 (dprScale 0.75)' },
  { id: 'B_frozen', desc: 'Time.speed=0 — content frozen, still time-live so dprScale 0.75. BASELINE', params: { ...FROZEN } },
  { id: 'C_frozen_hiq', desc: 'B + output quality=high → dprScale 1.0 (isolates the 0.75 downscale)', params: { ...FROZEN, ...HIQ } },
  { id: 'D_static', desc: 'B + Time edges cut → not time-live → STATIC_DPR_SCALE 1.0', params: { ...FROZEN }, cutTime: true },
  { id: 'E_curv077', desc: 'B + curvature 0.77 (just below the ior-1.65 minification cliff 0.7753)', params: { ...FROZEN, [REEDED]: { curvature: 0.77 } } },
  { id: 'F_curv080', desc: 'B + curvature 0.80 (just above the cliff)', params: { ...FROZEN, [REEDED]: { curvature: 0.8 } } },
  { id: 'G_bow0', desc: 'B + bow 0 (as-shipped bow is 2.72, outside the declared -1..1)', params: { ...FROZEN, [REEDED]: { bow: 0 } } },
  { id: 'H_ribw81', desc: 'B + ribWidth 81 (non-integer device seam period at u_dpr 1.5)', params: { ...FROZEN, [REEDED]: { ribWidth: 81 } } },
  { id: 'I_curv077_hiq', desc: 'C + curvature 0.77 — full res AND out of the minification regime', params: { ...FROZEN, ...HIQ, [REEDED]: { curvature: 0.77 } } },
  { id: 'J_curv215_bow0_hiq', desc: 'C + bow 0 — full res, minifying, no bow', params: { ...FROZEN, ...HIQ, [REEDED]: { bow: 0 } } },
  // Diagnostics: the shipped scene is so heavily blurred (radius 51) that the
  // source is nearly flat, which caps every contrast number. These two prove the
  // image really decoded and show what the rib is actually being fed.
  { id: 'Z1_noblur_hiq', desc: 'C + blur radius 0 — does the JPEG actually decode?', params: { ...FROZEN, ...HIQ, [BLUR]: { radius: 0 } } },
  { id: 'Z2_norib_hiq', desc: 'C + ior 1.0 — rib disabled, shows the source the rib is fed', params: { ...FROZEN, ...HIQ, [REEDED]: { ior: 1.0 } } },
  { id: 'Z3_noblur_norib_hiq', desc: 'C + blur 0 + ior 1.0 — the bare warped image', params: { ...FROZEN, ...HIQ, [BLUR]: { radius: 0 }, [REEDED]: { ior: 1.0 } } },
  {
    id: 'Z4_bare_image_hiq',
    desc: 'blur 0 + ior 1.0 + warp strength 0 and srt_scale 1 — proves the JPEG decodes',
    params: { ...FROZEN, ...HIQ, [BLUR]: { radius: 0 }, [REEDED]: { ior: 1.0 }, [WARP]: { strength: 0, srt_scale: 1 } },
  },
]

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Row {
  id: string
  desc: string
  canvasW: number
  canvasH: number
  cssW: number
  cssH: number
  uDpr: number
  dprScale: number
  timeLiveInferred: boolean
  readbackW: number
  readbackH: number
  screenshotW: number
  screenshotH: number
  screenshotMatchesBacking: boolean
  format: string | null
  params: { ribWidth: number; ior: number; curvature: number; bow: number; srtScale: number }
  metrics: SeamMetrics
  files: Record<string, string>
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })

  // ---- metric validation first: never report a number from an untrusted measure
  const validation = validateMetrics()
  console.log('\n=== metric validation (synthetic, known answers) ===')
  for (const v of validation) {
    console.log(`  ${v.pass ? 'PASS' : 'FAIL'}  ${v.name.padEnd(16)} expect ${v.expect}`)
    console.log(`        got ${JSON.stringify(v.got)}`)
  }
  fs.writeFileSync(path.join(OUT, 'metric-validation.json'), JSON.stringify(validation, null, 2))
  const badValidation = validation.filter((v) => !v.pass)
  if (badValidation.length) {
    console.error(`\nFAIL: ${badValidation.length} metric validation case(s) failed — measures not trustworthy.`)
    if (!flag('force')) process.exit(1)
  }
  if (arg('stage') === 'validate') return

  const sceneText = fs.readFileSync(SCENE, 'utf8')
  const scene = JSON.parse(sceneText) // importGraph needs an OBJECT, not the raw text

  const only = arg('only')?.split(',').map((s) => s.trim())
  const todo = VARIANTS.filter((v) => !only || only.includes(v.id))

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: !flag('headed'),
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU'],
  })
  const rows: Row[] = []
  try {
    const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE })
    await ctx.addInitScript({ content: CAPTURE_SHIM })
    const consoleErrors: string[] = []
    const backend = { isWebGPU: false, isWebGL2: false }

    for (const v of todo) {
      console.log(`\n--- ${v.id}: ${v.desc}`)

      // ONE PAGE PER VARIANT. A GPUDevice loss in any single variant used to
      // cascade: every later variant failed with "Device was lost before mapping
      // was resolved" on a device it never touched. A fresh page also guarantees
      // no variant inherits another's store, renderer or quality tier.
      const page = await ctx.newPage()
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(`[${v.id}] ${m.text().slice(0, 300)}`)
      })
      page.on('pageerror', (e) => consoleErrors.push(`[${v.id}] pageerror: ${String(e).slice(0, 300)}`))

      await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => !!(window as never as { __sombra?: unknown }).__sombra, null, { timeout: 30_000 })

      let nudgeParity = 0
      const nudge = async () => {
        nudgeParity++
        if (nudgeParity === 1) {
          // uniform-path nudge
          await page.evaluate(
            (id) => {
              ;(window as never as { __sombra: { setParams(i: string, p: Record<string, unknown>): void } }).__sombra
                .setParams(id as string, { alpha: 1 - 1e-6 })
            },
            OUTPUT,
          )
        } else if (nudgeParity === 2) {
          // RECOMPILE-path nudge. On a non-animated plan the uniform path cannot
          // repaint at all: App.tsx handleUniformUpdate calls renderer.notifyChange(),
          // and notifyChange() early-returns when `!this.animated`. Only the compile
          // path calls requestRender() (App.tsx:93-95). `alphaOp` is a recompile
          // param, and with alpha == 1 'replace' and 'multiply' are numerically
          // identical, so this forces a repaint without changing a pixel.
          await page.evaluate(
            (id) => {
              ;(window as never as { __sombra: { setParams(i: string, p: Record<string, unknown>): void } }).__sombra
                .setParams(id as string, { alphaOp: 'replace' })
            },
            OUTPUT,
          )
          await page.waitForTimeout(700)
        } else {
          // last resort: a real resize, which always reaches the renderer
          await page.setViewportSize({ width: VIEWPORT.width - 2, height: VIEWPORT.height })
          await page.waitForTimeout(200)
          await page.setViewportSize(VIEWPORT)
        }
        await page.waitForTimeout(200)
      }

      try {
      await page.evaluate((g) => {
        ;(window as never as { __sombra: { importGraph(o: unknown): void } }).__sombra.importGraph(g)
      }, scene)
      await page.waitForTimeout(1200) // image decode + worker compile

      if (v.cutTime) {
        const cut = await page.evaluate((timeId) => {
          const s = (window as never as {
            __sombra: {
              describeGraph(): { edges: Array<{ id: string; source: string }> }
              removeEdge(id: string): void
            }
          }).__sombra
          const ids = s.describeGraph().edges.filter((e) => e.source === timeId).map((e) => e.id)
          for (const id of ids) s.removeEdge(id)
          return ids.length
        }, TIME)
        console.log(`    cut ${cut} Time edge(s)`)
        await page.waitForTimeout(1000)
      }
      for (const [nodeId, p] of Object.entries(v.params ?? {})) {
        await page.evaluate(
          ([id, params]) => {
            ;(window as never as { __sombra: { setParams(i: string, p: Record<string, unknown>): void } }).__sombra
              .setParams(id as string, params as Record<string, unknown>)
          },
          [nodeId, p] as const,
        )
      }
      await page.waitForTimeout(1500) // uniform push / recompile / renderer-tier settle

      const state = await page.evaluate(() => {
        const s = (window as never as {
          __sombra: { stores: { compiler: { getState(): { errors?: unknown[] } } } }
        }).__sombra
        const c = s.stores.compiler.getState()
        // Node preview thumbnails are canvases too, and DOM order is not stable,
        // so pick the LARGEST canvas and tag it — never `querySelector('canvas')`.
        const all = [...document.querySelectorAll('canvas')] as HTMLCanvasElement[]
        for (const c2 of all) c2.removeAttribute('data-p13-main')
        let cv: HTMLCanvasElement | null = null
        for (const c2 of all) if (!cv || c2.width * c2.height > cv.width * cv.height) cv = c2
        cv?.setAttribute('data-p13-main', '1')
        return {
          canvasW: cv?.width ?? 0,
          canvasH: cv?.height ?? 0,
          cssW: cv?.clientWidth ?? 0,
          cssH: cv?.clientHeight ?? 0,
          dpr: window.devicePixelRatio,
          errors: (c.errors ?? []).length,
          canvasCount: all.length,
          canvases: all.map((c2) => ({ w: c2.width, h: c2.height, cw: c2.clientWidth, ch: c2.clientHeight })),
        }
      })

      const params = await page.evaluate((rid) => {
        const s = (window as never as {
          __sombra: { describeGraph(): { nodes: Array<{ id: string; params: Record<string, number> }> } }
        }).__sombra
        const n = s.describeGraph().nodes.find((x) => x.id === rid)!
        return {
          ribWidth: n.params.ribWidth, ior: n.params.ior, curvature: n.params.curvature,
          bow: n.params.bow, srtScale: n.params.srt_scale,
        }
      }, REEDED)

      const caps = await page.evaluate(() => {
        const cap = (window as never as {
          __cap: { isWebGPU: boolean; isWebGL2: boolean; deviceLost: string | null; gpuErrors: string[]; skipped: number }
        }).__cap
        return { isWebGPU: cap.isWebGPU, isWebGL2: cap.isWebGL2, deviceLost: cap.deviceLost, gpuErrors: cap.gpuErrors, skipped: cap.skipped }
      })
      backend.isWebGPU ||= caps.isWebGPU
      backend.isWebGL2 ||= caps.isWebGL2
      console.log(
        `    backend WebGPU=${caps.isWebGPU} WebGL2=${caps.isWebGL2} deviceLost=${caps.deviceLost ?? 'no'} ` +
          `compileErrors=${state.errors} canvases=${state.canvasCount}`,
      )

      const framesBefore = await page.evaluate(
        () => (window as never as { __cap: { mainFrames: number } }).__cap.mainFrames,
      )
      const g = await grabNative(page, nudge)
      if (!g.ok) {
        const framesAfter = await page.evaluate(
          () => (window as never as { __cap: { mainFrames: number } }).__cap.mainFrames,
        )
        console.log(
          `    READBACK FAILED: ${g.error} (backend ${g.backend}, submits ${g.submits}, skipped ${caps.skipped})\n` +
            `      main-canvas frames drawn during capture: ${framesAfter - framesBefore} ` +
            `(total ${framesAfter}) — 0 means the renderer never drew, not that we missed it`,
        )
        continue
      }
      const img = toRgba8(g)
      const dprScale = state.cssW ? g.w / (state.cssW * Math.min(state.dpr, 2)) : NaN
      const uDpr = Math.min(state.dpr, 2) * dprScale
      const period = params.ribWidth * uDpr * (params.srtScale ?? 1)

      // blankness guard — a zeroed readback must never be reported as a measurement
      let lo = 255
      let hi = 0
      let acc = 0
      for (let i = 0; i < img.width * img.height; i++) {
        const v = img.data[i * 4]
        if (v < lo) lo = v
        if (v > hi) hi = v
        acc += v
      }
      const meanR = acc / (img.width * img.height)
      console.log(`    readback R channel: min ${lo} max ${hi} mean ${meanR.toFixed(1)}`)
      if (hi === 0) {
        const dbg = await page.evaluate(() => {
          const cap = (window as never as { __cap: Record<string, unknown> }).__cap
          return { skipped: cap.skipped, submits: cap.submits, gpuErrors: cap.gpuErrors, error: cap.error }
        })
        console.log(`    BLANK READBACK — ${JSON.stringify(dbg)}`)
        continue
      }

      // Element screenshot, for the dimension comparison the brief asks for.
      // `elementHandle.screenshot()` snaps the element's FRACTIONAL CSS box out to
      // whole device px, so it can land 1-2 px over on each axis even when the
      // scale is right; the integer `clip` below removes that confound and gives a
      // dimension that is exactly `round(cssSize) * deviceScaleFactor`.
      const el = await page.$('canvas[data-p13-main="1"]')
      const box = el ? await el.boundingBox() : null
      if (el && box) {
        const clipBuf = await page.screenshot({
          clip: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
        })
        const cw = clipBuf.readUInt32BE(16)
        const ch = clipBuf.readUInt32BE(20)
        console.log(
          `    integer-clip shot ${cw}x${ch} vs backing ${img.width}x${img.height} ` +
            `→ ratio ${(cw / img.width).toFixed(4)} (expected 1/dprScale = ${(1 / dprScale).toFixed(4)})`,
        )
        fs.writeFileSync(path.join(OUT, `${v.id}-clipshot-${cw}x${ch}.png`), clipBuf)
      }
      const shotBuf = el ? await el.screenshot() : null
      let sw = 0
      let sh = 0
      if (shotBuf) {
        // PNG IHDR: width/height are big-endian u32 at bytes 16..24
        sw = shotBuf.readUInt32BE(16)
        sh = shotBuf.readUInt32BE(20)
        fs.writeFileSync(path.join(OUT, `${v.id}-elementshot.png`), shotBuf)
      }

      const metrics = analyseSeams(img, period)

      // ---- outputs
      const files: Record<string, string> = {}
      const full = `${v.id}-full-${img.width}x${img.height}.png`
      writePng(path.join(OUT, full), crop(img, 0, 0, img.width, img.height))
      files.full = full

      const cx = metrics.strongestSeamX
      const sy = sharpestRow(luma(img), img.width, img.height, cx, 24)
      const cy = Math.max(0, sy - (CROP >> 1))
      const sqRaw = crop(img, cx - (CROP >> 1), cy, CROP, CROP)
      const sqName = `${v.id}-seam-x${cx}y${sy}-${CROP}px-${MAG}x.png`
      writePng(path.join(OUT, sqName), magnify(sqRaw, MAG))
      files.seamCrop = sqName
      const sqStretchName = `${v.id}-seam-x${cx}y${sy}-${CROP}px-${MAG}x-STRETCHED.png`
      writePng(path.join(OUT, sqStretchName), magnify(stretch(sqRaw), MAG))
      files.seamCropStretched = sqStretchName

      const stripRaw = crop(img, cx - (STRIP_W >> 1), Math.max(0, sy - (STRIP_H >> 1)), STRIP_W, STRIP_H)
      const stripName = `${v.id}-seamstrip-x${cx}y${sy}-${STRIP_W}x${STRIP_H}-${MAG}x.png`
      writePng(path.join(OUT, stripName), magnify(stripRaw, MAG))
      files.seamStrip = stripName
      const stripStretchName = `${v.id}-seamstrip-x${cx}y${sy}-${STRIP_W}x${STRIP_H}-${MAG}x-STRETCHED.png`
      writePng(path.join(OUT, stripStretchName), magnify(stretch(stripRaw), MAG))
      files.seamStripStretched = stripStretchName

      const row: Row = {
        id: v.id,
        desc: v.desc,
        canvasW: state.canvasW,
        canvasH: state.canvasH,
        cssW: state.cssW,
        cssH: state.cssH,
        uDpr,
        dprScale,
        timeLiveInferred: dprScale < 0.99,
        readbackW: img.width,
        readbackH: img.height,
        screenshotW: sw,
        screenshotH: sh,
        screenshotMatchesBacking: sw === img.width && sh === img.height,
        format: g.format,
        params,
        metrics,
        files,
      }
      rows.push(row)

      console.log(
        `    canvas ${state.canvasW}x${state.canvasH} (css ${state.cssW}x${state.cssH}) ` +
          `u_dpr ${uDpr.toFixed(3)} dprScale ${dprScale.toFixed(3)} animated(inferred) ${dprScale < 0.99}`,
      )
      console.log(`    readback ${img.width}x${img.height} | elementshot ${sw}x${sh} | match ${row.screenshotMatchesBacking}`)
      console.log(
        `    period analytic ${period.toFixed(1)}px measured ${metrics.periodPxMeasured}px  seamContrast ${metrics.seamContrast.toFixed(2)}  seam@x=${cx}`,
      )
      console.log(
        `    step ${metrics.stepMedian.toFixed(1)} codes | transition med ${metrics.transitionMedian} mean ${metrics.transitionMean.toFixed(2)} p90 ${metrics.transitionP90} | hardCut ${(metrics.hardCutFraction * 100).toFixed(0)}% | satur trans ${(metrics.transitionSaturatedFrac * 100).toFixed(0)}% pos ${(metrics.posSaturatedFrac * 100).toFixed(0)}%`,
      )
      console.log(
        `    JUMPSHARE med ${metrics.jumpShareMedian.toFixed(3)} p90 ${metrics.jumpShareP90.toFixed(3)} (1.0=hard cut, .5=1px AA) | maxJump ${metrics.maxAdjacentJumpMedian.toFixed(1)} codes/px | n=${metrics.jumpRows}\n` +
          `    notch depth ${metrics.notchDepthMedian.toFixed(1)} codes width ${metrics.notchWidthMedian}px | rows qualifying ${metrics.rowsQualifying}/${metrics.rowsTotal}`,
      )
      console.log(
        `    DETRENDED slope ${metrics.posSlopePxPerRow.toFixed(3)}px/row residStd ${metrics.posResidStd.toFixed(2)}px (0.29=clean quantisation) reversals ${(metrics.posReversalFrac * 100).toFixed(0)}%\n` +
          `    pos std ${metrics.posStd.toFixed(2)}px range ${metrics.posRange}px runLen ${metrics.meanRunLength.toFixed(1)} | bead ${metrics.beadMeanAbsDiff.toFixed(2)} vs control ${metrics.controlMeanAbsDiff.toFixed(2)} (ratio ${metrics.beadRatio.toFixed(2)}) | contentVert ${metrics.contentVertGradient.toFixed(2)}`,
      )
      } finally {
        await page.close()
      }
    }

    fs.writeFileSync(
      path.join(OUT, 'phase13.json'),
      JSON.stringify({ appUrl: APP_URL, deviceScale: DEVICE_SCALE, viewport: VIEWPORT, backend, consoleErrors, validation, rows }, null, 2),
    )
    if (consoleErrors.length) {
      console.log(`\nconsole errors (${consoleErrors.length}):`)
      for (const e of consoleErrors.slice(0, 10)) console.log(`  ${e}`)
    }
  } finally {
    await browser.close()
  }
  console.log(`\nwrote ${rows.length} variant(s) → ${OUT}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
