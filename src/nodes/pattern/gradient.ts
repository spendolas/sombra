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
      id: 'drawMode', label: 'Draw Mode', type: 'enum', default: 'stretch',
      options: [
        { value: 'stretch', label: 'Stretch' },
        { value: 'pinned', label: 'Pinned' },
      ],
      updateMode: 'recompile',
    },
    // Pinned control points — linear (Point A / Point B)
    {
      id: 'ax', label: 'Point A X', type: 'float', default: -150,
      min: -1000, max: 1000, step: 1,
      connectable: true, updateMode: 'uniform',
      showWhen: { drawMode: 'pinned', gradientType: 'linear' },
    },
    {
      id: 'ay', label: 'Point A Y', type: 'float', default: 0,
      min: -1000, max: 1000, step: 1,
      connectable: true, updateMode: 'uniform',
      showWhen: { drawMode: 'pinned', gradientType: 'linear' },
    },
    {
      id: 'bx', label: 'Point B X', type: 'float', default: 150,
      min: -1000, max: 1000, step: 1,
      connectable: true, updateMode: 'uniform',
      showWhen: { drawMode: 'pinned', gradientType: 'linear' },
    },
    {
      id: 'by', label: 'Point B Y', type: 'float', default: 0,
      min: -1000, max: 1000, step: 1,
      connectable: true, updateMode: 'uniform',
      showWhen: { drawMode: 'pinned', gradientType: 'linear' },
    },
    // Pinned control points — shared center for radial/angular/diamond
    {
      id: 'cx', label: 'Center X', type: 'float', default: 0,
      min: -1000, max: 1000, step: 1,
      connectable: true, updateMode: 'uniform',
      showWhen: { drawMode: 'pinned', gradientType: ['radial', 'angular', 'diamond'] },
    },
    {
      id: 'cy', label: 'Center Y', type: 'float', default: 0,
      min: -1000, max: 1000, step: 1,
      connectable: true, updateMode: 'uniform',
      showWhen: { drawMode: 'pinned', gradientType: ['radial', 'angular', 'diamond'] },
    },
    // Pinned control points — radial (Edge)
    {
      id: 'ex', label: 'Edge X', type: 'float', default: 150,
      min: -1000, max: 1000, step: 1,
      connectable: true, updateMode: 'uniform',
      showWhen: { drawMode: 'pinned', gradientType: 'radial' },
    },
    {
      id: 'ey', label: 'Edge Y', type: 'float', default: 0,
      min: -1000, max: 1000, step: 1,
      connectable: true, updateMode: 'uniform',
      showWhen: { drawMode: 'pinned', gradientType: 'radial' },
    },
    // Pinned control points — angular (Angle ref)
    {
      id: 'rx', label: 'Angle Ref X', type: 'float', default: 150,
      min: -1000, max: 1000, step: 1,
      connectable: true, updateMode: 'uniform',
      showWhen: { drawMode: 'pinned', gradientType: 'angular' },
    },
    {
      id: 'ry', label: 'Angle Ref Y', type: 'float', default: 0,
      min: -1000, max: 1000, step: 1,
      connectable: true, updateMode: 'uniform',
      showWhen: { drawMode: 'pinned', gradientType: 'angular' },
    },
    // Pinned control points — diamond (Corner)
    {
      id: 'kx', label: 'Corner X', type: 'float', default: 150,
      min: -1000, max: 1000, step: 1,
      connectable: true, updateMode: 'uniform',
      showWhen: { drawMode: 'pinned', gradientType: 'diamond' },
    },
    {
      id: 'ky', label: 'Corner Y', type: 'float', default: 0,
      min: -1000, max: 1000, step: 1,
      connectable: true, updateMode: 'uniform',
      showWhen: { drawMode: 'pinned', gradientType: 'diamond' },
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
      { id: 'a', xParam: 'ax', yParam: 'ay', showWhen: { gradientType: 'linear' } },
      { id: 'b', xParam: 'bx', yParam: 'by', showWhen: { gradientType: 'linear' } },
      { id: 'c', xParam: 'cx', yParam: 'cy', role: 'center', showWhen: { gradientType: ['radial', 'angular', 'diamond'] } },
      { id: 'e', xParam: 'ex', yParam: 'ey', showWhen: { gradientType: 'radial' } },
      { id: 'r', xParam: 'rx', yParam: 'ry', showWhen: { gradientType: 'angular' } },
      { id: 'k', xParam: 'kx', yParam: 'ky', showWhen: { gradientType: 'diamond' } },
    ],
    connectors: [
      { from: 'a', to: 'b' },
      { from: 'c', to: 'e' },
      { from: 'c', to: 'r' },
      { from: 'c', to: 'k' },
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

      switch (gradType) {
        case 'radial': {
          const C = `grad_C_${id}`
          const E = `grad_E_${id}`
          pt(C, inputs.cx, inputs.cy)
          pt(E, inputs.ex, inputs.ey)
          lines.push(`float ${field} = length(${inputs.coords} - ${C}) / max(length(${E} - ${C}), 1e-6);`)
          break
        }
        case 'angular': {
          const C = `grad_C_${id}`
          const R = `grad_R_${id}`
          const f = `grad_f_${id}`
          const d = `grad_d_${id}`
          pt(C, inputs.cx, inputs.cy)
          pt(R, inputs.rx, inputs.ry)
          lines.push(`vec2 ${f} = ${R} - ${C};`)
          lines.push(`vec2 ${d} = ${inputs.coords} - ${C};`)
          lines.push(`float ${field} = atan(${d}.x * ${f}.y - ${d}.y * ${f}.x, dot(${d}, ${f})) * (1.0 / 6.28318530718) + 0.5;`)
          break
        }
        case 'diamond': {
          const C = `grad_C_${id}`
          const K = `grad_K_${id}`
          const u = `grad_u_${id}`
          const ulen = `grad_ulen_${id}`
          const uhat = `grad_uhat_${id}`
          const uperp = `grad_uperp_${id}`
          const d = `grad_d_${id}`
          pt(C, inputs.cx, inputs.cy)
          pt(K, inputs.kx, inputs.ky)
          lines.push(`vec2 ${u} = ${K} - ${C};`)
          lines.push(`float ${ulen} = max(length(${u}), 1e-6);`)
          lines.push(`vec2 ${uhat} = ${u} / ${ulen};`)
          lines.push(`vec2 ${uperp} = vec2(-${uhat}.y, ${uhat}.x);`)
          lines.push(`vec2 ${d} = ${inputs.coords} - ${C};`)
          lines.push(`float ${field} = (abs(dot(${d}, ${uhat})) + abs(dot(${d}, ${uperp}))) / ${ulen};`)
          break
        }
        default: { // linear
          const A = `grad_A_${id}`
          const B = `grad_B_${id}`
          pt(A, inputs.ax, inputs.ay)
          pt(B, inputs.bx, inputs.by)
          lines.push(`float ${field} = dot(${inputs.coords} - ${A}, ${B} - ${A}) / max(dot(${B} - ${A}, ${B} - ${A}), 1e-6);`)
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

      switch (gradType) {
        case 'radial': {
          const C = `grad_C_${id}`
          const E = `grad_E_${id}`
          statements.push(declare(C, 'vec2', ptExpr('cx', 'cy')))
          statements.push(declare(E, 'vec2', ptExpr('ex', 'ey')))
          // length(coords - C) / max(length(E - C), 1e-6)
          statements.push(
            declare(field, 'float',
              binary('/',
                call('length', [binary('-', coords, variable(C), 'vec2')], 'float'),
                call('max', [
                  call('length', [binary('-', variable(E), variable(C), 'vec2')], 'float'),
                  literal('float', 1e-6),
                ], 'float'),
                'float',
              ),
            ),
          )
          break
        }
        case 'angular': {
          const C = `grad_C_${id}`
          const R = `grad_R_${id}`
          const f = `grad_f_${id}`
          const d = `grad_d_${id}`
          statements.push(declare(C, 'vec2', ptExpr('cx', 'cy')))
          statements.push(declare(R, 'vec2', ptExpr('rx', 'ry')))
          statements.push(declare(f, 'vec2', binary('-', variable(R), variable(C), 'vec2')))
          statements.push(declare(d, 'vec2', binary('-', coords, variable(C), 'vec2')))
          // det = d.x*f.y - d.y*f.x ; dotv = dot(d, f)
          // atan(det, dotv) * (1.0 / 6.28318530718) + 0.5
          const det = binary('-',
            binary('*', swizzle(variable(d), 'x', 'float'), swizzle(variable(f), 'y', 'float'), 'float'),
            binary('*', swizzle(variable(d), 'y', 'float'), swizzle(variable(f), 'x', 'float'), 'float'),
            'float',
          )
          const dotv = call('dot', [variable(d), variable(f)], 'float')
          statements.push(
            declare(field, 'float',
              binary('+',
                binary('*',
                  call('atan', [det, dotv], 'float'),
                  literal('float', 1.0 / 6.28318530718),
                  'float',
                ),
                literal('float', 0.5),
                'float',
              ),
            ),
          )
          break
        }
        case 'diamond': {
          const C = `grad_C_${id}`
          const K = `grad_K_${id}`
          const u = `grad_u_${id}`
          const ulen = `grad_ulen_${id}`
          const uhat = `grad_uhat_${id}`
          const uperp = `grad_uperp_${id}`
          const d = `grad_d_${id}`
          statements.push(declare(C, 'vec2', ptExpr('cx', 'cy')))
          statements.push(declare(K, 'vec2', ptExpr('kx', 'ky')))
          statements.push(declare(u, 'vec2', binary('-', variable(K), variable(C), 'vec2')))
          statements.push(declare(ulen, 'float',
            call('max', [call('length', [variable(u)], 'float'), literal('float', 1e-6)], 'float'),
          ))
          statements.push(declare(uhat, 'vec2', binary('/', variable(u), variable(ulen), 'vec2')))
          // perpendicular: (-uhat.y, uhat.x)
          statements.push(declare(uperp, 'vec2', construct('vec2', [
            binary('*', literal('float', -1.0), swizzle(variable(uhat), 'y', 'float'), 'float'),
            swizzle(variable(uhat), 'x', 'float'),
          ])))
          statements.push(declare(d, 'vec2', binary('-', coords, variable(C), 'vec2')))
          // (|dot(d, uhat)| + |dot(d, uperp)|) / ulen
          statements.push(
            declare(field, 'float',
              binary('/',
                binary('+',
                  call('abs', [call('dot', [variable(d), variable(uhat)], 'float')], 'float'),
                  call('abs', [call('dot', [variable(d), variable(uperp)], 'float')], 'float'),
                  'float',
                ),
                variable(ulen),
                'float',
              ),
            ),
          )
          break
        }
        default: { // linear
          const A = `grad_A_${id}`
          const B = `grad_B_${id}`
          statements.push(declare(A, 'vec2', ptExpr('ax', 'ay')))
          statements.push(declare(B, 'vec2', ptExpr('bx', 'by')))
          // dot(coords - A, B - A) / max(dot(B - A, B - A), 1e-6)
          statements.push(
            declare(field, 'float',
              binary('/',
                call('dot', [
                  binary('-', coords, variable(A), 'vec2'),
                  binary('-', variable(B), variable(A), 'vec2'),
                ], 'float'),
                call('max', [
                  call('dot', [
                    binary('-', variable(B), variable(A), 'vec2'),
                    binary('-', variable(B), variable(A), 'vec2'),
                  ], 'float'),
                  literal('float', 1e-6),
                ], 'float'),
                'float',
              ),
            ),
          )
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
