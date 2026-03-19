/**
 * Unified Noise Node — simplex, value, worley, or box via dropdown.
 * Outputs: value (float, sampled).
 */

import type { NodeDefinition, SpatialConfig } from '../types'
import { getSpatialParams } from '../types'
import { NOISE_TYPE_OPTIONS, resolveNoiseFn, registerNoiseType } from './noise-functions'

export const noiseNode: NodeDefinition = {
  type: 'noise',
  label: 'Noise',
  category: 'Noise',
  description: 'Configurable noise — simplex, value, worley (2D/3D), or box',
  spatial: { transforms: ['scale', 'translate'] } satisfies SpatialConfig,

  inputs: [
    { id: 'coords', label: 'Coords', type: 'vec2', default: 'auto_uv' },
    { id: 'phase', label: 'Phase', type: 'float', default: 0.0 },
  ],

  outputs: [
    { id: 'value', label: 'Value', type: 'float' },
  ],

  params: [
    ...getSpatialParams({ transforms: ['scale', 'translate'] }),
    {
      id: 'noiseType', label: 'Type', type: 'enum', default: 'simplex',
      options: NOISE_TYPE_OPTIONS, updateMode: 'recompile',
    },
    { id: 'boxFreq', label: 'Box Freq', type: 'float', default: 1.0, min: 0.5, max: 256.0, step: 0.5, connectable: true, showWhen: { noiseType: 'box' }, updateMode: 'uniform' },
    { id: 'seed', label: 'Seed', type: 'float', default: 12345, min: 0, max: 99999, step: 1, connectable: true, updateMode: 'uniform' },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, params } = ctx
    const noiseType = (params.noiseType as string) || 'simplex'
    const noiseFn = resolveNoiseFn(noiseType)

    // Register GLSL functions for the selected noise type
    registerNoiseType(ctx, noiseType)

    const id = ctx.nodeId.replace(/-/g, '_')
    const seedOff = `n_soff_${id}`
    const sc = `n_sc_${id}`
    const seedLine = `vec2 ${seedOff} = fract(vec2(${inputs.seed}) * vec2(12.9898, 78.233)) * 1000.0;`
    const coordsLine = `vec2 ${sc} = ${inputs.coords} + ${seedOff};`

    if (noiseType === 'box') {
      const bf = inputs.boxFreq
      return `${seedLine}\n  ${coordsLine}\n  float ${outputs.value} = vnoise3d(floor(vec3(${sc}, ${inputs.phase}) * ${bf}) / ${bf});`
    }

    return `${seedLine}\n  ${coordsLine}\n  float ${outputs.value} = ${noiseFn}(vec3(${sc}, ${inputs.phase}));`
  },
}
