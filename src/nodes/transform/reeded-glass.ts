/**
 * Reeded Glass — cylindrical lens distortion through ribbed glass.
 * Divides UV space into parallel ribs and applies a lens remap within each rib.
 *
 * Two-level hierarchy:
 *   ribType: Straight | Wave | Circular | Noise
 *     Wave    → waveShape sub-select (Sine, Triangle, Square, Sawtooth, Chevron)
 *     Noise   → noiseType sub-select (Simplex, Value, Worley)
 *     Circular / Straight → no sub-select
 */

import type { NodeDefinition, GLSLContext, SpatialConfig } from '../types'
import { addFunction, getSpatialParams } from '../types'
import { registerNoiseType, resolveNoiseFn } from '../noise/noise-functions'

const RIB_TYPE_OPTIONS = [
  { value: 'straight', label: 'Straight' },
  { value: 'wave', label: 'Wave' },
  { value: 'circular', label: 'Circular' },
  { value: 'noise', label: 'Noise' },
]

const WAVE_SHAPE_OPTIONS = [
  { value: 'sine', label: 'Sine' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'square', label: 'Square' },
  { value: 'sawtooth', label: 'Sawtooth' },
  { value: 'chevron', label: 'Chevron' },
  { value: 'u_shape', label: 'U-Shape' },
]

const NOISE_TYPE_OPTIONS = [
  { value: 'simplex', label: 'Simplex' },
  { value: 'value', label: 'Value' },
  { value: 'worley', label: 'Worley' },
]

const DIRECTION_OPTIONS = [
  { value: 'vertical', label: 'Vertical' },
  { value: 'horizontal', label: 'Horizontal' },
]

/**
 * Register the reeded glass lens function.
 * Takes the main-axis coordinate, slices, strength, and edge sharpness.
 * Returns the displaced main-axis coordinate.
 */
function registerLensFn(ctx: GLSLContext): void {
  addFunction(ctx, 'reedLens', `float reedLens(float coord, float ribW, float strength, float edge) {
  float local = mod(coord, ribW) / ribW;
  float compressed = 0.5 + (local - 0.5) * (1.0 - edge);
  float curved = 0.5 - cos(compressed * 3.14159265) * 0.5;
  float lensed = mix(compressed, curved, strength);
  return (floor(coord / ribW) + lensed) * ribW;
}`)
}

export const reededGlassNode: NodeDefinition = {
  type: 'reeded_glass',
  label: 'Reeded Glass',
  category: 'Transform',
  description: 'Cylindrical lens distortion through ribbed glass',
  spatial: { transforms: ['scale', 'rotate', 'translate'] } satisfies SpatialConfig,

  inputs: [
    { id: 'source', label: 'Source', type: 'vec3', textureInput: true, default: [0, 0, 0] },
    { id: 'coords', label: 'Coords', type: 'vec2', default: 'auto_uv' },
  ],

  outputs: [
    { id: 'color', label: 'Color', type: 'vec3' },
    { id: 'coords', label: 'Coords', type: 'vec2' },
  ],

  params: [
    ...getSpatialParams({ transforms: ['scale', 'rotate', 'translate'] }),
    {
      id: 'ribWidth', label: 'Rib Width', type: 'float', default: 20,
      min: 2, max: 200, step: 1,
      connectable: true, updateMode: 'uniform',
    },
    {
      id: 'strength', label: 'Strength', type: 'float', default: 0.5,
      min: 0, max: 1, step: 0.01,
      connectable: true, updateMode: 'uniform',
    },
    {
      id: 'edge', label: 'Edge', type: 'float', default: 0.3,
      min: 0, max: 1, step: 0.01,
      connectable: true, updateMode: 'uniform',
    },
    {
      id: 'direction', label: 'Direction', type: 'enum', default: 'vertical',
      options: DIRECTION_OPTIONS,
      updateMode: 'recompile',
    },
    {
      id: 'ribType', label: 'Rib Type', type: 'enum', default: 'straight',
      options: RIB_TYPE_OPTIONS,
      updateMode: 'recompile',
    },
    {
      id: 'waveShape', label: 'Wave Shape', type: 'enum', default: 'sine',
      options: WAVE_SHAPE_OPTIONS,
      showWhen: { ribType: 'wave' },
      updateMode: 'recompile',
    },
    {
      id: 'noiseType', label: 'Noise Type', type: 'enum', default: 'simplex',
      options: NOISE_TYPE_OPTIONS,
      showWhen: { ribType: 'noise' },
      updateMode: 'recompile',
    },
    {
      id: 'amplitude', label: 'Amplitude', type: 'float', default: 0.3,
      min: 0, max: 1, step: 0.01,
      connectable: true, updateMode: 'uniform',
      showWhen: { ribType: ['wave', 'circular', 'noise'] },
    },
    {
      id: 'frequency', label: 'Frequency', type: 'float', default: 4.0,
      min: 0.1, max: 20, step: 0.1,
      connectable: true, updateMode: 'uniform',
      showWhen: { ribType: ['wave', 'circular', 'noise'] },
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, params } = ctx
    const direction = (params.direction as string) || 'vertical'
    const ribType = (params.ribType as string) || 'straight'
    const id = ctx.nodeId.replace(/-/g, '_')

    registerLensFn(ctx)

    // main = axis being sliced, perp = perpendicular axis
    const isVert = direction === 'vertical'
    const main = isVert ? `${inputs.coords}.x` : `${inputs.coords}.y`
    const perp = isVert ? `${inputs.coords}.y` : `${inputs.coords}.x`

    const lines: string[] = []
    const warpedMain = `rg_wm_${id}`

    if (ribType === 'straight') {
      // No wave offset — lens directly on main axis
      lines.push(`float ${warpedMain} = ${main};`)
    } else {
      // Compute wave offset based on rib type + sub-shape
      const waveVal = `rg_wv_${id}`

      if (ribType === 'wave') {
        const waveShape = (params.waveShape as string) || 'sine'
        switch (waveShape) {
          case 'sine':
            lines.push(`float ${waveVal} = sin(${perp} * ${inputs.frequency} * 6.28318) * ${inputs.amplitude};`)
            break
          case 'triangle':
            lines.push(`float ${waveVal} = (abs(fract(${perp} * ${inputs.frequency}) - 0.5) * 4.0 - 1.0) * ${inputs.amplitude};`)
            break
          case 'square':
            lines.push(`float ${waveVal} = (step(0.5, fract(${perp} * ${inputs.frequency})) * 2.0 - 1.0) * ${inputs.amplitude};`)
            break
          case 'sawtooth':
            lines.push(`float ${waveVal} = (fract(${perp} * ${inputs.frequency}) * 2.0 - 1.0) * ${inputs.amplitude};`)
            break
          case 'chevron':
            lines.push(`float ${waveVal} = (abs(${perp} * 2.0 - 1.0)) * ${inputs.amplitude} * sin(${perp} * ${inputs.frequency} * 6.28318);`)
            break
          case 'u_shape':
            lines.push(`float ${waveVal} = (pow(abs(fract(${perp} * ${inputs.frequency}) * 2.0 - 1.0), 2.0) * 2.0 - 1.0) * ${inputs.amplitude};`)
            break
        }
      } else if (ribType === 'circular') {
        lines.push(`float ${waveVal} = sin(length(${inputs.coords} - 0.5) * ${inputs.frequency} * 6.28318) * ${inputs.amplitude};`)
      } else if (ribType === 'noise') {
        const noiseType = (params.noiseType as string) || 'simplex'
        registerNoiseType(ctx, noiseType)
        const noiseFn = resolveNoiseFn(noiseType)
        lines.push(`float ${waveVal} = (${noiseFn}(vec3(${perp} * ${inputs.frequency}, ${main} * 2.0, 0.0)) * 2.0 - 1.0) * ${inputs.amplitude};`)
      }

      lines.push(`float ${warpedMain} = ${main} + ${waveVal};`)
    }

    // Apply cylindrical lens remap
    const lensed = `rg_lensed_${id}`
    // Convert rib width from pixels to UV space
    ctx.uniforms.add('u_resolution')
    const ribUV = `rg_ribUV_${id}`
    lines.push(`float ${ribUV} = ${inputs.ribWidth} / u_resolution.${isVert ? 'x' : 'y'};`)
    lines.push(`float ${lensed} = reedLens(${warpedMain}, ${ribUV}, ${inputs.strength}, ${inputs.edge});`)

    // Reconstruct distorted vec2
    const distorted = `rg_distorted_${id}`
    if (isVert) {
      lines.push(`vec2 ${distorted} = vec2(${lensed}, ${inputs.coords}.y);`)
    } else {
      lines.push(`vec2 ${distorted} = vec2(${inputs.coords}.x, ${lensed});`)
    }

    // Coords output — always populated (legacy mode)
    lines.push(`vec2 ${outputs.coords} = ${distorted};`)

    // Color output — texture mode (source wired) vs fallback
    const samplerName = ctx.textureSamplers?.source
    if (samplerName) {
      // In texture mode, coords are in v_uv space (0-1) — sample directly
      lines.push(`vec3 ${outputs.color} = texture(${samplerName}, ${distorted}).rgb;`)
    } else {
      lines.push(`vec3 ${outputs.color} = ${inputs.source};`)
    }

    return lines.join('\n  ')
  },
}
