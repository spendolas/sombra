/**
 * Gradient — procedural gradient pattern with multiple modes, mapped through a
 * built-in color ramp (stops + interpolation, mirroring color-ramp.ts).
 *
 * The Type field (linear/radial/angular/diamond) computes a local scalar `field`
 * (0-1, unclamped for radial/diamond at corners) which is exposed as `value` and
 * also fed as `t` into the stops mix-chain to produce `color`.
 */

import type { NodeDefinition, SpatialConfig, GizmoConfig } from '../types'
import { getSpatialParams } from '../types'
import { variable, call, binary, literal, declare, assign, swizzle, construct, ternary } from '../../compiler/ir/types'
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
      id: 'drawMode', label: 'Draw Mode', type: 'enum', default: 'stretch',
      options: [
        { value: 'stretch', label: 'Stretch' },
        { value: 'pinned', label: 'Pinned' },
      ],
      updateMode: 'recompile',
    },
    // Pinned control points — SHARED across all gradient types, so switching
    // `gradientType` never moves the gradient. P0 = Start/Center, P1 =
    // End/Edge/Ref/Corner depending on type; `aspect` scales the perpendicular
    // axis for radial (ellipse)/angular (elliptical angle)/diamond (rhombus).
    {
      id: 'p0x', label: 'Start / Center X', type: 'float', default: 0,
      min: -1000, max: 1000, step: 1,
      connectable: true, updateMode: 'uniform',
      showWhen: { drawMode: 'pinned' },
    },
    {
      id: 'p0y', label: 'Start / Center Y', type: 'float', default: 0,
      min: -1000, max: 1000, step: 1,
      connectable: true, updateMode: 'uniform',
      showWhen: { drawMode: 'pinned' },
    },
    {
      id: 'p1x', label: 'End / Edge / Ref / Corner X', type: 'float', default: 150,
      min: -1000, max: 1000, step: 1,
      connectable: true, updateMode: 'uniform',
      showWhen: { drawMode: 'pinned' },
    },
    {
      id: 'p1y', label: 'End / Edge / Ref / Corner Y', type: 'float', default: 0,
      min: -1000, max: 1000, step: 1,
      connectable: true, updateMode: 'uniform',
      showWhen: { drawMode: 'pinned' },
    },
    {
      id: 'aspect', label: 'Aspect', type: 'float', default: 1,
      min: 0.1, max: 10, step: 0.01,
      connectable: true, updateMode: 'uniform',
      showWhen: { drawMode: 'pinned', gradientType: ['radial', 'angular', 'diamond'] },
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

  gizmo: {
    showWhen: { drawMode: 'pinned' },
    points: [
      { id: 'p0', xParam: 'p0x', yParam: 'p0y', shape: 'diamond', showWhen: { drawMode: 'pinned' } },
      { id: 'p1', xParam: 'p1x', yParam: 'p1y', shape: 'diamond', showWhen: { drawMode: 'pinned' } },
    ],
    connectors: [
      { from: 'p0', to: 'p1' },
    ],
    aspectHandles: [
      {
        id: 'asp', shape: 'square', aspectParam: 'aspect', centerPoint: 'p0', endPoint: 'p1',
        showWhen: { drawMode: 'pinned', gradientType: ['radial', 'angular', 'diamond'] },
      },
    ],
    outline: [
      {
        shape: 'ellipse', centerPoint: 'p0', endPoint: 'p1', aspectParam: 'aspect',
        showWhen: { drawMode: 'pinned', gradientType: ['radial', 'angular'] },
      },
      {
        shape: 'diamond', centerPoint: 'p0', endPoint: 'p1', aspectParam: 'aspect',
        showWhen: { drawMode: 'pinned', gradientType: 'diamond' },
      },
    ],
  } satisfies GizmoConfig,

  glsl: (ctx) => {
    const { inputs, outputs, params } = ctx
    const gradType = (params.gradientType as string) || 'linear'
    const drawMode = (params.drawMode as string) || 'stretch'
    const interp = (params.interpolation as string) || 'smooth'
    const id = ctx.nodeId.replace(/-/g, '_')
    const field = `grad_field_${id}`

    const lines: string[] = []

    if (drawMode === 'pinned') {
      // Pinned: control points are CSS px relative to the PREVIEW CANVAS CENTRE
      // (not the anchor) so their preview position survives anchor changes.
      // grad_center = auto_uv at the canvas centre; the u_anchor terms cancel in
      // (coords - pt) → anchor-invariant. Y flipped (px Y-down, coords Y-up);
      // px→units divides by u_ref_size only (auto_uv carries the dpr*ref scale).
      ctx.uniforms.add('u_ref_size')
      ctx.uniforms.add('u_anchor')
      ctx.uniforms.add('u_resolution')
      ctx.uniforms.add('u_dpr')
      lines.push(`vec2 grad_center_${id} = u_anchor + (vec2(0.5) - u_anchor) * u_resolution / (u_dpr * u_ref_size);`)

      const pt = (varName: string, pxExpr: string, pyExpr: string) => {
        lines.push(`vec2 ${varName} = grad_center_${id} + vec2(${pxExpr}, -(${pyExpr})) / u_ref_size;`)
      }

      // Shared field basis for ALL types: C = P0, P = P1, so switching
      // gradientType never moves the gradient. u = P - C is the primary axis;
      // vh is its perpendicular, scaled by `aspect` for radial/angular/diamond.
      const C = `grad_C_${id}`
      const P = `grad_P_${id}`
      const u = `grad_u_${id}`
      const L = `grad_L_${id}`
      const uh = `grad_uh_${id}`
      const vh = `grad_vh_${id}`
      const d = `grad_d_${id}`
      const a = `grad_a_${id}`
      const b = `grad_b_${id}`
      pt(C, inputs.p0x, inputs.p0y)
      pt(P, inputs.p1x, inputs.p1y)
      lines.push(`vec2 ${u} = ${P} - ${C};`)
      lines.push(`float ${L} = max(length(${u}), 1e-6);`)
      lines.push(`vec2 ${uh} = ${u} / ${L};`)
      lines.push(`vec2 ${vh} = vec2(-${uh}.y, ${uh}.x);`)
      lines.push(`vec2 ${d} = ${inputs.coords} - ${C};`)
      lines.push(`float ${a} = dot(${d}, ${uh}) / ${L};`)
      lines.push(`float ${b} = dot(${d}, ${vh}) / (${inputs.aspect} * ${L});`)

      switch (gradType) {
        case 'radial': {
          lines.push(`float ${field} = length(vec2(${a}, ${b}));`)
          break
        }
        case 'angular': {
          const ang = `grad_ang_${id}`
          lines.push(`float ${ang} = atan(${b}, ${a});`)
          lines.push(`float ${field} = ${ang} * (1.0 / 6.28318530718);`)
          lines.push(`${field} = ${field} < 0.0 ? ${field} + 1.0 : ${field};`)
          break
        }
        case 'diamond': {
          lines.push(`float ${field} = abs(${a}) + abs(${b});`)
          break
        }
        default: { // linear
          lines.push(`float ${field} = ${a};`)
        }
      }
    } else {
      // Stretch: field computed in raw normalized v_uv (0..1 across the full
      // canvas, aspect-distorting) — independent of `coords` wiring/SRT.
      switch (gradType) {
        case 'radial':
          lines.push(`float ${field} = clamp(length(v_uv - 0.5) * 2.0, 0.0, 1.0);`)
          break
        case 'angular':
          lines.push(`float ${field} = atan(v_uv.y - 0.5, v_uv.x - 0.5) * (1.0 / 6.28318530718) + 0.5;`)
          break
        case 'diamond':
          lines.push(`float ${field} = clamp((abs(v_uv.x - 0.5) + abs(v_uv.y - 0.5)) * 2.0, 0.0, 1.0);`)
          break
        default: // linear
          lines.push(`float ${field} = v_uv.x;`)
      }
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
    const drawMode = (ctx.params.drawMode as string) || 'stretch'
    const interp = (ctx.params.interpolation as string) || 'smooth'
    const coords = variable(ctx.inputs.coords)
    const id = ctx.nodeId.replace(/-/g, '_')
    const field = `grad_field_${id}`

    const statements: IRStmt[] = []
    const standardUniforms = new Set<string>()

    if (drawMode === 'pinned') {
      // Pinned: control points are CSS px relative to the PREVIEW CANVAS CENTRE
      // (not the anchor) so their preview position survives anchor changes.
      // grad_center = auto_uv at the canvas centre = u_anchor + (0.5 - u_anchor)
      // * u_resolution / (u_dpr * u_ref_size) — the u_anchor terms cancel in
      // (coords - pt), making the field anchor-invariant. Y is flipped (px is
      // Y-down like SRT translate; coords is Y-up); px→units divides by
      // u_ref_size only (auto_uv already carries the dpr*ref scale).
      standardUniforms.add('u_ref_size')
      standardUniforms.add('u_anchor')
      standardUniforms.add('u_resolution')
      standardUniforms.add('u_dpr')

      const center = `grad_center_${id}`
      statements.push(declare(center, 'vec2',
        binary('+',
          variable('u_anchor'),
          binary('/',
            binary('*',
              binary('-', construct('vec2', [literal('float', 0.5), literal('float', 0.5)]), variable('u_anchor'), 'vec2'),
              variable('u_resolution'),
              'vec2',
            ),
            binary('*', variable('u_dpr'), variable('u_ref_size'), 'float'),
            'vec2',
          ),
          'vec2',
        ),
      ))

      // pt = grad_center + vec2(px, -py) / u_ref_size
      // WGSL has no scalar±vector +/-, so the vec2 is built per-component and
      // only vec2±vec2 / vec2÷scalar ops are used.
      const ptExpr = (pxId: string, pyId: string): IRExpr =>
        binary('+',
          variable(center),
          binary('/',
            construct('vec2', [
              variable(ctx.inputs[pxId]),
              binary('*', literal('float', -1.0), variable(ctx.inputs[pyId]), 'float'),
            ]),
            variable('u_ref_size'),
            'vec2',
          ),
          'vec2',
        )

      // Shared field basis for ALL types: C = P0, P = P1, so switching
      // gradientType never moves the gradient. u = P - C is the primary axis;
      // vh is its perpendicular, scaled by `aspect` for radial/angular/diamond.
      const C = `grad_C_${id}`
      const P = `grad_P_${id}`
      const u = `grad_u_${id}`
      const L = `grad_L_${id}`
      const uh = `grad_uh_${id}`
      const vh = `grad_vh_${id}`
      const d = `grad_d_${id}`
      const a = `grad_a_${id}`
      const b = `grad_b_${id}`
      statements.push(declare(C, 'vec2', ptExpr('p0x', 'p0y')))
      statements.push(declare(P, 'vec2', ptExpr('p1x', 'p1y')))
      statements.push(declare(u, 'vec2', binary('-', variable(P), variable(C), 'vec2')))
      statements.push(declare(L, 'float',
        call('max', [call('length', [variable(u)], 'float'), literal('float', 1e-6)], 'float'),
      ))
      statements.push(declare(uh, 'vec2', binary('/', variable(u), variable(L), 'vec2')))
      // perpendicular: (-uh.y, uh.x)
      statements.push(declare(vh, 'vec2', construct('vec2', [
        binary('*', literal('float', -1.0), swizzle(variable(uh), 'y', 'float'), 'float'),
        swizzle(variable(uh), 'x', 'float'),
      ])))
      statements.push(declare(d, 'vec2', binary('-', coords, variable(C), 'vec2')))
      // a = dot(d, uh) / L
      statements.push(declare(a, 'float',
        binary('/', call('dot', [variable(d), variable(uh)], 'float'), variable(L), 'float'),
      ))
      // b = dot(d, vh) / (aspect * L)
      statements.push(declare(b, 'float',
        binary('/',
          call('dot', [variable(d), variable(vh)], 'float'),
          binary('*', variable(ctx.inputs.aspect), variable(L), 'float'),
          'float',
        ),
      ))

      switch (gradType) {
        case 'radial': {
          // length(vec2(a, b))
          statements.push(
            declare(field, 'float',
              call('length', [construct('vec2', [variable(a), variable(b)])], 'float'),
            ),
          )
          break
        }
        case 'angular': {
          const ang = `grad_ang_${id}`
          // ang = atan(b, a); field = ang / (2*pi); field = field < 0 ? field + 1 : field
          statements.push(declare(ang, 'float', call('atan', [variable(b), variable(a)], 'float')))
          statements.push(
            declare(field, 'float',
              binary('*', variable(ang), literal('float', 1.0 / 6.28318530718), 'float'),
            ),
          )
          statements.push(
            assign(field,
              ternary(
                binary('<', variable(field), literal('float', 0.0), 'bool'),
                binary('+', variable(field), literal('float', 1.0), 'float'),
                variable(field),
                'float',
              ),
            ),
          )
          break
        }
        case 'diamond': {
          // abs(a) + abs(b)
          statements.push(
            declare(field, 'float',
              binary('+',
                call('abs', [variable(a)], 'float'),
                call('abs', [variable(b)], 'float'),
                'float',
              ),
            ),
          )
          break
        }
        default: { // linear
          statements.push(declare(field, 'float', variable(a)))
        }
      }
    } else {
      // Stretch: field computed in raw normalized v_uv (0..1 across the full
      // canvas, aspect-distorting) — independent of `coords` wiring/SRT.
      // Bare `v_uv` mirrors image.ts's screen_uv mechanism; the WGSL assembler
      // mechanically rewrites it to `in.v_uv` (see wgsl-assembler.ts).
      const uv = variable('v_uv')
      switch (gradType) {
        case 'radial':
          // clamp(length(v_uv - 0.5) * 2.0, 0.0, 1.0)
          statements.push(
            declare(field, 'float',
              call('clamp', [
                binary('*',
                  call('length', [
                    binary('-', uv, literal('vec2', [0.5, 0.5]), 'vec2'),
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
          // atan(v_uv.y - 0.5, v_uv.x - 0.5) * (1.0 / 6.28318530718) + 0.5
          statements.push(
            declare(field, 'float',
              binary('+',
                binary('*',
                  call('atan', [
                    binary('-', swizzle(uv, 'y', 'float'), literal('float', 0.5), 'float'),
                    binary('-', swizzle(uv, 'x', 'float'), literal('float', 0.5), 'float'),
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
          // clamp((abs(v_uv.x - 0.5) + abs(v_uv.y - 0.5)) * 2.0, 0.0, 1.0)
          statements.push(
            declare(field, 'float',
              call('clamp', [
                binary('*',
                  binary('+',
                    call('abs', [
                      binary('-', swizzle(uv, 'x', 'float'), literal('float', 0.5), 'float'),
                    ], 'float'),
                    call('abs', [
                      binary('-', swizzle(uv, 'y', 'float'), literal('float', 0.5), 'float'),
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
          // v_uv.x
          statements.push(
            declare(field, 'float', swizzle(uv, 'x', 'float')),
          )
      }
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
      standardUniforms,
    }
  },
}
