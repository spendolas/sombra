/**
 * Stripes — repeating band pattern with configurable angle and edge softness.
 */

import type { NodeDefinition } from '../types'

export const stripesNode: NodeDefinition = {
  type: 'stripes',
  label: 'Stripes',
  category: 'Pattern',
  description: 'Repeating bands — adjustable angle and softness',

  inputs: [
    { id: 'coords', label: 'Coords', type: 'vec2', default: 'auto_uv' },
  ],

  outputs: [
    { id: 'value', label: 'Value', type: 'float' },
  ],

  params: [
    { id: 'scale', label: 'Scale', type: 'float', default: 8.0, min: 1.0, max: 64.0, step: 0.5, connectable: true, updateMode: 'uniform' },
    { id: 'angle', label: 'Angle', type: 'float', default: 0.0, min: 0.0, max: 360.0, step: 1.0, connectable: true, updateMode: 'uniform' },
    { id: 'softness', label: 'Softness', type: 'float', default: 0.0, min: 0.0, max: 1.0, step: 0.01, connectable: true, updateMode: 'uniform' },
  ],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    const id = ctx.nodeId.replace(/-/g, '_')
    const a = `st_a_${id}`
    const cs = `st_cs_${id}`
    const rc = `st_rc_${id}`
    const f = `st_f_${id}`
    const lo = `st_lo_${id}`
    const hi = `st_hi_${id}`
    return [
      `float ${a} = ${inputs.angle} * 0.017453292519943295;`, // deg to rad
      `vec2 ${cs} = vec2(cos(${a}), sin(${a}));`,
      `float ${rc} = dot(${inputs.coords}, ${cs}) * ${inputs.scale};`,
      `float ${f} = fract(${rc});`,
      `float ${lo} = max(0.25 - ${inputs.softness} * 0.25, 0.001);`,
      `float ${hi} = min(0.25 + ${inputs.softness} * 0.25, 0.499);`,
      `float ${outputs.value} = smoothstep(${lo}, ${hi}, ${f}) - smoothstep(1.0 - ${hi}, 1.0 - ${lo}, ${f});`,
    ].join('\n  ')
  },
}
