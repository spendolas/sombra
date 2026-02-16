/**
 * Time node - provides the current time in seconds
 */

import type { NodeDefinition } from '../types'

export const timeNode: NodeDefinition = {
  type: 'time',
  label: 'Time',
  category: 'Input',
  description: 'Current time in seconds since start',

  inputs: [],

  outputs: [
    {
      id: 'time',
      label: 'Time',
      type: 'float',
    },
  ],

  glsl: (ctx) => {
    const { outputs, uniforms } = ctx
    uniforms.add('u_time')
    return `float ${outputs.time} = u_time;`
  },
}
