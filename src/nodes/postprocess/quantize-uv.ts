/**
 * Quantize UV - Snap coordinates to pixel grid cell centers
 * When wired to noise coords, all screen pixels within the same cell evaluate
 * the same noise value — giving uniform color per cell (chunky pixel look).
 */

import type { NodeDefinition } from '../types'

export const quantizeUvNode: NodeDefinition = {
  type: 'quantize_uv',
  label: 'Quantize UV',
  category: 'Transform',
  description: 'Snap coordinates to pixel grid cell centers',

  inputs: [
    { id: 'source', label: 'Source', type: 'vec3', textureInput: true, default: [0, 0, 0] },
    { id: 'coords', label: 'Coords', type: 'vec2', default: 'auto_fragcoord' },
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
    uniforms.add('u_resolution')
    uniforms.add('u_ref_size')
    const id = ctx.nodeId.replace(/-/g, '_')
    const px = `quv_px_${id}`
    const cell = `quv_cell_${id}`
    const center = `quv_center_${id}`

    const lines: string[] = []
    // Pixel coordinates (defaults to gl_FragCoord.xy via auto_fragcoord sentinel)
    lines.push(`vec2 ${px} = ${inputs.coords};`)
    // Snap to cell center
    lines.push(`vec2 ${cell} = floor(${px} / ${inputs.pixelSize});`)
    lines.push(`vec2 ${center} = (${cell} + 0.5) * ${inputs.pixelSize};`)
    // Convert back to frozen-ref UV space (matching auto_uv)
    lines.push(`vec2 ${outputs.uv} = (${center} / u_resolution - 0.5) * u_resolution / u_ref_size + 0.5;`)

    // Color output — texture mode (source wired) vs fallback
    const samplerName = ctx.textureSamplers?.source
    if (samplerName) {
      // outputs.uv is in frozen-ref UV space; convert to v_uv (0-1) for FBO texture sampling
      const sampleUV = `quv_suv_${id}`
      lines.push(`vec2 ${sampleUV} = (${outputs.uv} - 0.5) * u_ref_size / u_resolution + 0.5;`)
      lines.push(`vec3 ${outputs.color} = texture(${samplerName}, ${sampleUV}).rgb;`)
    } else {
      lines.push(`vec3 ${outputs.color} = ${inputs.source};`)
    }

    return lines.join('\n  ')
  },
}
