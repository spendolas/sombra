/**
 * Stripes — repeating band pattern with configurable angle and edge softness.
 */

import type { NodeDefinition, SpatialConfig } from '../types'
import { getSpatialParams } from '../types'

export const stripesNode: NodeDefinition = {
  type: 'stripes',
  label: 'Stripes',
  category: 'Pattern',
  description: 'Repeating bands — adjustable angle and softness',
  spatial: { transforms: ['scale', 'rotate', 'translate'] } satisfies SpatialConfig,

  inputs: [
    { id: 'coords', label: 'Coords', type: 'vec2', default: 'auto_uv' },
  ],

  outputs: [
    { id: 'value', label: 'Value', type: 'float' },
  ],

  params: [
    ...getSpatialParams({ transforms: ['scale', 'rotate', 'translate'] }),
    { id: 'softness', label: 'Softness', type: 'float', default: 0.0, min: 0.0, max: 1.0, step: 0.01, connectable: true, updateMode: 'uniform' },
  ],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    const id = ctx.nodeId.replace(/-/g, '_')
    const f = `st_f_${id}`
    const lo = `st_lo_${id}`
    const hi = `st_hi_${id}`
    return [
      `float ${f} = fract(${inputs.coords}.x);`,
      `float ${lo} = max(0.25 - ${inputs.softness} * 0.25, 0.001);`,
      `float ${hi} = min(0.25 + ${inputs.softness} * 0.25, 0.499);`,
      `float ${outputs.value} = smoothstep(${lo}, ${hi}, ${f}) - smoothstep(1.0 - ${hi}, 1.0 - ${lo}, ${f});`,
    ].join('\n  ')
  },
}
