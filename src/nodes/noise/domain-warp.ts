/**
 * Domain Warp - Distorts coordinates using a selectable noise function.
 */

import type { NodeDefinition } from '../types'
import { NOISE_TYPE_OPTIONS, resolveNoiseFn, registerNoiseType } from './noise-functions'

export const domainWarpNode: NodeDefinition = {
  type: 'warp_uv',
  label: 'Warp UV',
  category: 'Transform',
  description: 'Distorts UV coordinates using noise for organic warping effects',

  inputs: [
    { id: 'coords', label: 'Coords', type: 'vec2', default: 'auto_uv' },
    { id: 'phase', label: 'Phase', type: 'float', default: 0.0 },
  ],

  outputs: [
    { id: 'warped', label: 'Warped', type: 'vec2' },
    { id: 'warpedPhase', label: 'Warped Phase', type: 'float' },
  ],

  params: [
    {
      id: 'noiseType', label: 'Noise Type', type: 'enum', default: 'value',
      options: NOISE_TYPE_OPTIONS, updateMode: 'recompile',
    },
    { id: 'strength', label: 'Strength', type: 'float', default: 0.3, min: 0.0, max: 10.0, step: 0.01, connectable: true, updateMode: 'uniform' },
    { id: 'frequency', label: 'Frequency', type: 'float', default: 4.0, min: 0.1, max: 20.0, step: 0.1, connectable: true, updateMode: 'uniform' },
    { id: 'seed', label: 'Seed', type: 'float', default: 12345, min: 0, max: 99999, step: 1, connectable: true, updateMode: 'uniform' },
    {
      id: 'warpDepth', label: 'Depth', type: 'enum', default: '2',
      options: [
        { value: '2', label: 'Standard (2 samples)' },
        { value: '3', label: 'Deep (3 samples)' },
      ],
      updateMode: 'recompile',
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, params } = ctx
    const noiseType = (params.noiseType as string) || 'value'
    const noiseFn = resolveNoiseFn(noiseType)
    const warpDepth = (params.warpDepth as string) || '2'

    // Register GLSL functions for the selected noise type
    registerNoiseType(ctx, noiseType)

    const prefix = outputs.warped
    const id = ctx.nodeId.replace(/-/g, '_')
    const seedOff = `dw_soff_${id}`
    const sc = `dw_sc_${id}`
    const lines = [
      `vec2 ${seedOff} = fract(vec2(${inputs.seed}) * vec2(12.9898, 78.233)) * 1000.0;`,
      `vec2 ${sc} = ${inputs.coords} + ${seedOff};`,
      `float ${prefix}_x = ${noiseFn}(vec3(${sc} * ${inputs.frequency}, ${inputs.phase})) * 2.0 - 1.0;`,
      `float ${prefix}_y = ${noiseFn}(vec3(${sc} * ${inputs.frequency} + 100.0, ${inputs.phase})) * 2.0 - 1.0;`,
    ]

    if (warpDepth === '3') {
      lines.push(
        `float ${prefix}_z = ${noiseFn}(vec3(${sc} * ${inputs.frequency} + 73.156, ${inputs.phase} + 9.151)) * 2.0 - 1.0;`,
      )
    }

    lines.push(
      `vec2 ${outputs.warped} = ${inputs.coords} + vec2(${prefix}_x, ${prefix}_y) * ${inputs.strength};`,
      warpDepth === '3'
        ? `float ${outputs.warpedPhase} = ${inputs.phase} + ${prefix}_z * ${inputs.strength};`
        : `float ${outputs.warpedPhase} = ${inputs.phase};`,
    )

    return lines.join('\n  ')
  },
}
