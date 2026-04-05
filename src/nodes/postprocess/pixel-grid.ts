/**
 * Pixel Grid - Post-processing node: quantization + Bayer 8x8 dithering + shape SDF
 * Pixelates input color with circle/diamond/triangle/square shape masking and ordered dithering.
 * Wire a noise value into `threshold` for binary per-cell on/off (spectra look).
 */

import type { NodeDefinition } from '../types'
import { addFunction } from '../types'
import type { IRContext, IRFunction, IRNodeOutput } from '../../compiler/ir/types'
import { variable, call, declare, raw, binary, literal } from '../../compiler/ir/types'

/** Register shared 8x8 Bayer dithering function (recursive quadrant split) */
function registerBayer(ctx: import('../types').GLSLContext) {
  addFunction(ctx, 'bayer8x8', `float bayer8x8(vec2 coord) {
  ivec2 p = ivec2(mod(coord, 8.0));
  int b = 0;
  for (int i = 0; i < 3; i++) {
    int bit = 2 - i;
    int qx = (p.x >> bit) & 1;
    int qy = (p.y >> bit) & 1;
    b += (2 * qx + 3 * qy - 4 * qx * qy) * (1 << (2 * i));
  }
  return float(b) / 63.0;
}`)
}

/** Register shape SDF functions (keyed by shape name for multi-instance safety) */
function registerShapeSDF(ctx: import('../types').GLSLContext, shape: string): string {
  if (shape === 'diamond') {
    addFunction(ctx, 'sdf_diamond', `float sdf_diamond(vec2 p) {
  return (abs(p.x) + abs(p.y)) - 0.63;
}`)
    return 'sdf_diamond'
  }
  if (shape === 'triangle') {
    addFunction(ctx, 'sdf_triangle', `float sdf_triangle(vec2 p) {
  p.y = -p.y + 0.05;
  float k = 1.732050808;
  p.x = abs(p.x) - 0.45;
  p.y = p.y + 0.45 / k;
  if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -0.9, 0.0);
  return -length(p) * sign(p.y);
}`)
    return 'sdf_triangle'
  }
  // Default: circle
  addFunction(ctx, 'sdf_circle', `float sdf_circle(vec2 p) {
  return length(p) - 0.45;
}`)
  return 'sdf_circle'
}

export const ditherNode: NodeDefinition = {
  type: 'dither',
  label: 'Dither',
  category: 'Effect',
  description: 'Pixelate with shape masking and ordered dithering',

  inputs: [
    { id: 'color', label: 'Color', type: 'vec3', default: [0.5, 0.5, 0.5] },
  ],

  outputs: [
    { id: 'result', label: 'Result', type: 'vec3' },
  ],

  params: [
    {
      id: 'pixelSize',
      label: 'Pixel Size',
      type: 'float',
      default: 8,
      min: 2,
      max: 64,
      step: 1,
      connectable: true,
      updateMode: 'uniform',
    },
    {
      id: 'shape',
      label: 'Shape',
      type: 'enum',
      default: 'circle',
      options: [
        { value: 'square', label: 'Square' },
        { value: 'circle', label: 'Circle' },
        { value: 'diamond', label: 'Diamond' },
        { value: 'triangle', label: 'Triangle' },
      ],
      updateMode: 'recompile',
    },
    {
      id: 'threshold',
      label: 'Threshold',
      type: 'float',
      default: 1.0,
      min: 0,
      max: 1,
      step: 0.01,
      connectable: true,
      updateMode: 'uniform',
    },
    {
      id: 'dither',
      label: 'Dither',
      type: 'float',
      default: 0.5,
      min: 0,
      max: 1,
      step: 0.01,
      connectable: true,
      showWhen: { shape: 'circle' },
      updateMode: 'uniform',
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, params } = ctx
    const shape = (params.shape as string) || 'circle'
    const isSquare = shape === 'square'

    // Register shared GLSL functions
    registerBayer(ctx)
    if (!isSquare) {
      registerShapeSDF(ctx, shape)
    }
    const sdfFn = isSquare ? null : registerShapeSDF(ctx, shape)

    // Unique intermediate variable names
    const id = ctx.nodeId.replace(/-/g, '_')
    const px = `pg_px_${id}`
    const cell = `pg_cell_${id}`
    const bv = `pg_bv_${id}`
    const mask = `pg_m_${id}`

    const lines: string[] = []
    // Screen-space pixel coordinates (pixelSize is in buffer pixels)
    lines.push(`vec2 ${px} = gl_FragCoord.xy;`)
    // Cell index (which big pixel)
    lines.push(`vec2 ${cell} = floor(${px} / ${inputs.pixelSize});`)
    // Bayer threshold at cell index
    lines.push(`float ${bv} = bayer8x8(${cell});`)

    if (isSquare) {
      // Binary threshold: cell is fully on or fully off
      lines.push(`float ${mask} = step(${bv}, ${inputs.threshold});`)
    } else {
      // SDF shape + binary threshold + dither edge
      const cf = `pg_cf_${id}`
      const dist = `pg_d_${id}`
      const sm = `pg_sm_${id}`
      lines.push(`vec2 ${cf} = fract(${px} / ${inputs.pixelSize}) - 0.5;`)
      lines.push(`float ${dist} = ${sdfFn}(${cf});`)
      lines.push(`float ${sm} = step(${dist} - ${inputs.dither} * (${bv} - 0.5) * 0.5, 0.0);`)
      lines.push(`float ${mask} = ${sm} * step(${bv}, ${inputs.threshold});`)
    }

    // Output: masked color on black background
    lines.push(`vec3 ${outputs.result} = ${inputs.color} * ${mask};`)

    return lines.join('\n  ')
  },

  ir: (ctx: IRContext): IRNodeOutput => {
    const shape = (ctx.params.shape as string) || 'circle'
    const isSquare = shape === 'square'
    const id = ctx.nodeId.replace(/-/g, '_')

    // --- Shared GLSL functions as IRFunction objects ---
    const functions: IRFunction[] = []

    // Bayer 8x8 dithering function
    const bayerFn: IRFunction = {
      key: 'bayer8x8',
      name: 'bayer8x8',
      params: [{ name: 'coord', type: 'vec2' }],
      returnType: 'float',
      body: [raw(
        // GLSL
        `ivec2 p = ivec2(mod(coord, 8.0));
  int b = 0;
  for (int i = 0; i < 3; i++) {
    int bit = 2 - i;
    int qx = (p.x >> bit) & 1;
    int qy = (p.y >> bit) & 1;
    b += (2 * qx + 3 * qy - 4 * qx * qy) * (1 << (2 * i));
  }
  return float(b) / 63.0;`,
        // WGSL: shift operators require u32 RHS; mod→inline formula for vec2
        `var p: vec2i = vec2i(coord - vec2f(8.0) * floor(coord / vec2f(8.0)));
  var b: i32 = 0;
  for (var i: i32 = 0; i < 3; i++) {
    var bit: i32 = 2 - i;
    var qx: i32 = (p.x >> u32(bit)) & 1;
    var qy: i32 = (p.y >> u32(bit)) & 1;
    b += (2 * qx + 3 * qy - 4 * qx * qy) * (1 << u32(2 * i));
  }
  return f32(b) / 63.0;`,
      )],
    }
    functions.push(bayerFn)

    // Shape SDF functions (only for non-square shapes)
    let sdfFnName: string | null = null
    if (!isSquare) {
      if (shape === 'diamond') {
        sdfFnName = 'sdf_diamond'
        functions.push({
          key: 'sdf_diamond',
          name: 'sdf_diamond',
          params: [{ name: 'p', type: 'vec2' }],
          returnType: 'float',
          body: [raw(`return (abs(p.x) + abs(p.y)) - 0.63;`)],
        })
      } else if (shape === 'triangle') {
        sdfFnName = 'sdf_triangle'
        functions.push({
          key: 'sdf_triangle',
          name: 'sdf_triangle',
          params: [{ name: 'p', type: 'vec2' }],
          returnType: 'float',
          body: [raw(`p.y = -p.y + 0.05;
  float k = 1.732050808;
  p.x = abs(p.x) - 0.45;
  p.y = p.y + 0.45 / k;
  if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -0.9, 0.0);
  return -length(p) * sign(p.y);`)],
        })
      } else {
        // Default: circle
        sdfFnName = 'sdf_circle'
        functions.push({
          key: 'sdf_circle',
          name: 'sdf_circle',
          params: [{ name: 'p', type: 'vec2' }],
          returnType: 'float',
          body: [raw(`return length(p) - 0.45;`)],
        })
      }
    }

    // --- Main computation as IR statements ---
    const px = `pg_px_${id}`
    const cell = `pg_cell_${id}`
    const bv = `pg_bv_${id}`
    const mask = `pg_m_${id}`

    const stmts = [
      // Screen-space pixel coordinates
      declare(px, 'vec2', variable('gl_FragCoord.xy')),
      // Cell index (which big pixel)
      declare(cell, 'vec2',
        call('floor', [
          binary('/', variable(px), variable(ctx.inputs.pixelSize), 'vec2'),
        ], 'vec2'),
      ),
      // Bayer threshold at cell index
      declare(bv, 'float', call('bayer8x8', [variable(cell)], 'float')),
    ]

    if (isSquare) {
      // Binary threshold: cell is fully on or fully off
      stmts.push(
        declare(mask, 'float',
          call('step', [variable(bv), variable(ctx.inputs.threshold)], 'float'),
        ),
      )
    } else {
      // SDF shape + binary threshold + dither edge
      const cf = `pg_cf_${id}`
      const dist = `pg_d_${id}`
      const sm = `pg_sm_${id}`

      stmts.push(
        // Fractional position within cell, centered
        declare(cf, 'vec2',
          binary('-',
            call('fract', [
              binary('/', variable(px), variable(ctx.inputs.pixelSize), 'vec2'),
            ], 'vec2'),
            literal('float', 0.5),
            'vec2',
          ),
        ),
        // SDF distance
        declare(dist, 'float', call(sdfFnName!, [variable(cf)], 'float')),
        // Smooth mask with dither
        declare(sm, 'float',
          call('step', [
            binary('-',
              variable(dist),
              binary('*',
                binary('*',
                  variable(ctx.inputs.dither),
                  binary('-', variable(bv), literal('float', 0.5), 'float'),
                  'float',
                ),
                literal('float', 0.5),
                'float',
              ),
              'float',
            ),
            literal('float', 0.0),
          ], 'float'),
        ),
        // Combined mask: shape * threshold
        declare(mask, 'float',
          binary('*',
            variable(sm),
            call('step', [variable(bv), variable(ctx.inputs.threshold)], 'float'),
            'float',
          ),
        ),
      )
    }

    // Output: masked color on black background
    stmts.push(
      declare(ctx.outputs.result, 'vec3',
        binary('*', variable(ctx.inputs.color), variable(mask), 'vec3'),
      ),
    )

    return {
      statements: stmts,
      uniforms: [],
      standardUniforms: new Set(),
      functions,
    }
  },
}
