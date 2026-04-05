/**
 * Time node - provides the current time in seconds
 */

import type { NodeDefinition } from '../types'
import { variable, binary, declare } from '../../compiler/ir/types'

export const timeNode: NodeDefinition = {
  type: 'time',
  label: 'Time',
  category: 'Input',
  description: 'Current time in seconds since start',
  hidePreview: true,

  inputs: [],

  outputs: [
    {
      id: 'time',
      label: 'Time',
      type: 'float',
    },
  ],

  params: [
    {
      id: 'speed',
      label: 'Speed',
      type: 'float',
      default: 1.0,
      min: 0,
      max: 2,
      step: 0.001,
      connectable: true,
      updateMode: 'uniform',
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, uniforms } = ctx
    uniforms.add('u_time')
    return `float ${outputs.time} = u_time * ${inputs.speed};`
  },

  ir: (ctx) => ({
    statements: [
      declare(ctx.outputs.time, 'float',
        binary('*', variable('u_time'), variable(ctx.inputs.speed), 'float'),
      ),
    ],
    uniforms: [],
    standardUniforms: new Set(['u_time']),
  }),
}
