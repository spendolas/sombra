/**
 * Unified Noise Node — simplex, value, worley, or box via dropdown.
 * Outputs: value (float, sampled).
 */

import type { NodeDefinition, SpatialConfig } from '../types'
import { getSpatialParams } from '../types'
import { NOISE_TYPE_OPTIONS, resolveNoiseFn, registerNoiseType, getIRNoiseFunctions } from './noise-functions'
import { variable, call, declare, construct, raw, binary } from '../../compiler/ir/types'
import type { IRFunction } from '../../compiler/ir/types'

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

    // Value and box noise use floor(p)/fract(p) — scale 4x to match simplex feature density
    const needsFreqNorm = noiseType === 'value' || noiseType === 'box'
    const coordExpr = needsFreqNorm
      ? `vec3(${sc}, ${inputs.phase}) * 4.0`
      : `vec3(${sc}, ${inputs.phase})`

    return `${seedLine}\n  ${coordsLine}\n  float ${outputs.value} = ${noiseFn}(${coordExpr});`
  },

  ir: (ctx) => {
    const noiseType = (ctx.params.noiseType as string) || 'simplex'
    const noiseFn = resolveNoiseFn(noiseType)
    const id = ctx.nodeId.replace(/-/g, '_')
    const seedOff = `n_soff_${id}`
    const sc = `n_sc_${id}`

    const functions: IRFunction[] = getIRNoiseFunctions(noiseType)

    // Seed offset preamble (shared pattern with FBM)
    const preamble = raw(
      `vec2 ${seedOff} = fract(vec2(${ctx.inputs.seed}) * vec2(12.9898, 78.233)) * 1000.0;\n` +
      `vec2 ${sc} = ${ctx.inputs.coords} + ${seedOff};`,
    )

    // Value and box noise use floor(p)/fract(p) — scale 4x to match simplex feature density
    const needsFreqNorm = noiseType === 'value' || noiseType === 'box'
    const coordExpr = needsFreqNorm
      ? binary('*',
          construct('vec3', [variable(sc), variable(ctx.inputs.phase)]),
          { kind: 'literal' as const, type: 'float' as const, value: 4.0 },
          'vec3',
        )
      : construct('vec3', [variable(sc), variable(ctx.inputs.phase)])

    return {
      statements: [
        preamble,
        declare(ctx.outputs.value, 'float',
          call(noiseFn, [coordExpr], 'float'),
        ),
      ],
      uniforms: [],
      standardUniforms: new Set<string>(),
      functions,
    }
  },
}
