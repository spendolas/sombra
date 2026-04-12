/**
 * Fragment Output node - master output node (only one per graph)
 */

import type { NodeDefinition } from '../types'

/** Map anchor enum value to vec2 (x, y fractions 0–1). */
export function anchorToVec2(anchor: string): [number, number] {
  switch (anchor) {
    case 'tl': return [0, 0]
    case 'tc': return [0.5, 0]
    case 'tr': return [1, 0]
    case 'cl': return [0, 0.5]
    case 'cr': return [1, 0.5]
    case 'bl': return [0, 1]
    case 'bc': return [0.5, 1]
    case 'br': return [1, 1]
    default:   return [0.5, 0.5] // center
  }
}
import { variable, literal, construct, assign } from '../../compiler/ir/types'

export const fragmentOutputNode: NodeDefinition = {
  type: 'fragment_output',
  label: 'Fragment Output',
  category: 'Output',
  description: 'Final color output (master node - only one per graph)',
  hidePreview: true,

  inputs: [
    {
      id: 'color',
      label: 'Color',
      type: 'vec3',
      default: [0.0, 0.0, 0.0], // Black default
    },
  ],

  outputs: [],

  params: [
    {
      id: 'quality',
      label: 'Render Quality',
      type: 'enum',
      default: 'adaptive',
      options: [
        { value: 'adaptive', label: 'Adaptive' },
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
      ],
      updateMode: 'renderer',
    },
    {
      id: 'anchor',
      label: 'Anchor',
      type: 'enum',
      default: 'center',
      options: [
        { value: 'tl', label: '↖' }, { value: 'tc', label: '↑' }, { value: 'tr', label: '↗' },
        { value: 'cl', label: '←' }, { value: 'center', label: '·' }, { value: 'cr', label: '→' },
        { value: 'bl', label: '↙' }, { value: 'bc', label: '↓' }, { value: 'br', label: '↘' },
      ],
      updateMode: 'renderer',
    },
  ],

  glsl: (ctx) => {
    const { inputs } = ctx
    return `fragColor = vec4(${inputs.color}, 1.0);`
  },

  ir: (ctx) => ({
    statements: [
      assign('fragColor',
        construct('vec4', [variable(ctx.inputs.color), literal('float', 1.0)]),
      ),
    ],
    uniforms: [],
    standardUniforms: new Set(),
  }),
}
