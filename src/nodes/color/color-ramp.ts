/**
 * Color Ramp node — Map a float value (0-1) to a color gradient via multi-stop ramp.
 *
 * Stop colours are runtime uniforms (one hidden `color` param per stop, from
 * ramp-stops.ts), so every stop is an embed knob; positions and interpolation
 * stay compile-time — they decide sort order and the step/smoothstep shape.
 */

import type { NodeDefinition, NodeParameter } from '../types'
import { variable, call, declare, assign, literal, binary } from '../../compiler/ir/types'
import type { IRStmt, IRExpr } from '../../compiler/ir/types'
import { normalizeStops, sortStops, stopColorParams, stopUniform } from './ramp-stops'

/** Format number as GLSL float literal */
function flt(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : `${n}`
}

const STATIC_PARAMS: NodeParameter[] = [
  {
    id: 'interpolation',
    label: 'Interpolation',
    type: 'enum',
    default: 'smooth',
    options: [
      { value: 'smooth', label: 'Smooth' },
      { value: 'linear', label: 'Linear' },
      { value: 'constant', label: 'Constant' },
    ],
    updateMode: 'recompile',
  },
  {
    id: 'stops',
    label: 'Stops',
    type: 'float',
    default: 0,
    hidden: true,
    updateMode: 'recompile',
  },
]

export const colorRampNode: NodeDefinition = {
  type: 'color_ramp',
  label: 'Color Ramp',
  category: 'Color',
  description: 'Map a float value to a color gradient',

  inputs: [
    { id: 't', label: 'Value', type: 'float', default: 0.5 },
  ],

  outputs: [
    { id: 'color', label: 'Color', type: 'color' },
  ],

  params: STATIC_PARAMS,
  // + one hidden uniform `color` param per stop (Stop 0..N-1 by position).
  dynamicParams: (params) => [...STATIC_PARAMS, ...stopColorParams(params)],

  glsl: (ctx) => {
    const { inputs, outputs, params } = ctx
    const interp = (params.interpolation as string) || 'smooth'

    // Stops by position (equal positions keep stored order); missing/unusable → black-white
    const stops = sortStops(normalizeStops(params.stops))

    const lines: string[] = []
    const c = outputs.color
    const t = inputs.t

    // Initialize with first stop color
    lines.push(`vec4 ${c} = ${stopUniform(inputs, stops[0], 'color_ramp')};`)

    // Chain mix() calls for each subsequent stop
    for (let i = 1; i < stops.length; i++) {
      const prev = stops[i - 1]
      const curr = stops[i]
      const colorExpr = stopUniform(inputs, curr, 'color_ramp')

      let factor: string
      if (Math.abs(curr.position - prev.position) < 0.0001) {
        // Same position — hard step regardless of mode
        factor = `step(${flt(curr.position)}, ${t})`
      } else if (interp === 'smooth') {
        factor = `smoothstep(${flt(prev.position)}, ${flt(curr.position)}, ${t})`
      } else if (interp === 'linear') {
        factor = `clamp((${t} - ${flt(prev.position)}) / (${flt(curr.position)} - ${flt(prev.position)}), 0.0, 1.0)`
      } else {
        // constant
        factor = `step(${flt(curr.position)}, ${t})`
      }

      lines.push(`${c} = mix(${c}, ${colorExpr}, ${factor});`)
    }

    return lines.join('\n  ')
  },

  ir: (ctx) => {
    const interp = (ctx.params.interpolation as string) || 'smooth'
    const t = variable(ctx.inputs.t)
    const c = ctx.outputs.color

    // Stops by position (equal positions keep stored order); missing/unusable → black-white
    const stops = sortStops(normalizeStops(ctx.params.stops))

    const statements: IRStmt[] = []

    // Initialize with first stop color
    statements.push(declare(c, 'vec4', variable(stopUniform(ctx.inputs, stops[0], 'color_ramp'))))

    // Chain mix() calls for each subsequent stop
    for (let i = 1; i < stops.length; i++) {
      const prev = stops[i - 1]
      const curr = stops[i]
      const colorExpr: IRExpr = variable(stopUniform(ctx.inputs, curr, 'color_ramp'))

      let factor: IRExpr
      if (Math.abs(curr.position - prev.position) < 0.0001) {
        // Same position — hard step
        factor = call('step', [literal('float', curr.position), t], 'float')
      } else if (interp === 'smooth') {
        factor = call('smoothstep', [
          literal('float', prev.position),
          literal('float', curr.position),
          t,
        ], 'float')
      } else if (interp === 'linear') {
        // clamp((t - prev) / (curr - prev), 0.0, 1.0)
        factor = call('clamp', [
          binary('/',
            binary('-', t, literal('float', prev.position), 'float'),
            literal('float', curr.position - prev.position),
            'float',
          ),
          literal('float', 0.0),
          literal('float', 1.0),
        ], 'float')
      } else {
        // constant
        factor = call('step', [literal('float', curr.position), t], 'float')
      }

      statements.push(
        assign(c, call('mix', [variable(c), colorExpr, factor], 'vec4')),
      )
    }

    return {
      statements,
      uniforms: [],
      standardUniforms: new Set<string>(),
    }
  },
}
