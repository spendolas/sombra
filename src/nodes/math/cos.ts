/**
 * Cos node - Cosine trigonometric function
 * Oscillates between -1 and 1
 */

import type { NodeDefinition } from '../types'

export const cosNode: NodeDefinition = {
  type: 'cos',
  label: 'Cos',
  category: 'Math',
  description: 'Cosine function (oscillates between -1 and 1)',

  inputs: [
    {
      id: 'value',
      label: 'Value',
      type: 'float',
      default: 0.0,
    },
  ],

  outputs: [
    {
      id: 'result',
      label: 'Result',
      type: 'float',
    },
  ],

  params: [
    {
      id: 'frequency',
      label: 'Frequency',
      type: 'float',
      default: 1.0,
      min: 0.1,
      max: 10.0,
      step: 0.1,
    },
    {
      id: 'amplitude',
      label: 'Amplitude',
      type: 'float',
      default: 1.0,
      min: 0.1,
      max: 5.0,
      step: 0.1,
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, params } = ctx
    const frequency = params.frequency !== undefined ? params.frequency : 1.0
    const amplitude = params.amplitude !== undefined ? params.amplitude : 1.0

    // Format as float literals
    const freqStr = typeof frequency === 'number'
      ? (Number.isInteger(frequency) ? `${frequency}.0` : `${frequency}`)
      : `${frequency}`
    const ampStr = typeof amplitude === 'number'
      ? (Number.isInteger(amplitude) ? `${amplitude}.0` : `${amplitude}`)
      : `${amplitude}`

    return `float ${outputs.result} = cos(${inputs.value} * ${freqStr}) * ${ampStr};`
  },
}
