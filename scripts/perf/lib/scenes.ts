/**
 * Benchmark scenes — CLI harness wrapper around the shared graph builders in
 * `src/perf/scenes.ts` (the single source of truth also used by the in-app perf
 * view). The graphs themselves live there; this file drives them: compiling
 * each on BOTH backends (GLSL→WebGL2 and IR→WGSL) with agreement assertions,
 * mapping the output into the rig's per-pass shape, and defining cheaper cost-
 * knob variants for the cost-monotonicity gate.
 */

import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../../../src/nodes/types'
import { initializeNodeLibrary } from '../../../src/nodes'
import { compileGraph } from '../../../src/compiler/glsl-generator'
import { compileGraphIR } from '../../../src/compiler/ir-compiler'
import { PERF_SCENES, buildFbmSingle, buildGaussian } from '../../../src/perf/scenes'
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

/**
 * CLI-only per-scene metadata (expected pass count + cheap cost-knob variant),
 * keyed by the shared scene id. The heavy `build()` comes from PERF_SCENES so
 * the graphs stay DRY with the in-app view.
 */
const SCENE_META: Record<string, { description: string; expectedPasses: number; cheap?: () => Graph }> = {
  passthrough: { description: 'output/UV only — harness floor', expectedPasses: 1 },
  fbm_single: {
    description: 'fbm @8 octaves simplex — ALU-bound single pass',
    expectedPasses: 1,
    cheap: () => buildFbmSingle({ octaves: 1 }),
  },
  worley_warp: { description: 'warp→worley — nested-noise ALU', expectedPasses: 1 },
  gaussian_r: {
    description: 'Gaussian blur @max radius — ~343 fetches/pass, bandwidth',
    expectedPasses: 3,
    cheap: () => buildGaussian({ radius: 1 }),
  },
  reeded_frost: { description: 'reeded_glass frost=max — heaviest single-pass fetch', expectedPasses: 2 },
  pyramid_deep: { description: 'generator→pyramid_blur — deep pass chain (pass-boundary churn)', expectedPasses: 9 },
  chain_heavy: { description: 'warp→fbm→gaussian→reeded — deep multi-pass chain', expectedPasses: 4 },
}

export const SCENES: SceneDef[] = PERF_SCENES.map((scene) => {
  const meta = SCENE_META[scene.id]
  if (!meta) throw new Error(`no CLI metadata for perf scene "${scene.id}"`)
  return {
    id: scene.id,
    description: meta.description,
    expectedPasses: meta.expectedPasses,
    build: scene.build,
    cheap: meta.cheap,
  }
})

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
  for (let i = 0; i < ir.passes.length; i++) {
    if ((ir.passes[i].resolution ?? 1) !== (glsl.passes[i].resolution ?? 1)) {
      throw new Error(`pass ${i} resolution mismatch: glsl ${glsl.passes[i].resolution} vs wgsl ${ir.passes[i].resolution}`)
    }
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
    // Per-pass fractional rasterisation scale (RenderPass.resolution). Both
    // backends resolve it identically via pass-resolution.ts; assert they agree
    // so the rig can't measure a WGSL/GLSL geometry mismatch as a "win".
    resolution: p.resolution,
  }))

  return { passCount: passes.length, passes }
}
