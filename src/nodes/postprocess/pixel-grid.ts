/**
 * Pixel Grid - Post-processing node: quantization + Bayer 8x8 dithering + shape SDF
 * Pixelates input color with circle/diamond/triangle/square shape masking and ordered dithering.
 * Wire a noise value into `threshold` for binary per-cell on/off (spectra look).
 */

import type { NodeDefinition } from '../types'
import { addFunction } from '../types'

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

export const pixelGridNode: NodeDefinition = {
  type: 'pixel_grid',
  label: 'Pixel Grid',
  category: 'Post-process',
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
      max: 20,
      step: 1,
      connectable: true,
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
}
