/**
 * Warp — Distorts coordinates using a selectable noise function.
 */

import type { NodeDefinition, SpatialConfig } from '../types'
import { getSpatialParams } from '../types'
import { NOISE_TYPE_OPTIONS, resolveNoiseFn, registerNoiseType } from '../noise/noise-functions'

const EDGE_OPTIONS = [
  { value: 'clamp', label: 'Clamp' },
  { value: 'repeat', label: 'Repeat' },
  { value: 'mirror', label: 'Mirror' },
]

export const warpNode: NodeDefinition = {
  type: 'warp',
  label: 'Warp',
  category: 'Distort',
  description: 'Distorts coordinates using noise for organic warping effects',
  spatial: { transforms: ['scale', 'translate'] } satisfies SpatialConfig,

  inputs: [
    { id: 'source', label: 'Source', type: 'vec3', textureInput: true, default: [0, 0, 0] },
    { id: 'coords', label: 'Coords', type: 'vec2', default: 'auto_uv' },
    { id: 'phase', label: 'Phase', type: 'float', default: 0.0 },
  ],

  outputs: [
    { id: 'color', label: 'Color', type: 'vec3' },
    { id: 'warped', label: 'Warped', type: 'vec2' },
    { id: 'warpedPhase', label: 'Warped Phase', type: 'float' },
  ],

  params: [
    ...getSpatialParams({ transforms: ['scale', 'translate'] }),
    {
      id: 'noiseType', label: 'Noise Type', type: 'enum', default: 'value',
      options: NOISE_TYPE_OPTIONS, updateMode: 'recompile',
    },
    { id: 'strength', label: 'Strength', type: 'float', default: 0.3, min: 0.0, max: 10.0, step: 0.01, connectable: true, updateMode: 'uniform' },
    { id: 'seed', label: 'Seed', type: 'float', default: 12345, min: 0, max: 99999, step: 1, connectable: true, updateMode: 'uniform' },
    {
      id: 'warpDepth', label: 'Depth', type: 'enum', default: '2',
      options: [
        { value: '2', label: 'Standard (2 samples)' },
        { value: '3', label: 'Deep (3 samples)' },
      ],
      updateMode: 'recompile',
    },
    {
      id: 'edge', label: 'Edge', type: 'enum', default: 'clamp',
      options: EDGE_OPTIONS, updateMode: 'recompile',
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, params } = ctx
    const noiseType = (params.noiseType as string) || 'value'
    const noiseFn = resolveNoiseFn(noiseType)
    const warpDepth = (params.warpDepth as string) || '2'
    const edge = (params.edge as string) || 'clamp'

    // Register GLSL functions for the selected noise type
    registerNoiseType(ctx, noiseType)

    const prefix = outputs.warped
    const id = ctx.nodeId.replace(/-/g, '_')
    const seedOff = `dw_soff_${id}`
    const sc = `dw_sc_${id}`
    const lines = [
      `vec2 ${seedOff} = fract(vec2(${inputs.seed}) * vec2(12.9898, 78.233)) * 1000.0;`,
      `vec2 ${sc} = ${inputs.coords} + ${seedOff};`,
      `float ${prefix}_x = ${noiseFn}(vec3(${sc}, ${inputs.phase})) * 2.0 - 1.0;`,
      `float ${prefix}_y = ${noiseFn}(vec3(${sc} + 100.0, ${inputs.phase})) * 2.0 - 1.0;`,
    ]

    if (warpDepth === '3') {
      lines.push(
        `float ${prefix}_z = ${noiseFn}(vec3(${sc} + 73.156, ${inputs.phase} + 9.151)) * 2.0 - 1.0;`,
      )
    }

    lines.push(
      `vec2 ${outputs.warped} = ${inputs.coords} + vec2(${prefix}_x, ${prefix}_y) * ${inputs.strength};`,
      warpDepth === '3'
        ? `float ${outputs.warpedPhase} = ${inputs.phase} + ${prefix}_z * ${inputs.strength};`
        : `float ${outputs.warpedPhase} = ${inputs.phase};`,
    )

    // Color output — texture mode (source wired) vs UV gradient fallback
    const samplerName = ctx.textureSamplers?.source
    if (samplerName) {
      // Apply edge wrapping before texture sampling
      const edgeUV = `dw_edge_${id}`
      if (edge === 'repeat') {
        lines.push(`vec2 ${edgeUV} = fract(${outputs.warped});`)
      } else if (edge === 'mirror') {
        lines.push(`vec2 ${edgeUV} = vec2(`)
        lines.push(`  mod(${outputs.warped}.x, 2.0) < 1.0 ? fract(${outputs.warped}.x) : 1.0 - fract(${outputs.warped}.x),`)
        lines.push(`  mod(${outputs.warped}.y, 2.0) < 1.0 ? fract(${outputs.warped}.y) : 1.0 - fract(${outputs.warped}.y)`)
        lines.push(`);`)
      } else {
        lines.push(`vec2 ${edgeUV} = clamp(${outputs.warped}, 0.0, 1.0);`)
      }
      lines.push(`vec3 ${outputs.color} = texture(${samplerName}, ${edgeUV}).rgb;`)
    } else {
      // No source — show warped UV as gradient to visualize distortion
      lines.push(`vec3 ${outputs.color} = vec3(${outputs.warped}, 0.5);`)
    }

    return lines.join('\n  ')
  },
}
