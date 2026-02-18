/**
 * Trig node - unified sin/cos/tan/abs with connectable frequency and amplitude
 */

import type { NodeDefinition } from '../types'

const FUNCTIONS = [
  { value: 'sin', label: 'Sin' },
  { value: 'cos', label: 'Cos' },
  { value: 'tan', label: 'Tan' },
  { value: 'abs', label: 'Abs' },
]

const GLSL_FN: Record<string, string> = {
  sin: 'sin',
  cos: 'cos',
  tan: 'tan',
  abs: 'abs',
}

export const trigNode: NodeDefinition = {
  type: 'trig',
  label: 'Trig',
  category: 'Math',
  description: 'Trigonometric and absolute value functions',

  inputs: [
    { id: 'value', label: 'Value', type: 'float', default: 0.0 },
  ],

  outputs: [
    { id: 'result', label: 'Result', type: 'float' },
  ],

  params: [
    {
      id: 'func',
      label: 'Function',
      type: 'enum',
      default: 'sin',
      options: FUNCTIONS,
    },
    {
      id: 'frequency',
      label: 'Frequency',
      type: 'float',
      default: 1.0,
      min: 0.1,
      max: 10.0,
      step: 0.1,
      connectable: true,
    },
    {
      id: 'amplitude',
      label: 'Amplitude',
      type: 'float',
      default: 1.0,
      min: 0.1,
      max: 5.0,
      step: 0.1,
      connectable: true,
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, params } = ctx
    const func = (params.func as string) || 'sin'
    const glslFn = GLSL_FN[func] || 'sin'
    const freq = inputs.frequency
    const amp = inputs.amplitude

    return `float ${outputs.result} = ${glslFn}(${inputs.value} * ${freq}) * ${amp};`
  },
}
