/**
 * Color Ramp node — Map a float value (0-1) to a color gradient via multi-stop ramp
 */

import type { NodeDefinition } from '../types'
import { variable, call, declare, assign, literal, construct, binary } from '../../compiler/ir/types'
import type { IRStmt, IRExpr } from '../../compiler/ir/types'

/** Format number as GLSL float literal */
function flt(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : `${n}`
}

interface ColorStop {
  position: number
  color: [number, number, number]
}

export const colorRampNode: NodeDefinition = {
  type: 'color_ramp',
  label: 'Color Ramp',
  category: 'Color',
  description: 'Map a float value to a color gradient',

  inputs: [
    { id: 't', label: 'Value', type: 'float', default: 0.5 },
  ],

  outputs: [
    { id: 'color', label: 'Color', type: 'vec3' },
  ],

  params: [
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
  ],



  glsl: (ctx) => {
    const { inputs, outputs, params } = ctx
    const interp = (params.interpolation as string) || 'smooth'

    // Read stops, sort by position, fallback to black-white
    let stops = params.stops as ColorStop[] | undefined
    if (!stops || !Array.isArray(stops) || stops.length < 2) {
      stops = [
        { position: 0, color: [0, 0, 0] },
        { position: 1, color: [1, 1, 1] },
      ]
    }
    stops = [...stops].sort((a, b) => a.position - b.position)

    const lines: string[] = []
    const c = outputs.color
    const t = inputs.t

    // Initialize with first stop color
    const [r0, g0, b0] = stops[0].color
    lines.push(`vec3 ${c} = vec3(${flt(r0)}, ${flt(g0)}, ${flt(b0)});`)

    // Chain mix() calls for each subsequent stop
    for (let i = 1; i < stops.length; i++) {
      const prev = stops[i - 1]
      const curr = stops[i]
      const [r, g, b] = curr.color
      const colorExpr = `vec3(${flt(r)}, ${flt(g)}, ${flt(b)})`

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

    // Read stops, sort by position, fallback to black-white
    let stops = ctx.params.stops as ColorStop[] | undefined
    if (!stops || !Array.isArray(stops) || stops.length < 2) {
      stops = [
        { position: 0, color: [0, 0, 0] },
        { position: 1, color: [1, 1, 1] },
      ]
    }
    stops = [...stops].sort((a, b) => a.position - b.position)

    const statements: IRStmt[] = []

    // Initialize with first stop color
    const [r0, g0, b0] = stops[0].color
    statements.push(
      declare(c, 'vec3', construct('vec3', [
        literal('float', r0),
        literal('float', g0),
        literal('float', b0),
      ])),
    )

    // Chain mix() calls for each subsequent stop
    for (let i = 1; i < stops.length; i++) {
      const prev = stops[i - 1]
      const curr = stops[i]
      const [r, g, b] = curr.color
      const colorExpr: IRExpr = construct('vec3', [
        literal('float', r),
        literal('float', g),
        literal('float', b),
      ])

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
        assign(c, call('mix', [variable(c), colorExpr, factor], 'vec3')),
      )
    }

    return {
      statements,
      uniforms: [],
      standardUniforms: new Set<string>(),
    }
  },
}
