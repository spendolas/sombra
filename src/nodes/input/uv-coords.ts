/**
 * UV Coordinates node - provides fragment UV coordinates (0-1)
 * with optional Scale/Rotate/Translate transform (Redshift-style)
 */

import type { NodeDefinition } from '../types'

export const uvCoordsNode: NodeDefinition = {
  type: 'uv_coords',
  label: 'UV Coordinates',
  category: 'Input',
  description: 'UV coordinates with optional SRT transform',

  inputs: [],

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
    const { outputs, inputs, uniforms } = ctx
    uniforms.add('u_resolution')
    uniforms.add('u_ref_size')
    const c = `${outputs.uv}_c`
    const s = `${outputs.uv}_s`
    return `vec2 ${outputs.uv} = (v_uv - 0.5) * u_resolution / u_ref_size + 0.5;
${outputs.uv} -= 0.5;
${outputs.uv} *= vec2(${inputs.scaleX}, ${inputs.scaleY});
float ${c} = cos(${inputs.rotate});
float ${s} = sin(${inputs.rotate});
${outputs.uv} = vec2(${outputs.uv}.x * ${c} - ${outputs.uv}.y * ${s}, ${outputs.uv}.x * ${s} + ${outputs.uv}.y * ${c});
${outputs.uv} += vec2(${inputs.offsetX}, ${inputs.offsetY}) + 0.5;`
  },
}
