/**
 * Bayer Dither - Standalone 8x8 ordered dither threshold pattern
 * Outputs a float threshold (0-1) for the current pixel position.
 * Wire into Mix factor or color masking for creative dithering.
 */

import type { NodeDefinition } from '../types'
import { addFunction } from '../types'

export const bayerDitherNode: NodeDefinition = {
  type: 'bayer_dither',
  label: 'Bayer Dither',
  category: 'Post-process',
  description: '8×8 ordered dither threshold pattern',

  inputs: [],

  outputs: [
    { id: 'threshold', label: 'Threshold', type: 'float' },
  ],

  params: [
    {
      id: 'scale',
      label: 'Scale',
      type: 'float',
      default: 1,
      min: 1,
      max: 8,
      step: 1,
    },
  ],

  glsl: (ctx) => {
    const { outputs, params } = ctx
    const scale = params.scale as number ?? 1

    // Register shared Bayer function (deduped with Pixel Grid)
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

    const id = ctx.nodeId.replace(/-/g, '_')
    const px = `bd_px_${id}`

    const flt = (n: number): string => Number.isInteger(n) ? `${n}.0` : `${n}`

    const lines: string[] = []
    // Screen-space pixel coordinates, divided by scale
    lines.push(`vec2 ${px} = gl_FragCoord.xy / ${flt(scale)};`)
    // Bayer threshold lookup
    lines.push(`float ${outputs.threshold} = bayer8x8(${px});`)

    return lines.join('\n  ')
  },
}
