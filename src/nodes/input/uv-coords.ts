/**
 * UV Transform node - SRT transform for UV coordinates
 * When unconnected, generates frozen-ref UVs (same as auto_uv).
 * When wired, transforms incoming coordinates (e.g. from Quantize UV).
 */

import type { NodeDefinition } from '../types'

export const uvCoordsNode: NodeDefinition = {
  type: 'uv_transform',
  label: 'UV Transform',
  category: 'Input',
  description: 'Scale, rotate, and translate UV coordinates',

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
    { id: 'scaleX', label: 'Scale X', type: 'float', default: 1.0, min: 0.01, max: 10.0, step: 0.01, connectable: true },
    { id: 'scaleY', label: 'Scale Y', type: 'float', default: 1.0, min: 0.01, max: 10.0, step: 0.01, connectable: true },
    { id: 'rotate', label: 'Rotate', type: 'float', default: 0.0, min: -6.2832, max: 6.2832, step: 0.01, connectable: true },
    { id: 'offsetX', label: 'Offset X', type: 'float', default: 0.0, min: -10.0, max: 10.0, step: 0.01, connectable: true },
    { id: 'offsetY', label: 'Offset Y', type: 'float', default: 0.0, min: -10.0, max: 10.0, step: 0.01, connectable: true },
  ],

  glsl: (ctx) => {
    const { outputs, inputs } = ctx
    const c = `${outputs.uv}_c`
    const s = `${outputs.uv}_s`
    return `vec2 ${outputs.uv} = ${inputs.coords};
${outputs.uv} -= 0.5;
${outputs.uv} *= vec2(${inputs.scaleX}, ${inputs.scaleY});
float ${c} = cos(${inputs.rotate});
float ${s} = sin(${inputs.rotate});
${outputs.uv} = vec2(${outputs.uv}.x * ${c} - ${outputs.uv}.y * ${s}, ${outputs.uv}.x * ${s} + ${outputs.uv}.y * ${c});
${outputs.uv} += vec2(${inputs.offsetX}, ${inputs.offsetY}) + 0.5;`
  },
}
