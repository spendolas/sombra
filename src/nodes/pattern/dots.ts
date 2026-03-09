/**
 * Dots — regular grid of circles with adjustable radius and edge softness.
 */

import type { NodeDefinition } from '../types'

export const dotsNode: NodeDefinition = {
  type: 'dots',
  label: 'Dots',
  category: 'Pattern',
  description: 'Grid of circles — adjustable radius and softness',

  inputs: [
    { id: 'coords', label: 'Coords', type: 'vec2', default: 'auto_uv' },
  ],

  outputs: [
    { id: 'value', label: 'Value', type: 'float' },
  ],

  params: [
    { id: 'scale', label: 'Scale', type: 'float', default: 8.0, min: 1.0, max: 64.0, step: 0.5, connectable: true, updateMode: 'uniform' },
    { id: 'radius', label: 'Radius', type: 'float', default: 0.3, min: 0.01, max: 0.5, step: 0.01, connectable: true, updateMode: 'uniform' },
    { id: 'softness', label: 'Softness', type: 'float', default: 0.05, min: 0.0, max: 0.5, step: 0.01, connectable: true, updateMode: 'uniform' },
  ],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    const id = ctx.nodeId.replace(/-/g, '_')
    const sc = `dt_sc_${id}`
    const cell = `dt_cell_${id}`
    const d = `dt_d_${id}`
    return [
      `vec2 ${sc} = ${inputs.coords} * ${inputs.scale};`,
      `vec2 ${cell} = fract(${sc}) - 0.5;`,
      `float ${d} = length(${cell});`,
      `float ${outputs.value} = 1.0 - smoothstep(${inputs.radius} - ${inputs.softness}, ${inputs.radius} + ${inputs.softness}, ${d});`,
    ].join('\n  ')
  },
}
