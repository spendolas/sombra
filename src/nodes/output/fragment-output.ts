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
import { raw } from '../../compiler/ir/types'

/**
 * GLSL/WGSL expression combining derived alpha `d` (from Color.a) with the
 * Alpha input `a`. Syntax is identical in both shading languages; the caller
 * clamps the result to 0..1. `d` and `a` are already-formatted expressions.
 */
export function alphaCombineExpr(d: string, a: string, op: string): string {
  switch (op) {
    case 'replace': return a
    case 'max': return `max(${d}, ${a})`
    case 'add': return `${d} + ${a}`
    case 'subtract': return `${d} - ${a}`
    case 'min': return `min(${d}, ${a})`
    case 'difference': return `abs(${d} - ${a})`
    case 'multiply':
    default: return `${d} * ${a}`
  }
}

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
      type: 'color',
      default: [0.0, 0.0, 0.0, 1.0], // opaque black. `color` (not raw vec4): non-alpha
      // sources (float/vec2/vec3) coerce with alpha forced to 1 instead of the
      // float->vec4 splat that leaked the value into alpha (transparent-by-brightness).
      // Genuine color/vec4 sources still pass their real alpha through unchanged.
    },
  ],

  outputs: [],

  params: [
    {
      id: 'alpha',
      label: 'Alpha',
      type: 'float',
      default: 1.0,
      min: 0, max: 1, step: 0.01,
      connectable: true,
      updateMode: 'uniform',
    },
    {
      id: 'alphaOp',
      label: 'Alpha Op',
      type: 'enum',
      default: 'multiply',
      options: [
        { value: 'replace', label: 'Replace' },
        { value: 'multiply', label: 'Multiply (Intersect)' },
        { value: 'max', label: 'Union / Max' },
        { value: 'add', label: 'Add' },
        { value: 'subtract', label: 'Subtract' },
        { value: 'min', label: 'Min' },
        { value: 'difference', label: 'Difference' },
      ],
      updateMode: 'recompile',
    },
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
      control: 'anchor-grid',
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
    const { inputs, params } = ctx
    const id = ctx.nodeId.replace(/-/g, '_')
    const col = `fo_col_${id}`
    const af = `fo_a_${id}`
    const op = (params.alphaOp as string) || 'multiply'
    const combine = alphaCombineExpr(`${col}.a`, inputs.alpha, op)
    return [
      `vec4 ${col} = ${inputs.color};`,
      `float ${af} = clamp(${combine}, 0.0, 1.0);`,
      `fragColor = vec4(${col}.rgb * ${af}, ${af});`,
    ].join('\n  ')
  },

  ir: (ctx) => {
    const id = ctx.nodeId.replace(/-/g, '_')
    const col = `fo_col_${id}`
    const af = `fo_a_${id}`
    const op = (ctx.params.alphaOp as string) || 'multiply'
    const combine = alphaCombineExpr(`${col}.a`, ctx.inputs.alpha, op)
    return {
      statements: [
        raw(
          `vec4 ${col} = ${ctx.inputs.color};`,
          `var ${col}: vec4f = ${ctx.inputs.color};`,
        ),
        raw(
          `float ${af} = clamp(${combine}, 0.0, 1.0);`,
          `let ${af}: f32 = clamp(${combine}, 0.0, 1.0);`,
        ),
        raw(
          `fragColor = vec4(${col}.rgb * ${af}, ${af});`,
          `fragColor = vec4f(${col}.rgb * ${af}, ${af});`,
        ),
      ],
      uniforms: [],
      standardUniforms: new Set(),
    }
  },
}
