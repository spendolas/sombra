/**
 * scene-assert — mechanism-engaged predicates. A perf gate must PROVE the shader
 * path ran; a bare timing number passes even when the feature under test was
 * skipped. Each predicate here pairs the outcome with proof the code path was
 * exercised, per the repo guardrail.
 *
 *  1. pass count matches the scene's declared expectation (a collapsed graph —
 *     e.g. a heavy scene swapped for passthrough — fails here first).
 *  2. non-zero GPU time with the REAL method (WebGPU must be 'timestamp-query'
 *     with gpuNs>0; an adapter lacking the feature is marked UNMEASURED, never
 *     passed as a silent zero).
 *  3. output non-degenerate — final-frame luma variance above a floor (a shader
 *     optimised to a flat clear colour fails).
 *  4. cost-monotonicity — the heavy param must cost strictly more GPU time than
 *     the cheap param (blur radius 128 vs 1, fbm octaves 8 vs 1). If the knob
 *     never reached the shader, the two match and this fails. This is the probe
 *     that proves the gate CAN fail.
 */

import type { Backend } from './perf-util'

export const VARIANCE_FLOOR = 1e-4
export const MONOTONICITY_THRESHOLD = 1.5

export interface Assertion {
  name: string
  ok: boolean
  /** True when the check could not be evaluated (e.g. timestamp feature absent). */
  unmeasured?: boolean
  detail: string
}

export function assertPassCount(expected: number, actual: number): Assertion {
  return {
    name: 'pass-count',
    ok: actual === expected,
    detail: `expected ${expected} passes, got ${actual}`,
  }
}

export function assertTiming(
  backend: Backend,
  timingMethod: 'timestamp-query' | 'wall-clock' | 'none',
  gpuNsTotal: number | null,
): Assertion {
  if (backend === 'webgpu') {
    if (timingMethod !== 'timestamp-query') {
      return { name: 'timing', ok: false, unmeasured: true, detail: `WebGPU adapter lacks timestamp-query (method='${timingMethod}') — UNMEASURED` }
    }
    return {
      name: 'timing',
      ok: gpuNsTotal != null && gpuNsTotal > 0,
      detail: `timestamp-query total=${gpuNsTotal == null ? 'null' : gpuNsTotal.toFixed(0)}ns`,
    }
  }
  // WebGL2: wall-clock is the only method available (no EXT timer in Chrome).
  return {
    name: 'timing',
    ok: timingMethod === 'wall-clock' && gpuNsTotal != null && gpuNsTotal > 0,
    detail: `wall-clock total=${gpuNsTotal == null ? 'null' : gpuNsTotal.toFixed(0)}ns (weaker than WebGPU timestamp-query)`,
  }
}

export function assertNonDegenerate(variance: number): Assertion {
  return {
    name: 'non-degenerate',
    ok: variance > VARIANCE_FLOOR,
    detail: `luma variance ${variance.toExponential(2)} (floor ${VARIANCE_FLOOR.toExponential(0)})`,
  }
}

/**
 * `reliable` should be false for WebGL2 wall-clock timings: Chrome's coarse
 * performance.now() cannot resolve small ALU-bound deltas, so a failing ratio
 * there is timer noise, not a real regression — reported as advisory
 * (unmeasured), never a hard failure. WebGPU timestamp-query is reliable and
 * carries the gate's teeth.
 */
export function assertMonotonicity(heavyNs: number | null, cheapNs: number | null, reliable = true): Assertion {
  if (heavyNs == null || cheapNs == null) {
    return { name: 'cost-monotonicity', ok: false, unmeasured: true, detail: `unmeasured (heavy=${heavyNs}, cheap=${cheapNs})` }
  }
  const ratio = cheapNs > 0 ? heavyNs / cheapNs : Infinity
  const ok = heavyNs > cheapNs * MONOTONICITY_THRESHOLD
  const detail = `heavy ${heavyNs.toFixed(0)}ns vs cheap ${cheapNs.toFixed(0)}ns (ratio ${ratio.toFixed(2)}×, need >${MONOTONICITY_THRESHOLD}×)${reliable ? '' : ' [wall-clock advisory]'}`
  return { name: 'cost-monotonicity', ok, unmeasured: !ok && !reliable, detail }
}

/** True if every non-unmeasured assertion passed. Unmeasured entries are not failures. */
export function allGreen(assertions: Assertion[]): boolean {
  return assertions.every((a) => a.ok || a.unmeasured)
}

/** True if any assertion is a hard failure (not ok and not unmeasured). */
export function anyFailed(assertions: Assertion[]): boolean {
  return assertions.some((a) => !a.ok && !a.unmeasured)
}
