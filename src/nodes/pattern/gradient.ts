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
    // Stretch control points — UV (normalized 0..1 across canvas, bottom-left
    // origin, Y-up = v_uv). Renormalize on resize, so anchor-snapped handles
    // track their canvas landmark. Centre-origin defaults match Pinned
    // semantics (P0 = Start/Center). NOTE: this makes Stretch `linear` a
    // centre-origin gradient (t=0 at centre) rather than the old full-span
    // `v_uv.x`; drag P0 to the left edge to restore the old look.
    {
      id: 'p0u', label: 'Start / Center U', type: 'float', default: 0.5,
      min: 0, max: 1, step: 0.01,
      connectable: true, updateMode: 'uniform',
      showWhen: { drawMode: 'stretch' },
    },
    {
      id: 'p0v', label: 'Start / Center V', type: 'float', default: 0.5,
      min: 0, max: 1, step: 0.01,
      connectable: true, updateMode: 'uniform',
      showWhen: { drawMode: 'stretch' },
    },
    {
      id: 'p1u', label: 'End / Edge U', type: 'float', default: 1,
      min: 0, max: 1, step: 0.01,
      connectable: true, updateMode: 'uniform',
      showWhen: { drawMode: 'stretch' },
    },
    {
      id: 'p1v', label: 'End / Edge V', type: 'float', default: 0.5,
      min: 0, max: 1, step: 0.01,
      connectable: true, updateMode: 'uniform',
      showWhen: { drawMode: 'stretch' },
    },
    {
      id: 'aspectUV', label: 'Aspect', type: 'float', default: 1,
      min: 0.1, max: 10, step: 0.01,
      connectable: true, updateMode: 'uniform',
      showWhen: { drawMode: 'stretch', gradientType: ['radial', 'angular', 'diamond'] },
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

  // Two gizmo sets, gated by drawMode: 'p*' in px (Pinned, frozen) and 'p*uv'
  // in UV (Stretch, resize-tracking). No top-level showWhen — one set is always
  // visible; per-element showWhen selects which.
  gizmo: {
    points: [
      { id: 'p0', xParam: 'p0x', yParam: 'p0y', shape: 'circle', showWhen: { drawMode: 'pinned' } },
      { id: 'p1', xParam: 'p1x', yParam: 'p1y', shape: 'circle', showWhen: { drawMode: 'pinned' } },
      { id: 'p0uv', xParam: 'p0u', yParam: 'p0v', shape: 'circle', space: 'uv', showWhen: { drawMode: 'stretch' } },
      { id: 'p1uv', xParam: 'p1u', yParam: 'p1v', shape: 'circle', space: 'uv', showWhen: { drawMode: 'stretch' } },
    ],
    connectors: [
      { from: 'p0', to: 'p1' },
      { from: 'p0uv', to: 'p1uv' },
    ],
    aspectHandles: [
      {
        id: 'asp', shape: 'circle', aspectParam: 'aspect', centerPoint: 'p0', endPoint: 'p1',
        showWhen: { drawMode: 'pinned', gradientType: ['radial', 'angular', 'diamond'] },
      },
      {
        id: 'aspUV', shape: 'circle', aspectParam: 'aspectUV', centerPoint: 'p0uv', endPoint: 'p1uv',
        showWhen: { drawMode: 'stretch', gradientType: ['radial', 'angular', 'diamond'] },
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
      {
        shape: 'ellipse', centerPoint: 'p0uv', endPoint: 'p1uv', aspectParam: 'aspectUV',
        showWhen: { drawMode: 'stretch', gradientType: ['radial', 'angular'] },
      },
      {
        shape: 'diamond', centerPoint: 'p0uv', endPoint: 'p1uv', aspectParam: 'aspectUV',
        showWhen: { drawMode: 'stretch', gradientType: 'diamond' },
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

    if (ctx.isPreview) {
      // Node thumbnail: a canonical centred + fitted view over raw v_uv,
      // independent of drawMode / pin / output anchor — a predictable preview of
      // the gradient itself. Applies the active `aspect` (perpendicular axis, x
      // primary) so an ellipse/rhombus reads as such (aspect>1 → taller). Only the
      // aspect matters here — no pinning/anchoring.
      const asp = drawMode === 'stretch' ? inputs.aspectUV : inputs.aspect
      switch (gradType) {
        case 'radial':
          lines.push(`float ${field} = clamp(length(vec2((v_uv.x - 0.5) * 2.0, (v_uv.y - 0.5) * 2.0 / ${asp})), 0.0, 1.0);`)
          break
        case 'angular':
          lines.push(`float ${field} = atan((v_uv.y - 0.5) / ${asp}, v_uv.x - 0.5) * (1.0 / 6.28318530718) + 0.5;`)
          break
        case 'diamond':
          lines.push(`float ${field} = clamp((abs(v_uv.x - 0.5) + abs(v_uv.y - 0.5) / ${asp}) * 2.0, 0.0, 1.0);`)
          break
        default: // linear (aspect N/A)
          lines.push(`float ${field} = v_uv.x;`)
      }
    } else if (drawMode === 'pinned') {
      // Pinned: P0/P1 are CSS px offsets from `grad_center` = vec2(0.5). Because
      // `auto_uv` (coords) is anchor-relative, holding grad_center constant pins
      // the gradient to the Fragment Output anchor on resize. On anchor SWITCH the
      // app compensates p0/p1 (graphStore.setOutputAnchor) so it holds position
      // (survives) — the node thumbnail stays stable regardless because it renders
      // the isPreview canonical branch above, not p0/p1. Y flipped (px Y-down).
      ctx.uniforms.add('u_ref_size')
      ctx.uniforms.add('u_anchor')
      ctx.uniforms.add('u_resolution')
      ctx.uniforms.add('u_dpr')
      lines.push(`vec2 grad_center_${id} = vec2(0.5);`)

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
      // Stretch: same field basis as Pinned but in raw normalized v_uv (0..1
      // across the full canvas, aspect-distorting) — control points are UV, so
      // they renormalize on resize (a corner-snapped handle stays on the corner)
      // and no u_ref_size/anchor/SRT is involved. C = P0, P = P1; `aspectUV`
      // scales the perpendicular axis for radial/angular/diamond.
      const C = `grad_C_${id}`
      const P = `grad_P_${id}`
      const u = `grad_u_${id}`
      const L = `grad_L_${id}`
      const uh = `grad_uh_${id}`
      const vh = `grad_vh_${id}`
      const d = `grad_d_${id}`
      const a = `grad_a_${id}`
      const b = `grad_b_${id}`
      lines.push(`vec2 ${C} = vec2(${inputs.p0u}, ${inputs.p0v});`)
      lines.push(`vec2 ${P} = vec2(${inputs.p1u}, ${inputs.p1v});`)
      lines.push(`vec2 ${u} = ${P} - ${C};`)
      lines.push(`float ${L} = max(length(${u}), 1e-6);`)
      lines.push(`vec2 ${uh} = ${u} / ${L};`)
      lines.push(`vec2 ${vh} = vec2(-${uh}.y, ${uh}.x);`)
      lines.push(`vec2 ${d} = v_uv - ${C};`)
      lines.push(`float ${a} = dot(${d}, ${uh}) / ${L};`)
      lines.push(`float ${b} = dot(${d}, ${vh}) / (${inputs.aspectUV} * ${L});`)

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

    if (ctx.isPreview) {
      // Node thumbnail: canonical centred + fitted view over raw v_uv with the
      // active aspect applied (perpendicular/y axis, x primary). Mirrors GLSL.
      // Only aspect matters — no pinning/anchoring.
      const asp = variable(drawMode === 'stretch' ? ctx.inputs.aspectUV : ctx.inputs.aspect)
      const ax = () => binary('-', swizzle(variable('v_uv'), 'x', 'float'), literal('float', 0.5), 'float') // v_uv.x - 0.5
      const ay = () => binary('-', swizzle(variable('v_uv'), 'y', 'float'), literal('float', 0.5), 'float') // v_uv.y - 0.5
      switch (gradType) {
        case 'radial':
          // clamp(length(vec2(ax*2, ay*2/asp)), 0, 1)
          statements.push(declare(field, 'float',
            call('clamp', [
              call('length', [construct('vec2', [
                binary('*', ax(), literal('float', 2.0), 'float'),
                binary('/', binary('*', ay(), literal('float', 2.0), 'float'), asp, 'float'),
              ])], 'float'),
              literal('float', 0.0), literal('float', 1.0),
            ], 'float'),
          ))
          break
        case 'angular':
          // atan(ay/asp, ax) * (1/2π) + 0.5
          statements.push(declare(field, 'float',
            binary('+',
              binary('*',
                call('atan', [binary('/', ay(), asp, 'float'), ax()], 'float'),
                literal('float', 1.0 / 6.28318530718),
                'float',
              ),
              literal('float', 0.5),
              'float',
            ),
          ))
          break
        case 'diamond':
          // clamp((abs(ax) + abs(ay)/asp) * 2, 0, 1)
          statements.push(declare(field, 'float',
            call('clamp', [
              binary('*',
                binary('+',
                  call('abs', [ax()], 'float'),
                  binary('/', call('abs', [ay()], 'float'), asp, 'float'),
                  'float',
                ),
                literal('float', 2.0),
                'float',
              ),
              literal('float', 0.0), literal('float', 1.0),
            ], 'float'),
          ))
          break
        default: // linear (aspect N/A)
          statements.push(declare(field, 'float', swizzle(variable('v_uv'), 'x', 'float')))
      }
    } else if (drawMode === 'pinned') {
      // Pinned: P0/P1 are CSS px offsets from `grad_center`, a fixed coords value
      // (0.5) that maps to the canvas centre at the REFERENCE size. Because
      // `auto_uv` (coords) is anchor-relative, holding grad_center constant makes
      // the gradient PIN to the output anchor on resize (like the rest of the
      // output) instead of staying centred. Y flipped (px Y-down, coords Y-up);
      // px→units divides by u_ref_size only.
      standardUniforms.add('u_ref_size')
      standardUniforms.add('u_anchor')
      standardUniforms.add('u_resolution')
      standardUniforms.add('u_dpr')

      // grad_center = vec2(0.5) (see GLSL comment): fixed coords → pins to the
      // Fragment Output anchor on resize via anchor-relative auto_uv; the app
      // compensates p0/p1 on anchor switch (setOutputAnchor) so it survives.
      const center = `grad_center_${id}`
      statements.push(declare(center, 'vec2',
        construct('vec2', [literal('float', 0.5), literal('float', 0.5)]),
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
      // Stretch: same field basis as Pinned but in raw normalized v_uv (0..1
      // across the full canvas, aspect-distorting). Control points are UV, so
      // they renormalize on resize (a corner-snapped handle stays on the corner)
      // and no u_ref_size/anchor/SRT is involved. C = P0, P = P1; `aspectUV`
      // scales the perpendicular axis. Bare `v_uv` mirrors image.ts's screen_uv
      // mechanism; the WGSL assembler rewrites it to `in.v_uv`.
      const C = `grad_C_${id}`
      const P = `grad_P_${id}`
      const u = `grad_u_${id}`
      const L = `grad_L_${id}`
      const uh = `grad_uh_${id}`
      const vh = `grad_vh_${id}`
      const d = `grad_d_${id}`
      const a = `grad_a_${id}`
      const b = `grad_b_${id}`
      statements.push(declare(C, 'vec2', construct('vec2', [variable(ctx.inputs.p0u), variable(ctx.inputs.p0v)])))
      statements.push(declare(P, 'vec2', construct('vec2', [variable(ctx.inputs.p1u), variable(ctx.inputs.p1v)])))
      statements.push(declare(u, 'vec2', binary('-', variable(P), variable(C), 'vec2')))
      statements.push(declare(L, 'float',
        call('max', [call('length', [variable(u)], 'float'), literal('float', 1e-6)], 'float'),
      ))
      statements.push(declare(uh, 'vec2', binary('/', variable(u), variable(L), 'vec2')))
      statements.push(declare(vh, 'vec2', construct('vec2', [
        binary('*', literal('float', -1.0), swizzle(variable(uh), 'y', 'float'), 'float'),
        swizzle(variable(uh), 'x', 'float'),
      ])))
      statements.push(declare(d, 'vec2', binary('-', variable('v_uv'), variable(C), 'vec2')))
      statements.push(declare(a, 'float',
        binary('/', call('dot', [variable(d), variable(uh)], 'float'), variable(L), 'float'),
      ))
      statements.push(declare(b, 'float',
        binary('/',
          call('dot', [variable(d), variable(vh)], 'float'),
          binary('*', variable(ctx.inputs.aspectUV), variable(L), 'float'),
          'float',
        ),
      ))

      switch (gradType) {
        case 'radial': {
          statements.push(
            declare(field, 'float',
              call('length', [construct('vec2', [variable(a), variable(b)])], 'float'),
            ),
          )
          break
        }
        case 'angular': {
          const ang = `grad_ang_${id}`
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
