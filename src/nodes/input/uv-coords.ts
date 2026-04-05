/**
 * UV Transform node - SRT transform for UV coordinates
 * When unconnected, generates aspect-corrected UVs (same as auto_uv).
 * When wired, transforms incoming coordinates (e.g. from Quantize UV).
 */

import type { NodeDefinition, SpatialConfig } from '../types'
import { getSpatialParams } from '../types'
import { variable, declare } from '../../compiler/ir/types'

export const uvCoordsNode: NodeDefinition = {
  type: 'uv_transform',
  label: 'UV Transform',
  category: 'Input',
  description: 'Scale, rotate, and translate UV coordinates',
  spatial: { transforms: ['scaleXY', 'rotate', 'translate'] } satisfies SpatialConfig,

  inputs: [
    { id: 'coords', label: 'Coords', type: 'vec2', default: 'auto_uv' },
  ],

  outputs: [
    {
      id: 'uv',
      label: 'UV',
      type: 'vec2',
    },
  ],

  params: [
    ...getSpatialParams({ transforms: ['scaleXY', 'rotate', 'translate'] }),
  ],

  glsl: (ctx) => {
    const { outputs, inputs } = ctx
    return `vec2 ${outputs.uv} = ${inputs.coords};`
  },

  ir: (ctx) => ({
    statements: [
      declare(ctx.outputs.uv, 'vec2', variable(ctx.inputs.coords)),
    ],
    uniforms: [],
    standardUniforms: new Set(),
  }),
}
