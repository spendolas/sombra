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

import type { NodeDefinition, GLSLContext } from '../types'
import { addFunction, getSpatialParams } from '../types'
import { registerNoiseType, resolveNoiseFn, getIRNoiseFunctions } from '../noise/noise-functions'
import type { IRContext, IRFunction, IRNodeOutput, IRStmt } from '../../compiler/ir/types'
import { variable, call, declare, construct, binary, literal, raw } from '../../compiler/ir/types'

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
  category: 'Effect',
  description: 'Cylindrical lens distortion through ribbed glass',

  inputs: [
    { id: 'source', label: 'Source', type: 'vec3', textureInput: true, default: [0, 0, 0] },
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
      id: 'amplitude', label: 'Amplitude', type: 'float', default: 20,
      min: 0, max: 200, step: 1,
      connectable: true, updateMode: 'uniform',
      showWhen: { ribType: ['wave', 'circular', 'noise'] },
    },
    {
      id: 'wavelength', label: 'Wavelength', type: 'float', default: 200,
      min: 10, max: 1000, step: 1,
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

    const isVert = direction === 'vertical'
    const lines: string[] = []

    // Generate auto_uv with SRT applied (frozen-ref space)
    ctx.uniforms.add('u_resolution')
    ctx.uniforms.add('u_dpr')
    ctx.uniforms.add('u_ref_size')
    ctx.uniforms.add('u_anchor')
    const coordsVar = `rg_coords_${id}`
    lines.push(`vec2 ${coordsVar} = (vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y) - u_resolution * u_anchor) / (u_dpr * u_ref_size) + u_anchor;`)
    // SRT: center → scale → rotate (aspect-corrected) → translate → re-center
    lines.push(`${coordsVar} -= u_anchor;`)
    lines.push(`${coordsVar} /= vec2(${inputs.srt_scale});`)
    const aspRef = `rg_asp_ref_${id}`
    const radRef = `rg_rad_ref_${id}`
    lines.push(`float ${aspRef} = u_resolution.x / u_resolution.y;`)
    lines.push(`float ${radRef} = ${inputs.srt_rotate} * 0.01745329;`)
    lines.push(`${coordsVar}.x *= ${aspRef};`)
    lines.push(`${coordsVar} = vec2(${coordsVar}.x * cos(${radRef}) - ${coordsVar}.y * sin(${radRef}), ${coordsVar}.x * sin(${radRef}) + ${coordsVar}.y * cos(${radRef}));`)
    lines.push(`${coordsVar}.x /= ${aspRef};`)
    lines.push(`${coordsVar} -= vec2(${inputs.srt_translateX}, -(${inputs.srt_translateY})) / (u_dpr * u_ref_size);`)
    lines.push(`${coordsVar} += u_anchor;`)

    // main = axis being sliced, perp = perpendicular axis
    const main = isVert ? `${coordsVar}.x` : `${coordsVar}.y`
    const perp = isVert ? `${coordsVar}.y` : `${coordsVar}.x`

    const warpedMain = `rg_wm_${id}`

    // Convert amplitude and wavelength from pixels to frozen-ref UV
    const ampRef = `rg_amp_ref_${id}`
    const wlRef = `rg_wl_ref_${id}`
    lines.push(`float ${ampRef} = ${inputs.amplitude} / u_ref_size;`)
    lines.push(`float ${wlRef} = ${inputs.wavelength} / u_ref_size;`)

    if (ribType === 'straight') {
      lines.push(`float ${warpedMain} = ${main};`)
    } else {
      const waveVal = `rg_wv_${id}`

      if (ribType === 'wave') {
        const waveShape = (params.waveShape as string) || 'sine'
        switch (waveShape) {
          case 'sine':
            lines.push(`float ${waveVal} = sin(${perp} / ${wlRef} * 6.28318) * ${ampRef};`); break
          case 'triangle':
            lines.push(`float ${waveVal} = (abs(fract(${perp} / ${wlRef}) - 0.5) * 4.0 - 1.0) * ${ampRef};`); break
          case 'square':
            lines.push(`float ${waveVal} = (step(0.5, fract(${perp} / ${wlRef})) * 2.0 - 1.0) * ${ampRef};`); break
          case 'sawtooth':
            lines.push(`float ${waveVal} = (fract(${perp} / ${wlRef}) * 2.0 - 1.0) * ${ampRef};`); break
          case 'chevron':
            lines.push(`float ${waveVal} = (abs(${perp} * 2.0 - 1.0)) * ${ampRef} * sin(${perp} / ${wlRef} * 6.28318);`); break
          case 'u_shape':
            lines.push(`float ${waveVal} = (pow(abs(fract(${perp} / ${wlRef}) * 2.0 - 1.0), 2.0) * 2.0 - 1.0) * ${ampRef};`); break
        }
      } else if (ribType === 'circular') {
        lines.push(`float ${waveVal} = sin(length(${coordsVar} - 0.5) / ${wlRef} * 6.28318) * ${ampRef};`)
      } else if (ribType === 'noise') {
        const noiseType = (params.noiseType as string) || 'simplex'
        registerNoiseType(ctx, noiseType)
        const noiseFn = resolveNoiseFn(noiseType)
        lines.push(`float ${waveVal} = (${noiseFn}(vec3(${perp} / ${wlRef}, ${main} / ${wlRef}, 0.0)) * 2.0 - 1.0) * ${ampRef};`)
      }

      lines.push(`float ${warpedMain} = ${main} + ${waveVal};`)
    }

    // Rib width in frozen-ref UV space (for coords output)
    ctx.uniforms.add('u_ref_size')
    const ribUVRef = `rg_ribUV_ref_${id}`
    lines.push(`float ${ribUVRef} = ${inputs.ribWidth} / u_ref_size;`)

    // Rib width in screen UV space (for texture mode sampling)
    ctx.uniforms.add('u_resolution')
    ctx.uniforms.add('u_dpr')
    const ribUVScreen = `rg_ribUV_scr_${id}`
    lines.push(`float ${ribUVScreen} = ${inputs.ribWidth} * u_dpr / u_resolution.${isVert ? 'x' : 'y'};`)

    // Lens remap in frozen-ref space (for coords output)
    const lensedRef = `rg_lensed_ref_${id}`
    lines.push(`float ${lensedRef} = reedLens(${warpedMain}, ${ribUVRef}, ${inputs.ior}, ${inputs.curvature});`)

    // Reconstruct distorted vec2 (frozen-ref coords output)
    const distorted = `rg_distorted_${id}`
    if (isVert) {
      lines.push(`vec2 ${distorted} = vec2(${lensedRef}, ${coordsVar}.y);`)
    } else {
      lines.push(`vec2 ${distorted} = vec2(${coordsVar}.x, ${lensedRef});`)
    }

    // Coords output — always populated
    lines.push(`vec2 ${outputs.coords} = ${distorted};`)

    // Color output — texture mode (source wired) vs fallback
    const samplerName = ctx.textureSamplers?.source
    if (samplerName) {
      // Apply SRT to screen UV coords for rib pattern
      const srtScr = `rg_srt_scr_${id}`
      lines.push(`vec2 ${srtScr} = v_uv - vec2(u_anchor.x, 1.0 - u_anchor.y);`)
      lines.push(`${srtScr} /= vec2(${inputs.srt_scale});`)
      // Rotate with aspect correction
      const aspScr = `rg_asp_scr_${id}`
      const radScr = `rg_rad_scr_${id}`
      lines.push(`float ${aspScr} = u_resolution.x / u_resolution.y;`)
      lines.push(`float ${radScr} = ${inputs.srt_rotate} * 0.01745329;`)
      lines.push(`${srtScr}.x *= ${aspScr};`)
      lines.push(`${srtScr} = vec2(${srtScr}.x * cos(${radScr}) - ${srtScr}.y * sin(${radScr}), ${srtScr}.x * sin(${radScr}) + ${srtScr}.y * cos(${radScr}));`)
      lines.push(`${srtScr}.x /= ${aspScr};`)
      // Translate in screen UV (pixels → screen UV)
      lines.push(`${srtScr} -= vec2(${inputs.srt_translateX}, -(${inputs.srt_translateY})) * u_dpr / u_resolution;`)

      const mainScr = isVert ? `${srtScr}.x` : `${srtScr}.y`
      const perpScr = isVert ? `${srtScr}.y` : `${srtScr}.x`
      const warpedMainScr = `rg_wm_scr_${id}`

      // Convert amplitude (main axis) and wavelength (perp axis) from pixels to screen UV
      const resMain = isVert ? 'u_resolution.x' : 'u_resolution.y'
      const resPerp = isVert ? 'u_resolution.y' : 'u_resolution.x'
      const ampScr = `rg_amp_scr_${id}`
      const wlScr = `rg_wl_scr_${id}`
      lines.push(`float ${ampScr} = ${inputs.amplitude} * u_dpr / ${resMain};`)
      lines.push(`float ${wlScr} = ${inputs.wavelength} * u_dpr / ${resPerp};`)
      // Pixel-space wavelength for isotropic noise/circular sampling
      const wlPx = `(${inputs.wavelength} * u_dpr)`

      if (ribType === 'straight') {
        lines.push(`float ${warpedMainScr} = ${mainScr};`)
      } else {
        const waveValScr = `rg_wv_scr_${id}`
        if (ribType === 'wave') {
          const waveShape = (params.waveShape as string) || 'sine'
          switch (waveShape) {
            case 'sine':
              lines.push(`float ${waveValScr} = sin(${perpScr} / ${wlScr} * 6.28318) * ${ampScr};`); break
            case 'triangle':
              lines.push(`float ${waveValScr} = (abs(fract(${perpScr} / ${wlScr}) - 0.5) * 4.0 - 1.0) * ${ampScr};`); break
            case 'square':
              lines.push(`float ${waveValScr} = (step(0.5, fract(${perpScr} / ${wlScr})) * 2.0 - 1.0) * ${ampScr};`); break
            case 'sawtooth':
              lines.push(`float ${waveValScr} = (fract(${perpScr} / ${wlScr}) * 2.0 - 1.0) * ${ampScr};`); break
            case 'chevron':
              lines.push(`float ${waveValScr} = abs(${perpScr} * ${resPerp} / ${wlPx}) * ${ampScr} * sin(${perpScr} / ${wlScr} * 6.28318);`); break
            case 'u_shape':
              lines.push(`float ${waveValScr} = (pow(abs(fract(${perpScr} / ${wlScr}) * 2.0 - 1.0), 2.0) * 2.0 - 1.0) * ${ampScr};`); break
          }
        } else if (ribType === 'circular') {
          lines.push(`float ${waveValScr} = sin(length((v_uv - vec2(u_anchor.x, 1.0 - u_anchor.y)) * u_resolution) / ${wlPx} * 6.28318) * ${ampScr};`)
        } else if (ribType === 'noise') {
          const noiseType = (params.noiseType as string) || 'simplex'
          const noiseFn = resolveNoiseFn(noiseType)
          lines.push(`float ${waveValScr} = (${noiseFn}(vec3(${perpScr} * ${resPerp} / ${wlPx}, ${mainScr} * ${resMain} / ${wlPx}, 0.0)) * 2.0 - 1.0) * ${ampScr};`)
        }
        lines.push(`float ${warpedMainScr} = ${mainScr} + ${waveValScr};`)
      }

      // Lens in screen UV space
      const lensedScreen = `rg_lensed_scr_${id}`
      lines.push(`float ${lensedScreen} = reedLens(${warpedMainScr}, ${ribUVScreen}, ${inputs.ior}, ${inputs.curvature});`)
      const disp = `rg_disp_${id}`
      lines.push(`float ${disp} = ${lensedScreen} - ${warpedMainScr};`)
      // Use gl_FragCoord/viewport instead of v_uv for FBO sampling —
      // on WGSL, in.position.y=0 at top matches WebGPU texture convention,
      // while v_uv.y=0 at bottom does not.
      ctx.uniforms.add('u_viewport')
      const sampleUV = `rg_sampleUV_${id}`
      if (isVert) {
        lines.push(`vec2 ${sampleUV} = gl_FragCoord.xy / u_viewport + vec2(${disp}, 0.0);`)
      } else {
        lines.push(`vec2 ${sampleUV} = gl_FragCoord.xy / u_viewport + vec2(0.0, ${disp});`)
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

  ir: (ctx: IRContext): IRNodeOutput => {

    const direction = (ctx.params.direction as string) || 'vertical'
    const ribType = (ctx.params.ribType as string) || 'straight'
    const isVert = direction === 'vertical'
    const id = ctx.nodeId.replace(/-/g, '_')

    // --- Shared GLSL functions as IRFunction objects ---
    const functions: IRFunction[] = []

    // Cylindrical lens function
    const lensFn: IRFunction = {
      key: 'reedLens',
      name: 'reedLens',
      params: [
        { name: 'coord', type: 'float' },
        { name: 'ribW', type: 'float' },
        { name: 'ior', type: 'float' },
        { name: 'curvature', type: 'float' },
      ],
      returnType: 'float',
      body: [raw(`float local = mod(coord, ribW) / ribW;
  float x = (local - 0.5) * 2.0;
  float c = clamp(curvature, 0.01, 1.0);
  float amp = curvature > 1.0 ? curvature : 1.0;
  float c2 = min(c, 0.99);
  float x2 = x * x * c2 * c2;
  float slope = x * c2 / sqrt(max(1.0 - x2, 0.001));
  float disp = -slope * (ior - 1.0) * 0.5 * amp;
  float lensed = local + disp;
  return (floor(coord / ribW) + clamp(lensed, 0.0, 1.0)) * ribW;`)],
    }
    functions.push(lensFn)

    // Integer-based hash for frost jitter
    const hashFn: IRFunction = {
      key: 'reedHash',
      name: 'reedHash',
      params: [{ name: 'p', type: 'vec2' }],
      returnType: 'vec2',
      body: [raw(
        // GLSL
        `uvec2 q = uvec2(floatBitsToUint(p.x), floatBitsToUint(p.y));
  q = q * 1103515245u + 12345u;
  q.x += q.y * 1664525u;
  q.y += q.x * 1013904223u;
  q = q ^ (q >> 16u);
  return vec2(q) / float(0xFFFFFFFFu) * 2.0 - 1.0;`,
        // WGSL: vec2<u32> >> requires vec2<u32> RHS (not scalar u32)
        `var q: vec2<u32> = vec2<u32>(bitcast<u32>(p.x), bitcast<u32>(p.y));
  q = q * vec2<u32>(1103515245u) + vec2<u32>(12345u);
  q.x += q.y * 1664525u;
  q.y += q.x * 1013904223u;
  q = q ^ (q >> vec2<u32>(16u));
  return vec2f(q) / f32(0xFFFFFFFFu) * 2.0 - 1.0;`,
      )],
    }
    functions.push(hashFn)

    // --- Main computation ---
    const stmts: IRStmt[] = []

    // Generate auto_uv with SRT applied (frozen-ref space)
    // WGSL: in.position.y is already top-to-bottom — NO y-flip needed
    const coordsVar = `rg_coords_${id}`
    // WGSL needs `var` (mutable) since SRT modifies it in-place
    stmts.push(raw(
      // GLSL
      `vec2 ${coordsVar} = (vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y) - u_resolution * u_anchor) / (u_dpr * u_ref_size) + u_anchor;`,
      // WGSL
      `var ${coordsVar}: vec2f = (in.position.xy - uniforms.u_resolution * uniforms.u_anchor) / (uniforms.u_dpr * uniforms.u_ref_size) + uniforms.u_anchor;`,
    ))
    // SRT: center → scale → rotate (aspect-corrected) → translate → re-center
    stmts.push(raw(
      // GLSL
      `${coordsVar} -= u_anchor;\n` +
      `  ${coordsVar} /= vec2(${ctx.inputs.srt_scale});\n` +
      `  float rg_asp_ref_${id} = u_resolution.x / u_resolution.y;\n` +
      `  float rg_rad_ref_${id} = ${ctx.inputs.srt_rotate} * 0.01745329;\n` +
      `  ${coordsVar}.x *= rg_asp_ref_${id};\n` +
      `  ${coordsVar} = vec2(${coordsVar}.x * cos(rg_rad_ref_${id}) - ${coordsVar}.y * sin(rg_rad_ref_${id}), ${coordsVar}.x * sin(rg_rad_ref_${id}) + ${coordsVar}.y * cos(rg_rad_ref_${id}));\n` +
      `  ${coordsVar}.x /= rg_asp_ref_${id};\n` +
      `  ${coordsVar} -= vec2(${ctx.inputs.srt_translateX}, -(${ctx.inputs.srt_translateY})) / (u_dpr * u_ref_size);\n` +
      `  ${coordsVar} += u_anchor;`,
      // WGSL
      `${coordsVar} -= uniforms.u_anchor;\n` +
      `  ${coordsVar} /= vec2f(${ctx.inputs.srt_scale});\n` +
      `  var rg_asp_ref_${id}: f32 = uniforms.u_resolution.x / uniforms.u_resolution.y;\n` +
      `  var rg_rad_ref_${id}: f32 = ${ctx.inputs.srt_rotate} * 0.01745329;\n` +
      `  ${coordsVar}.x *= rg_asp_ref_${id};\n` +
      `  ${coordsVar} = vec2f(${coordsVar}.x * cos(rg_rad_ref_${id}) - ${coordsVar}.y * sin(rg_rad_ref_${id}), ${coordsVar}.x * sin(rg_rad_ref_${id}) + ${coordsVar}.y * cos(rg_rad_ref_${id}));\n` +
      `  ${coordsVar}.x /= rg_asp_ref_${id};\n` +
      `  ${coordsVar} -= vec2f(${ctx.inputs.srt_translateX}, -(${ctx.inputs.srt_translateY})) / (uniforms.u_dpr * uniforms.u_ref_size);\n` +
      `  ${coordsVar} += uniforms.u_anchor;`,
    ))

    const mainAxis = isVert ? `${coordsVar}.x` : `${coordsVar}.y`
    const perpAxis = isVert ? `${coordsVar}.y` : `${coordsVar}.x`

    const warpedMain = `rg_wm_${id}`

    // Convert amplitude and wavelength from pixels to frozen-ref UV
    const ampRef = `rg_amp_ref_${id}`
    const wlRef = `rg_wl_ref_${id}`
    stmts.push(raw(`float ${ampRef} = ${ctx.inputs.amplitude} / u_ref_size;`))
    stmts.push(raw(`float ${wlRef} = ${ctx.inputs.wavelength} / u_ref_size;`))

    if (ribType === 'straight') {
      stmts.push(declare(warpedMain, 'float', variable(mainAxis)))
    } else {
      const waveVal = `rg_wv_${id}`

      if (ribType === 'wave') {
        const waveShape = (ctx.params.waveShape as string) || 'sine'
        switch (waveShape) {
          case 'sine':
            stmts.push(raw(`float ${waveVal} = sin(${perpAxis} / ${wlRef} * 6.28318) * ${ampRef};`)); break
          case 'triangle':
            stmts.push(raw(`float ${waveVal} = (abs(fract(${perpAxis} / ${wlRef}) - 0.5) * 4.0 - 1.0) * ${ampRef};`)); break
          case 'square':
            stmts.push(raw(`float ${waveVal} = (step(0.5, fract(${perpAxis} / ${wlRef})) * 2.0 - 1.0) * ${ampRef};`)); break
          case 'sawtooth':
            stmts.push(raw(`float ${waveVal} = (fract(${perpAxis} / ${wlRef}) * 2.0 - 1.0) * ${ampRef};`)); break
          case 'chevron':
            stmts.push(raw(`float ${waveVal} = (abs(${perpAxis} * 2.0 - 1.0)) * ${ampRef} * sin(${perpAxis} / ${wlRef} * 6.28318);`)); break
          case 'u_shape':
            stmts.push(raw(`float ${waveVal} = (pow(abs(fract(${perpAxis} / ${wlRef}) * 2.0 - 1.0), 2.0) * 2.0 - 1.0) * ${ampRef};`)); break
        }
      } else if (ribType === 'circular') {
        stmts.push(raw(`float ${waveVal} = sin(length(${coordsVar} - 0.5) / ${wlRef} * 6.28318) * ${ampRef};`))
      } else if (ribType === 'noise') {
        const noiseType = (ctx.params.noiseType as string) || 'simplex'
        const noiseFn = resolveNoiseFn(noiseType)
        functions.push(...getIRNoiseFunctions(noiseType))
        stmts.push(raw(`float ${waveVal} = (${noiseFn}(vec3(${perpAxis} / ${wlRef}, ${mainAxis} / ${wlRef}, 0.0)) * 2.0 - 1.0) * ${ampRef};`))
      }

      stmts.push(
        declare(warpedMain, 'float',
          binary('+', variable(mainAxis), variable(waveVal), 'float'),
        ),
      )
    }

    // Rib width in frozen-ref UV (for coords output)
    const ribUVRef = `rg_ribUV_ref_${id}`
    stmts.push(
      declare(ribUVRef, 'float',
        binary('/', variable(ctx.inputs.ribWidth), variable('u_ref_size'), 'float'),
      ),
    )

    // Rib width in screen UV (for texture mode)
    const resComponent = isVert ? 'u_resolution.x' : 'u_resolution.y'
    const ribUVScreen = `rg_ribUV_scr_${id}`
    stmts.push(
      declare(ribUVScreen, 'float',
        binary('/',
          binary('*', variable(ctx.inputs.ribWidth), variable('u_dpr'), 'float'),
          variable(resComponent),
          'float',
        ),
      ),
    )

    // Lens remap in frozen-ref space (for coords output)
    const lensedRef = `rg_lensed_ref_${id}`
    stmts.push(
      declare(lensedRef, 'float',
        call('reedLens', [
          variable(warpedMain),
          variable(ribUVRef),
          variable(ctx.inputs.ior),
          variable(ctx.inputs.curvature),
        ], 'float'),
      ),
    )

    // Reconstruct distorted vec2 (frozen-ref coords output)
    const distorted = `rg_distorted_${id}`
    if (isVert) {
      stmts.push(
        declare(distorted, 'vec2',
          construct('vec2', [variable(lensedRef), variable(`${coordsVar}.y`)]),
        ),
      )
    } else {
      stmts.push(
        declare(distorted, 'vec2',
          construct('vec2', [variable(`${coordsVar}.x`), variable(lensedRef)]),
        ),
      )
    }

    // Coords output
    stmts.push(
      declare(ctx.outputs.coords, 'vec2', variable(distorted)),
    )

    // Color output — texture mode vs non-texture fallback
    const samplerName = ctx.textureSamplers?.source
    if (samplerName) {
      // Apply SRT to screen UV coords for rib pattern
      const srtScr = `rg_srt_scr_${id}`
      stmts.push(raw(`vec2 ${srtScr} = v_uv - vec2(u_anchor.x, 1.0 - u_anchor.y);`))
      stmts.push(raw(`${srtScr} /= vec2(${ctx.inputs.srt_scale});`))
      stmts.push(raw(`float rg_asp_scr_${id} = u_resolution.x / u_resolution.y;`))
      stmts.push(raw(`float rg_rad_scr_${id} = ${ctx.inputs.srt_rotate} * 0.01745329;`))
      stmts.push(raw(`${srtScr}.x *= rg_asp_scr_${id};`))
      stmts.push(raw(`${srtScr} = vec2(${srtScr}.x * cos(rg_rad_scr_${id}) - ${srtScr}.y * sin(rg_rad_scr_${id}), ${srtScr}.x * sin(rg_rad_scr_${id}) + ${srtScr}.y * cos(rg_rad_scr_${id}));`))
      stmts.push(raw(`${srtScr}.x /= rg_asp_scr_${id};`))
      stmts.push(raw(`${srtScr} -= vec2(${ctx.inputs.srt_translateX}, -(${ctx.inputs.srt_translateY})) * u_dpr / u_resolution;`))

      const mainScr = isVert ? `${srtScr}.x` : `${srtScr}.y`
      const perpScr = isVert ? `${srtScr}.y` : `${srtScr}.x`
      const warpedMainScr = `rg_wm_scr_${id}`

      // Convert amplitude (main axis) and wavelength (perp axis) from pixels to screen UV
      const resMainIR = isVert ? 'u_resolution.x' : 'u_resolution.y'
      const resPerpIR = isVert ? 'u_resolution.y' : 'u_resolution.x'
      const ampScrIR = `rg_amp_scr_${id}`
      const wlScrIR = `rg_wl_scr_${id}`
      stmts.push(raw(`float ${ampScrIR} = ${ctx.inputs.amplitude} * u_dpr / ${resMainIR};`))
      stmts.push(raw(`float ${wlScrIR} = ${ctx.inputs.wavelength} * u_dpr / ${resPerpIR};`))
      const wlPxIR = `(${ctx.inputs.wavelength} * u_dpr)`

      if (ribType === 'straight') {
        stmts.push(raw(`float ${warpedMainScr} = ${mainScr};`))
      } else {
        const waveValScr = `rg_wv_scr_${id}`
        if (ribType === 'wave') {
          const waveShape = (ctx.params.waveShape as string) || 'sine'
          switch (waveShape) {
            case 'sine':
              stmts.push(raw(`float ${waveValScr} = sin(${perpScr} / ${wlScrIR} * 6.28318) * ${ampScrIR};`)); break
            case 'triangle':
              stmts.push(raw(`float ${waveValScr} = (abs(fract(${perpScr} / ${wlScrIR}) - 0.5) * 4.0 - 1.0) * ${ampScrIR};`)); break
            case 'square':
              stmts.push(raw(`float ${waveValScr} = (step(0.5, fract(${perpScr} / ${wlScrIR})) * 2.0 - 1.0) * ${ampScrIR};`)); break
            case 'sawtooth':
              stmts.push(raw(`float ${waveValScr} = (fract(${perpScr} / ${wlScrIR}) * 2.0 - 1.0) * ${ampScrIR};`)); break
            case 'chevron':
              stmts.push(raw(`float ${waveValScr} = abs(${perpScr} * ${resPerpIR} / ${wlPxIR}) * ${ampScrIR} * sin(${perpScr} / ${wlScrIR} * 6.28318);`)); break
            case 'u_shape':
              stmts.push(raw(`float ${waveValScr} = (pow(abs(fract(${perpScr} / ${wlScrIR}) * 2.0 - 1.0), 2.0) * 2.0 - 1.0) * ${ampScrIR};`)); break
          }
        } else if (ribType === 'circular') {
          stmts.push(raw(`float ${waveValScr} = sin(length((v_uv - vec2(u_anchor.x, 1.0 - u_anchor.y)) * u_resolution) / ${wlPxIR} * 6.28318) * ${ampScrIR};`))
        } else if (ribType === 'noise') {
          const noiseType = (ctx.params.noiseType as string) || 'simplex'
          const noiseFn = resolveNoiseFn(noiseType)
          stmts.push(raw(`float ${waveValScr} = (${noiseFn}(vec3(${perpScr} * ${resPerpIR} / ${wlPxIR}, ${mainScr} * ${resMainIR} / ${wlPxIR}, 0.0)) * 2.0 - 1.0) * ${ampScrIR};`))
        }
        stmts.push(raw(`float ${warpedMainScr} = ${mainScr} + ${waveValScr};`))
      }

      // Lens in screen UV space
      const lensedScreen = `rg_lensed_scr_${id}`
      stmts.push(
        declare(lensedScreen, 'float',
          call('reedLens', [
            variable(warpedMainScr),
            variable(ribUVScreen),
            variable(ctx.inputs.ior),
            variable(ctx.inputs.curvature),
          ], 'float'),
        ),
      )
      const disp = `rg_disp_${id}`
      stmts.push(
        declare(disp, 'float',
          binary('-', variable(lensedScreen), variable(warpedMainScr), 'float'),
        ),
      )

      // Use gl_FragCoord/viewport instead of v_uv — matches WebGPU texture convention
      const sampleUV = `rg_sampleUV_${id}`
      const sampleBase = `rg_sampleBase_${id}`
      stmts.push(
        declare(sampleBase, 'vec2',
          binary('/', variable('gl_FragCoord.xy'), variable('u_viewport'), 'vec2'),
        ),
      )
      if (isVert) {
        stmts.push(
          declare(sampleUV, 'vec2',
            binary('+', variable(sampleBase), construct('vec2', [variable(disp), literal('float', 0.0)]), 'vec2'),
          ),
        )
      } else {
        stmts.push(
          declare(sampleUV, 'vec2',
            binary('+', variable(sampleBase), construct('vec2', [literal('float', 0.0), variable(disp)]), 'vec2'),
          ),
        )
      }

      // Frosted glass: hash-based jitter blur (8 directional samples)
      const frostVar = `rg_frost_${id}`
      stmts.push(declare(frostVar, 'float', variable(ctx.inputs.frost)))

      // Use raw() for the conditional frost blur — complex control flow with loop
      const frostStmts: IRStmt[] = [
        raw(`vec3 ${ctx.outputs.color};
  if (${frostVar} > 0.001) {
    vec3 rg_acc_${id} = vec3(0.0);
    float rg_frad_${id} = ${frostVar} * 0.02;
    for (int rg_i_${id} = 0; rg_i_${id} < 8; rg_i_${id}++) {
      vec2 rg_jit_${id} = reedHash(${sampleUV} * 0.1 + float(rg_i_${id}) * 7.31) * rg_frad_${id};
      rg_acc_${id} += texture(${samplerName}, ${sampleUV} + rg_jit_${id}).rgb;
    }
    ${ctx.outputs.color} = rg_acc_${id} / 8.0;
  } else {
    ${ctx.outputs.color} = texture(${samplerName}, ${sampleUV}).rgb;
  }`),
      ]
      stmts.push(...frostStmts)
    } else {
      // Non-texture fallback: passthrough source input
      stmts.push(
        declare(ctx.outputs.color, 'vec3', variable(ctx.inputs.source)),
      )
    }

    return {
      statements: stmts,
      uniforms: [],
      standardUniforms: new Set(['u_ref_size', 'u_resolution', 'u_dpr', 'u_anchor', 'u_viewport']),
      functions,
    }
  },
}
