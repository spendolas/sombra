/**
 * Fragment Output node - master output node (only one per graph)
 */

import type { NodeDefinition } from '../types'

export const fragmentOutputNode: NodeDefinition = {
  type: 'fragment_output',
  label: 'Fragment Output',
  category: 'Output',
  description: 'Final color output (master node - only one per graph)',

  inputs: [
    {
      id: 'color',
      label: 'Color',
      type: 'vec3',
      default: [0.0, 0.0, 0.0], // Black default
    },
  ],

  outputs: [],

  glsl: (ctx) => {
    const { inputs } = ctx
    return `fragColor = vec4(${inputs.color}, 1.0);`
  },
}
