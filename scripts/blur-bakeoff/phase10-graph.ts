/**
 * Phase 10 — build a `image -> reeded_glass -> fragment_output` graph and hand the
 * compiler's OWN emitted WGSL to the phase-10 rig. No re-implementation of the
 * lens anywhere in the bench: whatever the node emits is what runs.
 */

import { initializeNodeLibrary } from '../../src/nodes'
import { compileGraph } from '../../src/compiler/glsl-generator'
import { compileGraphIR } from '../../src/compiler/ir-compiler'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../../src/nodes/types'
import type { WgslPass } from './phase10-rig'

let initialized = false
export function initNodes(): void {
  if (!initialized) { initializeNodeLibrary(); initialized = true }
}

export interface ReededConfig {
  ribWidth?: number
  ior?: number
  curvature?: number
  bow?: number
  frost?: number
  direction?: 'vertical' | 'horizontal'
  ribType?: 'straight' | 'wave' | 'circular' | 'noise'
  waveShape?: string
  noiseType?: string
  amplitude?: number
  wavelength?: number
  srt_scale?: number
  srt_rotate?: number
  srt_translateX?: number
  srt_translateY?: number
}

export interface BuiltGraph {
  passes: WgslPass[]
  /** sampler name the image node uses — bind the source photo/stimulus here */
  imageSampler: string
  glslFragmentShaders: string[]
}

/** Sampler name for the image node id used below (mirrors imageSamplerName()). */
export const IMAGE_SAMPLER = 'u_img_image'

/**
 * imageAspect must match the stimulus, or the image node's fit maths rescales it
 * and the "identity at ior=1" control stops being an identity.
 */
export function buildReededGraph(cfg: ReededConfig, imageAspect: number, opts?: { bypass?: boolean }): BuiltGraph {
  initNodes()

  const nodes: Node<NodeData>[] = [
    { id: 'img', type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: 'image', params: { imageData: 'x', imageAspect, fitMode: 'contain' } } },
    { id: 'rg', type: 'shaderNode', position: { x: 1, y: 0 }, data: { type: 'reeded_glass', params: { ...cfg } as Record<string, unknown> } },
    { id: 'out', type: 'shaderNode', position: { x: 2, y: 0 }, data: { type: 'fragment_output', params: {} } },
  ]
  const edge = (s: string, t: string, sh: string, th: string): Edge<EdgeData> => ({
    id: `${s}-${sh}-${t}-${th}`, source: s, target: t, sourceHandle: sh, targetHandle: th,
    type: 'typed', data: { sourcePort: sh, targetPort: th, sourcePortType: 'color' },
  })
  const edges: Edge<EdgeData>[] = opts?.bypass
    ? [edge('img', 'out', 'color', 'color')]
    : [edge('img', 'rg', 'color', 'source'), edge('rg', 'out', 'color', 'color')]
  const useNodes = opts?.bypass ? [nodes[0], nodes[2]] : nodes

  const glsl = compileGraph(useNodes, edges)
  if (!glsl.success) throw new Error(`GLSL compile failed: ${glsl.errors.map(e => e.message).join('; ')}`)
  const ir = compileGraphIR(useNodes, edges)
  if (!ir) throw new Error('IR compile returned null')
  if (ir.passes.length !== glsl.passes.length) {
    throw new Error(`pass count mismatch: glsl ${glsl.passes.length} vs wgsl ${ir.passes.length}`)
  }

  const passes: WgslPass[] = ir.passes.map((p, i) => ({
    shaderCode: p.shaderCode,
    uniformOffsets: Object.fromEntries(p.uniformLayout.offsets),
    uniformTotalSize: p.uniformLayout.totalSize,
    textureBindings: p.textureBindings,
    inputTextures: p.inputTextures,
    userUniforms: glsl.passes[i].userUniforms.map(u => ({ name: u.name, glslType: u.glslType, value: u.value })),
    filter: p.textureFilter,
  }))

  return { passes, imageSampler: IMAGE_SAMPLER, glslFragmentShaders: glsl.passes.map(p => p.fragmentShader) }
}
