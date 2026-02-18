/**
 * Vec2 Constant node - Output a constant 2D vector value
 */

import type { NodeDefinition } from '../types'

function formatFloat(v: unknown): string {
  const n = typeof v === 'number' ? v : 0.0
  return Number.isInteger(n) ? `${n}.0` : `${n}`
}

export const vec2ConstantNode: NodeDefinition = {
  type: 'vec2_constant',
  label: 'Vec2',
  category: 'Input',
  description: 'Constant 2D vector value',

  inputs: [],

  outputs: [
    {
      id: 'value',
      label: 'Value',
      type: 'vec2',
    },
  ],

  params: [
    { id: 'x', label: 'X', type: 'float', default: 0.0, min: -10.0, max: 10.0, step: 0.01 },
    { id: 'y', label: 'Y', type: 'float', default: 0.0, min: -10.0, max: 10.0, step: 0.01 },
  ],

  glsl: (ctx) => {
    const { outputs, params } = ctx
    const x = params.x !== undefined ? params.x : 0.0
    const y = params.y !== undefined ? params.y : 0.0
    return `vec2 ${outputs.value} = vec2(${formatFloat(x)}, ${formatFloat(y)});`
  },
}
