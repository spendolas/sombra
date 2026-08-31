/**
 * Benchmark scenes — purpose-built graphs that exercise the heavy nodes the
 * existing presets don't (multi-pass blur, reeded frost, pyramid chains, deep
 * fbm). Each builder returns `{nodes, edges}`; `compileScene` compiles it on
 * BOTH backends (GLSL→WebGL2 and IR→WGSL) and maps the output into the rig's
 * per-pass shape, reusing the exact mapping from phase10-graph.ts.
 *
 * Node types / port ids / param ids are taken from the real node definitions in
 * src/nodes (fbm.ts, warp.ts, effect/blur.ts, effect/pyramid-blur.ts,
 * reeded-glass.ts) — not guessed. See STEP-0 notes in the perf plan.
 */

import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../../../src/nodes/types'
import { initializeNodeLibrary } from '../../../src/nodes'
import { compileGraph } from '../../../src/compiler/glsl-generator'
import { compileGraphIR } from '../../../src/compiler/ir-compiler'
import type { PerfPass } from './perf-rig'

let initialized = false
function initNodes(): void {
  if (!initialized) {
    initializeNodeLibrary()
    initialized = true
  }
}

export interface Graph {
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
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

// --- scene graph builders ---------------------------------------------------
// Each returns a fresh graph. `opts` carries the cost knob a scene's cheap
// variant flips (the cost-monotonicity gate), so the heavy and cheap graphs
// share one builder and differ only in that knob.

/** output/UV only — the harness floor. */
function buildPassthrough(): Graph {
  const uv = n('uv_transform', {})
  const out = n('fragment_output', {})
  return { nodes: [uv, out], edges: [e(uv, out, 'uv', 'color', 'vec2')] }
}

/** fbm simplex, single ALU-heavy pass. octaves is the cost knob. */
function buildFbmSingle(opts?: { octaves?: number }): Graph {
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
function buildWorleyWarp(): Graph {
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
function buildGaussian(opts?: { radius?: number }): Graph {
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

/** generator → reeded glass at max frost — heaviest single-pass gather. */
function buildReededFrost(opts?: { frost?: number }): Graph {
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
function buildPyramidDeep(opts?: { radius?: number }): Graph {
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
function buildChainHeavy(): Graph {
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

export interface SceneDef {
  id: string
  description: string
  /** Expected pass count (both backends must agree with this). */
  expectedPasses: number
  build: () => Graph
  /**
   * Optional cheaper variant for the cost-monotonicity gate. The heavy build
   * must cost strictly more GPU time than this — proving the cost knob (blur
   * radius, fbm octaves) actually reaches the shader.
   */
  cheap?: () => Graph
}

export const SCENES: SceneDef[] = [
  { id: 'passthrough', description: 'output/UV only — harness floor', expectedPasses: 1, build: buildPassthrough },
  {
    id: 'fbm_single',
    description: 'fbm @8 octaves simplex — ALU-bound single pass',
    expectedPasses: 1,
    build: () => buildFbmSingle(),
    cheap: () => buildFbmSingle({ octaves: 1 }),
  },
  { id: 'worley_warp', description: 'warp→worley — nested-noise ALU', expectedPasses: 1, build: buildWorleyWarp },
  {
    id: 'gaussian_r',
    description: 'Gaussian blur @max radius — ~343 fetches/pass, bandwidth',
    expectedPasses: 3,
    build: () => buildGaussian(),
    cheap: () => buildGaussian({ radius: 1 }),
  },
  { id: 'reeded_frost', description: 'reeded_glass frost=max — heaviest single-pass fetch', expectedPasses: 2, build: buildReededFrost },
  { id: 'pyramid_deep', description: 'generator→pyramid_blur — deep pass chain (pass-boundary churn)', expectedPasses: 9, build: buildPyramidDeep },
  { id: 'chain_heavy', description: 'warp→fbm→gaussian→reeded — deep multi-pass chain', expectedPasses: 4, build: buildChainHeavy },
]

export function getScene(id: string): SceneDef {
  const s = SCENES.find((x) => x.id === id)
  if (!s) throw new Error(`unknown scene "${id}" (known: ${SCENES.map((x) => x.id).join(', ')})`)
  return s
}

// --- compilation ------------------------------------------------------------

export interface CompiledScene {
  passCount: number
  /** Per-pass shape consumed by the rig (both backends' text in each pass). */
  passes: PerfPass[]
}

/**
 * Compile a graph on both backends and map to the rig's PerfPass[] shape.
 * Mirrors phase10-graph.ts / phase10-reed-aa.ts buildGraph mapping exactly.
 */
export function compileScene(graph: Graph): CompiledScene {
  initNodes()
  const glsl = compileGraph(graph.nodes, graph.edges)
  if (!glsl.success) {
    throw new Error(`GLSL compile failed: ${glsl.errors.map((x) => x.message).join('; ')}`)
  }
  const ir = compileGraphIR(graph.nodes, graph.edges)
  if (!ir) throw new Error('IR compile returned null')
  if (ir.passes.length !== glsl.passes.length) {
    throw new Error(`pass count mismatch: glsl ${glsl.passes.length} vs wgsl ${ir.passes.length}`)
  }

  const passes: PerfPass[] = ir.passes.map((p, i) => ({
    wgsl: p.shaderCode,
    glslFrag: glsl.passes[i].fragmentShader,
    glslVert: glsl.passes[i].vertexShader,
    uniformOffsets: Object.fromEntries(p.uniformLayout.offsets),
    uniformTotalSize: p.uniformLayout.totalSize,
    textureBindings: p.textureBindings,
    inputTextures: p.inputTextures,
    userUniforms: glsl.passes[i].userUniforms.map((u) => ({ name: u.name, glslType: u.glslType, value: u.value })),
    filter: p.textureFilter,
  }))

  return { passCount: passes.length, passes }
}
