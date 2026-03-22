/**
 * Pixelate — Snap UV to pixel grid, sampling one color per cell block.
 */

import type { NodeDefinition } from '../types'

export const pixelateNode: NodeDefinition = {
  type: 'pixelate',
  label: 'Pixelate',
  category: 'Effect',
  description: 'Reduce image to chunky pixel blocks',
  hidePreview: true,

  inputs: [
    { id: 'source', label: 'Source', type: 'vec3', textureInput: true, default: [0, 0, 0] },
    { id: 'coords', label: 'Coords', type: 'vec2', default: 'screen_uv' },
  ],

  outputs: [
    { id: 'color', label: 'Color', type: 'vec3' },
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
      updateMode: 'uniform',
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, uniforms } = ctx
    uniforms.add('u_viewport')
    const id = ctx.nodeId.replace(/-/g, '_')

    const lines: string[] = []

    // Grid in actual pixel space — cells are pixelSize × pixelSize screen pixels
    lines.push(`vec2 pxl_cell_${id} = floor(gl_FragCoord.xy / vec2(${inputs.pixelSize}));`)
    // UV at cell center — normalize by actual render target size (not main canvas)
    lines.push(`vec2 ${outputs.uv} = (pxl_cell_${id} + 0.5) * vec2(${inputs.pixelSize}) / u_viewport;`)

    // Color output
    const samplerName = ctx.textureSamplers?.source
    if (samplerName) {
      lines.push(`vec3 ${outputs.color} = texture(${samplerName}, ${outputs.uv}).rgb;`)
    } else {
      lines.push(`float pxl_ck_${id} = mod(pxl_cell_${id}.x + pxl_cell_${id}.y, 2.0);`)
      lines.push(`vec3 ${outputs.color} = mix(vec3(0.15), vec3(0.3), pxl_ck_${id});`)
    }

    return lines.join('\n  ')
  },
}
