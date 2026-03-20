/**
 * Reeded Glass — cylindrical lens distortion through ribbed glass.
 * Physics-based: each rib is a cylindrical lens with Snell's law refraction.
 * The surface normal varies across the rib — flat at center, steep at edges —
 * producing characteristic magnification at centers and compression at seams.
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
 * Register the physics-based cylindrical lens function.
 *
 * Each rib has a circular arc cross-section. The displacement comes from
 * refraction through the curved surface: the surface slope increases from
 * zero at the rib center to steep at the edges, producing:
 *   - Magnification (stretching) at rib centers
 *   - Compression and bright caustic lines at rib seams
 *   - At high IOR × curvature, image inversion within each rib
 *
 * Parameters:
 *   coord     — main-axis UV coordinate
 *   ribW      — rib width in UV space
 *   ior       — index of refraction (1.0 = no effect, 1.5 = glass, 2.0 = heavy)
 *   curvature — how rounded the rib profile is (0 = flat, 1 = semicircle)
 */
function registerLensFn(ctx: GLSLContext): void {
  addFunction(ctx, 'reedLens', `float reedLens(float coord, float ribW, float ior, float curvature) {
  float local = mod(coord, ribW) / ribW;
  float x = (local - 0.5) * 2.0;  // -1 to 1

  // Circular arc surface slope: dh/dx = -x / sqrt(R² - x²)
  // 0-1: controls arc shape (0 = flat, 1 = semicircle)
  // 1-2: arc stays at max, amplifies refraction strength
  float c = clamp(curvature, 0.01, 1.0);
  float amp = curvature > 1.0 ? curvature : 1.0;
  float c2 = min(c, 0.99);
  float x2 = x * x * c2 * c2;
  float slope = x * c2 / sqrt(max(1.0 - x2, 0.001));

  // Refraction displacement: proportional to slope × (ior - 1) × amplifier
  // Negative sign: convex lens pushes rays toward center
  float disp = -slope * (ior - 1.0) * 0.5 * amp;

  float lensed = local + disp;
  return (floor(coord / ribW) + clamp(lensed, 0.0, 1.0)) * ribW;
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
      id: 'ribWidth', label: 'Rib Width', type: 'float', default: 80,
      min: 2, max: 400, step: 1,
      connectable: true, updateMode: 'uniform',
    },
    {
      id: 'ior', label: 'IOR', type: 'float', default: 1.5,
      min: 1.0, max: 3.0, step: 0.01,
      connectable: true, updateMode: 'uniform',
    },
    {
      id: 'curvature', label: 'Curvature', type: 'float', default: 0.8,
      min: 0, max: 2, step: 0.01,
      connectable: true, updateMode: 'uniform',
    },
    {
      id: 'frost', label: 'Frost', type: 'float', default: 0,
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

    // Integer-based hash for frost jitter — no sin artifacts/scanlines
    addFunction(ctx, 'reedHash', `vec2 reedHash(vec2 p) {
  uvec2 q = uvec2(floatBitsToUint(p.x), floatBitsToUint(p.y));
  q = q * 1103515245u + 12345u;
  q.x += q.y * 1664525u;
  q.y += q.x * 1013904223u;
  q = q ^ (q >> 16u);
  return vec2(q) / float(0xFFFFFFFFu) * 2.0 - 1.0;
}`)

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
    lines.push(`float ${lensed} = reedLens(${warpedMain}, ${ribUV}, ${inputs.ior}, ${inputs.curvature});`)

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
      // Displacement-based sampling: compute how much the lens shifted the
      // coordinate, then apply that displacement to v_uv (screen space).
      // The rib pattern follows SRT, but the texture stays fixed in place.
      const disp = `rg_disp_${id}`
      lines.push(`float ${disp} = ${lensed} - ${warpedMain};`)
      const sampleUV = `rg_sampleUV_${id}`
      if (isVert) {
        lines.push(`vec2 ${sampleUV} = v_uv + vec2(${disp}, 0.0);`)
      } else {
        lines.push(`vec2 ${sampleUV} = v_uv + vec2(0.0, ${disp});`)
      }

      // Frosted glass: hash-based jitter blur (grainy texture)
      const frostVar = `rg_frost_${id}`
      lines.push(`float ${frostVar} = ${inputs.frost};`)
      lines.push(`vec3 ${outputs.color};`)
      lines.push(`if (${frostVar} > 0.001) {`)
      lines.push(`  vec3 rg_acc_${id} = vec3(0.0);`)
      lines.push(`  float rg_frad_${id} = ${frostVar} * 0.02;`)
      lines.push(`  for (int rg_i_${id} = 0; rg_i_${id} < 8; rg_i_${id}++) {`)
      lines.push(`    vec2 rg_jit_${id} = reedHash(${sampleUV} * 0.1 + float(rg_i_${id}) * 7.31) * rg_frad_${id};`)
      lines.push(`    rg_acc_${id} += texture(${samplerName}, ${sampleUV} + rg_jit_${id}).rgb;`)
      lines.push(`  }`)
      lines.push(`  ${outputs.color} = rg_acc_${id} / 8.0;`)
      lines.push(`} else {`)
      lines.push(`  ${outputs.color} = texture(${samplerName}, ${sampleUV}).rgb;`)
      lines.push(`}`)
    } else {
      lines.push(`vec3 ${outputs.color} = ${inputs.source};`)
    }

    return lines.join('\n  ')
  },
}
