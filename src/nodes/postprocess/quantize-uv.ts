/**
 * Quantize UV - Snap coordinates to pixel grid cell centers
 * When wired to noise coords, all screen pixels within the same cell evaluate
 * the same noise value — giving uniform color per cell (chunky pixel look).
 */

import type { NodeDefinition } from '../types'

export const quantizeUvNode: NodeDefinition = {
  type: 'quantize_uv',
  label: 'Quantize UV',
  category: 'Post-process',
  description: 'Snap coordinates to pixel grid cell centers',

  inputs: [],

  outputs: [
    { id: 'uv', label: 'UV', type: 'vec2' },
  ],

  params: [
    {
      id: 'pixelSize',
      label: 'Pixel Size',
      type: 'float',
      default: 8,
      min: 2,
      max: 256,
      step: 1,
      connectable: true,
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, uniforms } = ctx
    uniforms.add('u_resolution')
    uniforms.add('u_ref_size')
    const id = ctx.nodeId.replace(/-/g, '_')
    const px = `quv_px_${id}`
    const cell = `quv_cell_${id}`
    const center = `quv_center_${id}`

    const lines: string[] = []
    // Screen-space pixel coordinates (pixelSize is in buffer pixels)
    lines.push(`vec2 ${px} = gl_FragCoord.xy;`)
    // Snap to cell center
    lines.push(`vec2 ${cell} = floor(${px} / ${inputs.pixelSize});`)
    lines.push(`vec2 ${center} = (${cell} + 0.5) * ${inputs.pixelSize};`)
    // Convert back to frozen-ref UV space (matching auto_uv)
    lines.push(`vec2 ${outputs.uv} = (${center} / u_resolution - 0.5) * u_resolution / u_ref_size + 0.5;`)

    return lines.join('\n  ')
  },
}
