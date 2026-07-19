/**
 * Remap node - Map value from one range to another
 * Useful for normalizing or scaling values
 */

import type { NodeDefinition } from '../types'
import { variable, binary, declare } from '../../compiler/ir/types'

export const remapNode: NodeDefinition = {
  type: 'remap',
  label: 'Remap',
  category: 'Math',
  description: 'Remap value from input range to output range',
  conditionalPreview: true,

  inputs: [
    {
      id: 'value',
      label: 'Value',
      type: 'float',
      default: 0.5,
    },
  ],

  outputs: [
    {
      id: 'result',
      label: 'Result',
      type: 'float',
    },
  ],

  // Range values are connectable uniform params (handle + inline slider), like
  // clamp/power — tweakable without wiring a Constant, and no recompile on drag.
  // Matches the Figma Remap template (4 connectable params). Read via ctx.inputs.
  params: [
    { id: 'inMin', label: 'In Min', type: 'float', default: 0.0, min: -2, max: 2, step: 0.01, connectable: true, updateMode: 'uniform' },
    { id: 'inMax', label: 'In Max', type: 'float', default: 1.0, min: -2, max: 2, step: 0.01, connectable: true, updateMode: 'uniform' },
    { id: 'outMin', label: 'Out Min', type: 'float', default: 0.0, min: -2, max: 2, step: 0.01, connectable: true, updateMode: 'uniform' },
    { id: 'outMax', label: 'Out Max', type: 'float', default: 1.0, min: -2, max: 2, step: 0.01, connectable: true, updateMode: 'uniform' },
  ],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    // Remap formula: outMin + (value - inMin) * (outMax - outMin) / (inMax - inMin)
    return `float ${outputs.result} = ${inputs.outMin} + (${inputs.value} - ${inputs.inMin}) * (${inputs.outMax} - ${inputs.outMin}) / (${inputs.inMax} - ${inputs.inMin});`
  },

  ir: (ctx) => {
    // outMin + (value - inMin) * (outMax - outMin) / (inMax - inMin)
    const valueSub = binary('-', variable(ctx.inputs.value), variable(ctx.inputs.inMin), 'float')
    const outRange = binary('-', variable(ctx.inputs.outMax), variable(ctx.inputs.outMin), 'float')
    const inRange = binary('-', variable(ctx.inputs.inMax), variable(ctx.inputs.inMin), 'float')
    const scaled = binary('/', binary('*', valueSub, outRange, 'float'), inRange, 'float')
    const result = binary('+', variable(ctx.inputs.outMin), scaled, 'float')

    return {
      statements: [declare(ctx.outputs.result, 'float', result)],
      uniforms: [],
      standardUniforms: new Set(),
    }
  },
}
