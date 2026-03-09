/**
 * Gradient — procedural gradient pattern with multiple modes.
 * Outputs float 0–1 (unclamped for radial/diamond to allow > 1 at corners).
 */

import type { NodeDefinition } from '../types'

export const gradientNode: NodeDefinition = {
  type: 'gradient',
  label: 'Gradient',
  category: 'Pattern',
  description: 'Procedural gradient — linear, radial, angular, or diamond',

  inputs: [
    { id: 'coords', label: 'Coords', type: 'vec2', default: 'auto_uv' },
  ],

  outputs: [
    { id: 'value', label: 'Value', type: 'float' },
  ],

  params: [
    {
      id: 'gradientType', label: 'Type', type: 'enum', default: 'linear',
      options: [
        { value: 'linear', label: 'Linear' },
        { value: 'radial', label: 'Radial' },
        { value: 'angular', label: 'Angular' },
        { value: 'diamond', label: 'Diamond' },
      ],
      updateMode: 'recompile',
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, params } = ctx
    const gradType = (params.gradientType as string) || 'linear'

    switch (gradType) {
      case 'radial':
        return `float ${outputs.value} = clamp(length(${inputs.coords} - 0.5) * 2.0, 0.0, 1.0);`
      case 'angular':
        return `float ${outputs.value} = atan(${inputs.coords}.y - 0.5, ${inputs.coords}.x - 0.5) * (1.0 / 6.28318530718) + 0.5;`
      case 'diamond':
        return `float ${outputs.value} = clamp((abs(${inputs.coords}.x - 0.5) + abs(${inputs.coords}.y - 0.5)) * 2.0, 0.0, 1.0);`
      default: // linear
        return `float ${outputs.value} = ${inputs.coords}.x;`
    }
  },
}
