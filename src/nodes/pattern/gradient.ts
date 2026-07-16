/**
 * Gradient — procedural gradient pattern with multiple modes, mapped through a
 * built-in color ramp (stops + interpolation, mirroring color-ramp.ts).
 *
 * The Type field (linear/radial/angular/diamond) computes a local scalar `field`
 * (0-1, unclamped for radial/diamond at corners) which is exposed as `value` and
 * also fed as `t` into the stops mix-chain to produce `color`.
 */

import type { NodeDefinition, SpatialConfig } from '../types'
import { getSpatialParams } from '../types'
import { variable, call, binary, literal, declare, assign, swizzle, construct } from '../../compiler/ir/types'
import type { IRStmt, IRExpr } from '../../compiler/ir/types'

/** Format number as GLSL float literal */
function flt(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : `${n}`
}

interface ColorStop {
  position: number
  /** RGB (legacy, alpha defaults to 1) or RGBA. */
  color: [number, number, number] | [number, number, number, number]
}

/** Normalize a stop color to RGBA, defaulting alpha to 1 for legacy 3-length colors. */
function normalizeStopColor(color: ColorStop['color']): [number, number, number, number] {
  return color.length === 4 ? color : [color[0], color[1], color[2], 1]
}

export const gradientNode: NodeDefinition = {
  type: 'gradient',
  label: 'Gradient',
  category: 'Pattern',
  description: 'Procedural gradient — linear, radial, angular, or diamond, mapped through color stops',
  spatial: { transforms: ['scale', 'rotate', 'translate'] } satisfies SpatialConfig,

  inputs: [
    { id: 'coords', label: 'Coords', type: 'vec2', default: 'auto_uv' },
  ],

  outputs: [
    { id: 'color', label: 'Color', type: 'color' },
    { id: 'value', label: 'Value', type: 'float' },
  ],

  params: [
    ...getSpatialParams({ transforms: ['scale', 'rotate', 'translate'] }),
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
    const gradType = (params.gradientType as string) || 'linear'
    const interp = (params.interpolation as string) || 'smooth'
    const id = ctx.nodeId.replace(/-/g, '_')
    const field = `grad_field_${id}`

    const lines: string[] = []

    switch (gradType) {
      case 'radial':
        lines.push(`float ${field} = clamp(length(${inputs.coords} - 0.5) * 2.0, 0.0, 1.0);`)
        break
      case 'angular':
        lines.push(`float ${field} = atan(${inputs.coords}.y - 0.5, ${inputs.coords}.x - 0.5) * (1.0 / 6.28318530718) + 0.5;`)
        break
      case 'diamond':
        lines.push(`float ${field} = clamp((abs(${inputs.coords}.x - 0.5) + abs(${inputs.coords}.y - 0.5)) * 2.0, 0.0, 1.0);`)
        break
      default: // linear
        lines.push(`float ${field} = ${inputs.coords}.x;`)
    }

    lines.push(`float ${outputs.value} = ${field};`)

    // Read stops, sort by position, fallback to black-white
    let stops = params.stops as ColorStop[] | undefined
    if (!stops || !Array.isArray(stops) || stops.length < 2) {
      stops = [
        { position: 0, color: [0, 0, 0] },
        { position: 1, color: [1, 1, 1] },
      ]
    }
    stops = [...stops].sort((a, b) => a.position - b.position)

    const c = outputs.color
    const t = field

    // Initialize with first stop color
    const [r0, g0, b0, a0] = normalizeStopColor(stops[0].color)
    lines.push(`vec4 ${c} = vec4(${flt(r0)}, ${flt(g0)}, ${flt(b0)}, ${flt(a0)});`)

    // Chain mix() calls for each subsequent stop
    for (let i = 1; i < stops.length; i++) {
      const prev = stops[i - 1]
      const curr = stops[i]
      const [r, g, b, a] = normalizeStopColor(curr.color)
      const colorExpr = `vec4(${flt(r)}, ${flt(g)}, ${flt(b)}, ${flt(a)})`

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
    const gradType = (ctx.params.gradientType as string) || 'linear'
    const interp = (ctx.params.interpolation as string) || 'smooth'
    const coords = variable(ctx.inputs.coords)
    const id = ctx.nodeId.replace(/-/g, '_')
    const field = `grad_field_${id}`

    const statements: IRStmt[] = []

    switch (gradType) {
      case 'radial':
        // clamp(length(coords - 0.5) * 2.0, 0.0, 1.0)
        statements.push(
          declare(field, 'float',
            call('clamp', [
              binary('*',
                call('length', [
                  binary('-', coords, literal('vec2', [0.5, 0.5]), 'vec2'),
                ], 'float'),
                literal('float', 2.0),
                'float',
              ),
              literal('float', 0.0),
              literal('float', 1.0),
            ], 'float'),
          ),
        )
        break
      case 'angular':
        // atan(coords.y - 0.5, coords.x - 0.5) * (1.0 / 6.28318530718) + 0.5
        statements.push(
          declare(field, 'float',
            binary('+',
              binary('*',
                call('atan', [
                  binary('-', swizzle(coords, 'y', 'float'), literal('float', 0.5), 'float'),
                  binary('-', swizzle(coords, 'x', 'float'), literal('float', 0.5), 'float'),
                ], 'float'),
                literal('float', 1.0 / 6.28318530718),
                'float',
              ),
              literal('float', 0.5),
              'float',
            ),
          ),
        )
        break
      case 'diamond':
        // clamp((abs(coords.x - 0.5) + abs(coords.y - 0.5)) * 2.0, 0.0, 1.0)
        statements.push(
          declare(field, 'float',
            call('clamp', [
              binary('*',
                binary('+',
                  call('abs', [
                    binary('-', swizzle(coords, 'x', 'float'), literal('float', 0.5), 'float'),
                  ], 'float'),
                  call('abs', [
                    binary('-', swizzle(coords, 'y', 'float'), literal('float', 0.5), 'float'),
                  ], 'float'),
                  'float',
                ),
                literal('float', 2.0),
                'float',
              ),
              literal('float', 0.0),
              literal('float', 1.0),
            ], 'float'),
          ),
        )
        break
      default: // linear
        // coords.x
        statements.push(
          declare(field, 'float', swizzle(coords, 'x', 'float')),
        )
    }

    statements.push(declare(ctx.outputs.value, 'float', variable(field)))

    // Read stops, sort by position, fallback to black-white
    let stops = ctx.params.stops as ColorStop[] | undefined
    if (!stops || !Array.isArray(stops) || stops.length < 2) {
      stops = [
        { position: 0, color: [0, 0, 0] },
        { position: 1, color: [1, 1, 1] },
      ]
    }
    stops = [...stops].sort((a, b) => a.position - b.position)

    const c = ctx.outputs.color
    const t = variable(field)

    // Initialize with first stop color
    const [r0, g0, b0, a0] = normalizeStopColor(stops[0].color)
    statements.push(
      declare(c, 'vec4', construct('vec4', [
        literal('float', r0),
        literal('float', g0),
        literal('float', b0),
        literal('float', a0),
      ])),
    )

    // Chain mix() calls for each subsequent stop
    for (let i = 1; i < stops.length; i++) {
      const prev = stops[i - 1]
      const curr = stops[i]
      const [r, g, b, a] = normalizeStopColor(curr.color)
      const colorExpr: IRExpr = construct('vec4', [
        literal('float', r),
        literal('float', g),
        literal('float', b),
        literal('float', a),
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
