/**
 * Perf-harness math helpers: percentiles, warmup slicing, the resolution
 * matrix, and a variance metric for the non-degenerate-output gate.
 *
 * Pure functions, no GPU, no browser — unit-testable and shared by every CLI.
 */

import type { Rgba8 } from '../../blur-bakeoff/lib/image'

export type Backend = 'webgpu' | 'webgl2'

export interface Resolution {
  /** Short label used in tables and CLI flags (`1080`, `1440`, `4k`). */
  key: string
  width: number
  height: number
}

/** The three resolutions the plan mandates, cheap → 4K. */
export const RESOLUTIONS: Resolution[] = [
  { key: '1080', width: 1920, height: 1080 },
  { key: '1440', width: 2560, height: 1440 },
  { key: '4k', width: 3840, height: 2160 },
]

/** Accept `1080` / `1920x1080` / `4k` etc. against the matrix above. */
export function resolveResolutions(spec?: string): Resolution[] {
  if (!spec) return RESOLUTIONS
  const wanted = spec.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  const out: Resolution[] = []
  for (const w of wanted) {
    const hit = RESOLUTIONS.find((r) => r.key === w || `${r.width}x${r.height}` === w)
    if (!hit) throw new Error(`unknown resolution "${w}" (known: ${RESOLUTIONS.map((r) => r.key).join(', ')})`)
    out.push(hit)
  }
  return out
}

/**
 * Percentile of an unsorted sample, linear interpolation between ranks.
 * `p` in [0,100]. Returns NaN for an empty sample.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN
  const s = [...values].sort((a, b) => a - b)
  if (s.length === 1) return s[0]
  const rank = (p / 100) * (s.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return s[lo]
  const frac = rank - lo
  return s[lo] * (1 - frac) + s[hi] * frac
}

export function min(values: number[]): number {
  return values.reduce((a, b) => Math.min(a, b), Infinity)
}
export function max(values: number[]): number {
  return values.reduce((a, b) => Math.max(a, b), -Infinity)
}
export function mean(values: number[]): number {
  if (values.length === 0) return NaN
  return values.reduce((a, b) => a + b, 0) / values.length
}

/** Discard the first `warmup` samples (JIT / pipeline warm-up), keep the rest. */
export function dropWarmup(values: number[], warmup: number): number[] {
  return values.length > warmup ? values.slice(warmup) : values.slice()
}

export interface FrameStats {
  frameMsP50: number
  frameMsP95: number
  frameMsMin: number
  frameMsMax: number
  fps: number
  samples: number
}

/** Reduce an array of per-frame wall-clock deltas (ms) to the reported stats. */
export function frameStats(frameMs: number[]): FrameStats {
  const p50 = percentile(frameMs, 50)
  return {
    frameMsP50: p50,
    frameMsP95: percentile(frameMs, 95),
    frameMsMin: min(frameMs),
    frameMsMax: max(frameMs),
    fps: p50 > 0 ? 1000 / p50 : 0,
    samples: frameMs.length,
  }
}

/**
 * Per-channel luma variance of an RGBA8 frame, 0..~1 scale.
 *
 * The non-degenerate-output gate wants proof the shader produced structure, not
 * a flat clear colour. Alpha is ignored (some effect nodes pass a constant
 * alpha through). A constant frame returns ~0; any spatial variation lifts it.
 */
export function frameVariance(img: Rgba8): number {
  const d = img.data
  const n = img.width * img.height
  if (n === 0) return 0
  let sum = 0
  let sumSq = 0
  for (let i = 0; i < n; i++) {
    const o = i * 4
    // Rec.601 luma in 0..1
    const y = (0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2]) / 255
    sum += y
    sumSq += y * y
  }
  const m = sum / n
  return Math.max(0, sumSq / n - m * m)
}

/** Round to `dp` decimals for compact table output. */
export function round(v: number, dp = 2): number {
  if (!Number.isFinite(v)) return v
  const f = 10 ** dp
  return Math.round(v * f) / f
}
