/**
 * Benchmark scene graph builders — the single source of truth shared by the
 * in-app perf view and the CLI perf harness (scripts/perf/lib/scenes.ts).
 *
 * These are purpose-built graphs that exercise the heavy nodes the existing
 * presets don't (multi-pass blur, reeded frost, pyramid chains, deep fbm).
 * Each scene's `build()` returns a fresh `{nodes, edges}` graph. Compilation,
 * both-backend parity assertions, expected pass counts, and cheap cost-knob
 * variants live in the CLI harness — this module only constructs graphs.
 *
 * Node types / port ids / param ids are taken from the real node definitions in
 * src/nodes (fbm.ts, warp.ts, effect/blur.ts, effect/pyramid-blur.ts,
 * reeded-glass.ts) — not guessed.
 */

import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../nodes/types'

export interface PerfScene {
  id: string
  title: string
  build(): { nodes: Node<NodeData>[]; edges: Edge<EdgeData>[] }
}

// --- small graph-builder helpers -------------------------------------------

let nodeSeq = 0
function n(type: string, params: Record<string, unknown> = {}): Node<NodeData> {
  return {
    id: `n${nodeSeq++}`,
    type: 'shaderNode',
    position: { x: 0, y: 0 },
    data: { type, params },
  }
}
function e(
  source: Node<NodeData>,
  target: Node<NodeData>,
  sourceHandle: string,
  targetHandle: string,
  sourcePortType: string,
): Edge<EdgeData> {
  return {
    id: `${source.id}-${sourceHandle}-${target.id}-${targetHandle}`,
    source: source.id,
    target: target.id,
    sourceHandle,
    targetHandle,
    type: 'typed',
    data: { sourcePort: sourceHandle, targetPort: targetHandle, sourcePortType },
  }
}

interface Graph {
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
}

// --- scene graph builders ---------------------------------------------------
// Each returns a fresh graph. `opts` carries the cost knob a scene's cheap
// variant flips (the cost-monotonicity gate), so the heavy and cheap graphs
// share one builder and differ only in that knob.

/** output/UV only — the harness floor. */
export function buildPassthrough(): Graph {
  const uv = n('uv_transform', {})
  const out = n('fragment_output', {})
  return { nodes: [uv, out], edges: [e(uv, out, 'uv', 'color', 'vec2')] }
}

/** fbm simplex, single ALU-heavy pass. octaves is the cost knob. */
export function buildFbmSingle(opts?: { octaves?: number }): Graph {
  const fbm = n('fbm', {
    srt_scale: 1.0,
    noiseType: 'simplex',
    fractalMode: 'standard',
    octaves: opts?.octaves ?? 8,
    lacunarity: 2.0,
    gain: 0.5,
  })
  const ramp = n('color_ramp', {
    interpolation: 'smooth',
    stops: [
      { position: 0.0, color: [0.02, 0.03, 0.05] },
      { position: 0.5, color: [0.24, 0.44, 1.0] },
      { position: 1.0, color: [0.66, 0.73, 0.84] },
    ],
  })
  const out = n('fragment_output', {})
  return {
    nodes: [fbm, ramp, out],
    edges: [
      e(fbm, ramp, 'value', 't', 'float'),
      e(ramp, out, 'color', 'color', 'color'),
    ],
  }
}

/** domain warp → worley fbm — nested-noise ALU, single pass. */
export function buildWorleyWarp(): Graph {
  const warp = n('warp', { strength: 0.6, noiseType: 'simplex', srt_scale: 1.0 })
  const fbm = n('fbm', {
    srt_scale: 1.0,
    noiseType: 'worley2d',
    fractalMode: 'ridged',
    octaves: 3,
    lacunarity: 2.0,
    gain: 0.5,
  })
  const ramp = n('color_ramp', {
    interpolation: 'smooth',
    stops: [
      { position: 0.0, color: [0.14, 0.23, 0.42] },
      { position: 1.0, color: [0.3, 0.5, 1.0] },
    ],
  })
  const out = n('fragment_output', {})
  return {
    nodes: [warp, fbm, ramp, out],
    edges: [
      // warp used as a coordinate transform: warped(vec2) → fbm.coords
      e(warp, fbm, 'warped', 'coords', 'vec2'),
      e(fbm, ramp, 'value', 't', 'float'),
      e(ramp, out, 'color', 'color', 'color'),
    ],
  }
}

/** generator → Gaussian blur @max radius. radius is the cost knob. */
export function buildGaussian(opts?: { radius?: number }): Graph {
  const fbm = n('fbm', { srt_scale: 1.0, noiseType: 'simplex', octaves: 4 })
  const ramp = n('color_ramp', {
    interpolation: 'smooth',
    stops: [
      { position: 0.0, color: [0.02, 0.03, 0.05] },
      { position: 1.0, color: [0.9, 0.95, 1.0] },
    ],
  })
  const blur = n('blur', { radius: opts?.radius ?? 128 })
  const out = n('fragment_output', {})
  return {
    nodes: [fbm, ramp, blur, out],
    edges: [
      e(fbm, ramp, 'value', 't', 'float'),
      e(ramp, blur, 'color', 'source', 'color'),
      e(blur, out, 'color', 'color', 'color'),
    ],
  }
}

/** generator → Kawase blur @large radius — 5 fixed passes × 4 taps. */
export function buildKawase(opts?: { radius?: number }): Graph {
  const fbm = n('fbm', { srt_scale: 1.0, noiseType: 'simplex', octaves: 4 })
  const ramp = n('color_ramp', {
    interpolation: 'smooth',
    stops: [
      { position: 0.0, color: [0.02, 0.03, 0.05] },
      { position: 1.0, color: [0.9, 0.95, 1.0] },
    ],
  })
  // Kawase cost is CONSTANT in radius (fixed 5×4 taps), so radius is not a cost
  // knob — a large radius just makes the low-pass reach obvious. No cheap variant.
  const kawase = n('kawase_blur', { radius: opts?.radius ?? 200 })
  const out = n('fragment_output', {})
  return {
    nodes: [fbm, ramp, kawase, out],
    edges: [
      e(fbm, ramp, 'value', 't', 'float'),
      e(ramp, kawase, 'color', 'source', 'color'),
      e(kawase, out, 'color', 'color', 'color'),
    ],
  }
}

/** generator → reeded glass at max frost — heaviest single-pass gather. */
export function buildReededFrost(opts?: { frost?: number }): Graph {
  const fbm = n('fbm', { srt_scale: 1.0, noiseType: 'simplex', octaves: 4 })
  const ramp = n('color_ramp', {
    interpolation: 'smooth',
    stops: [
      { position: 0.0, color: [0.05, 0.08, 0.15] },
      { position: 1.0, color: [0.8, 0.9, 1.0] },
    ],
  })
  const reed = n('reeded_glass', {
    ribWidth: 80,
    ior: 1.5,
    curvature: 0.8,
    bow: 1,
    frost: opts?.frost ?? 1,
    direction: 'vertical',
    ribType: 'straight',
  })
  const out = n('fragment_output', {})
  return {
    nodes: [fbm, ramp, reed, out],
    edges: [
      e(fbm, ramp, 'value', 't', 'float'),
      e(ramp, reed, 'color', 'source', 'color'),
      e(reed, out, 'color', 'color', 'color'),
    ],
  }
}

/** generator → pyramid blur → up to 8 passes (pass-boundary churn). */
export function buildPyramidDeep(opts?: { radius?: number }): Graph {
  const fbm = n('fbm', { srt_scale: 1.0, noiseType: 'simplex', octaves: 4 })
  const ramp = n('color_ramp', {
    interpolation: 'smooth',
    stops: [
      { position: 0.0, color: [0.02, 0.03, 0.05] },
      { position: 1.0, color: [0.9, 0.95, 1.0] },
    ],
  })
  const pyr = n('pyramid_blur', { radius: opts?.radius ?? 128 })
  const out = n('fragment_output', {})
  return {
    nodes: [fbm, ramp, pyr, out],
    edges: [
      e(fbm, ramp, 'value', 't', 'float'),
      e(ramp, pyr, 'color', 'source', 'color'),
      e(pyr, out, 'color', 'color', 'color'),
    ],
  }
}

/** warp→fbm→ramp→gaussian→reeded — a realistic deep multi-pass chain. */
export function buildChainHeavy(): Graph {
  const warp = n('warp', { strength: 0.4, noiseType: 'simplex', srt_scale: 1.0 })
  const fbm = n('fbm', { srt_scale: 1.0, noiseType: 'simplex', octaves: 5 })
  const ramp = n('color_ramp', {
    interpolation: 'smooth',
    stops: [
      { position: 0.0, color: [0.05, 0.08, 0.15] },
      { position: 1.0, color: [0.85, 0.92, 1.0] },
    ],
  })
  const blur = n('blur', { radius: 48 })
  const reed = n('reeded_glass', { ribWidth: 80, ior: 1.5, frost: 0.6, direction: 'vertical' })
  const out = n('fragment_output', {})
  return {
    nodes: [warp, fbm, ramp, blur, reed, out],
    edges: [
      e(warp, fbm, 'warped', 'coords', 'vec2'),
      e(fbm, ramp, 'value', 't', 'float'),
      e(ramp, blur, 'color', 'source', 'color'),
      e(blur, reed, 'color', 'source', 'color'),
      e(reed, out, 'color', 'color', 'color'),
    ],
  }
}

// --- scene registry ---------------------------------------------------------
// Heavy/default builds only. Cheap cost-knob variants and expected pass counts
// live in the CLI harness (scripts/perf/lib/scenes.ts).

export const PERF_SCENES: PerfScene[] = [
  { id: 'passthrough', title: 'Passthrough', build: buildPassthrough },
  { id: 'fbm_single', title: 'FBM (8 oct)', build: () => buildFbmSingle() },
  { id: 'worley_warp', title: 'Worley + Warp', build: buildWorleyWarp },
  { id: 'gaussian_r', title: 'Gaussian blur (max radius)', build: () => buildGaussian() },
  { id: 'kawase_r', title: 'Kawase blur (large radius)', build: () => buildKawase() },
  { id: 'reeded_frost', title: 'Reeded frost', build: buildReededFrost },
  { id: 'pyramid_deep', title: 'Pyramid (deep)', build: buildPyramidDeep },
  { id: 'chain_heavy', title: 'Chain (heavy)', build: buildChainHeavy },
]
