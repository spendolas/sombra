/**
 * Round — apply a rounding function to a value.
 * Modes: floor, ceil, fract, round, sign.
 */

import type { NodeDefinition } from '../types'

export const roundNode: NodeDefinition = {
  type: 'round',
  label: 'Round',
  category: 'Math',
  description: 'Apply floor, ceil, fract, round, or sign to a value',
  conditionalPreview: true,

  inputs: [
    { id: 'value', label: 'Value', type: 'float', default: 0.5 },
  ],

  outputs: [
    { id: 'result', label: 'Result', type: 'float' },
  ],

  params: [
    {
      id: 'mode', label: 'Mode', type: 'enum', default: 'floor',
      options: [
        { value: 'floor', label: 'Floor' },
        { value: 'ceil', label: 'Ceil' },
        { value: 'fract', label: 'Fract' },
        { value: 'round', label: 'Round' },
        { value: 'sign', label: 'Sign' },
      ],
      updateMode: 'recompile',
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, params } = ctx
    const mode = (params.mode as string) || 'floor'
    const fn = mode === 'ceil' ? 'ceil'
      : mode === 'fract' ? 'fract'
      : mode === 'round' ? 'round'
      : mode === 'sign' ? 'sign'
      : 'floor'
    return `float ${outputs.result} = ${fn}(${inputs.value});`
  },
}
