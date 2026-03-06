/**
 * FBM (Fractal Brownian Motion) - Multi-octave fractal accumulator.
 */

import type { NodeDefinition } from '../types'
import { addFunction } from '../types'
import { NOISE_TYPE_OPTIONS, resolveNoiseFn, registerNoiseType } from './noise-functions'

export const fbmNode: NodeDefinition = {
  type: 'fbm',
  label: 'FBM',
  category: 'Noise',
  description: 'Multi-octave fractal noise with selectable noise type and fractal mode',

  inputs: [
    { id: 'coords', label: 'Coords', type: 'vec2', default: 'auto_uv' },
    { id: 'phase', label: 'Phase', type: 'float', default: 0.0 },
  ],

  outputs: [
    { id: 'value', label: 'Value', type: 'float' },
  ],

  params: [
    { id: 'scale', label: 'Scale', type: 'float', default: 5.0, min: 0.1, max: 20.0, step: 0.1, connectable: true, updateMode: 'uniform' },
    {
      id: 'noiseType', label: 'Noise Type', type: 'enum', default: 'simplex',
      options: NOISE_TYPE_OPTIONS, updateMode: 'recompile',
    },
    {
      id: 'fractalMode', label: 'Fractal Mode', type: 'enum', default: 'standard',
      options: [
        { value: 'standard', label: 'Standard' },
        { value: 'turbulence', label: 'Turbulence' },
        { value: 'ridged', label: 'Ridged' },
      ],
      updateMode: 'recompile',
    },
    // Phase 2 candidate: currently baked as loop bound literal. To promote to uniform,
    // rewrite FBM loop with compile-time MAX_OCTAVES and uniform-driven early break.
    { id: 'octaves', label: 'Octaves', type: 'float', default: 4, min: 1, max: 8, step: 1, connectable: true, updateMode: 'recompile' },
    { id: 'lacunarity', label: 'Lacunarity', type: 'float', default: 2.0, min: 1.0, max: 4.0, step: 0.1, connectable: true, updateMode: 'uniform' },
    { id: 'gain', label: 'Gain', type: 'float', default: 0.5, min: 0.1, max: 0.9, step: 0.05, connectable: true, updateMode: 'uniform' },
    { id: 'seed', label: 'Seed', type: 'float', default: 12345, min: 0, max: 99999, step: 1, connectable: true, updateMode: 'uniform' },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, params } = ctx
    const fractalMode = (params.fractalMode as string) || 'standard'
    const noiseType = (params.noiseType as string) || 'simplex'
    const noiseFn = resolveNoiseFn(noiseType)

    // Register GLSL functions for the selected noise type
    registerNoiseType(ctx, noiseType)

    // Unique FBM function per node instance
    const sanitizedId = ctx.nodeId.replace(/-/g, '_')
    const fbmKey = `fbm_${sanitizedId}`

    let loopBody: string
    if (fractalMode === 'turbulence') {
      loopBody = `      total += abs(${noiseFn}(p) * 2.0 - 1.0) * amp;`
    } else if (fractalMode === 'ridged') {
      loopBody = `      float n = 1.0 - abs(${noiseFn}(p) * 2.0 - 1.0);\n      total += n * n * amp;`
    } else {
      loopBody = `      total += ${noiseFn}(p) * amp;`
    }

    addFunction(ctx, fbmKey, `float ${fbmKey}(vec3 p, float oct, float lac, float g) {
  float total = 0.0;
  float amp = 0.5;
  float maxAmp = 0.0;
  for (int i = 0; i < 8; i++) {
      if (float(i) >= oct) break;
${loopBody}
      maxAmp += amp;
      p *= lac;
      amp *= g;
  }
  return total / maxAmp;
}`)

    const seedOff = `fbm_soff_${sanitizedId}`
    const sc = `fbm_sc_${sanitizedId}`
    return `vec2 ${seedOff} = fract(vec2(${inputs.seed}) * vec2(12.9898, 78.233)) * 1000.0;\n  vec2 ${sc} = ${inputs.coords} + ${seedOff};\n  float ${outputs.value} = ${fbmKey}(vec3(${sc} * ${inputs.scale}, ${inputs.phase}), ${inputs.octaves}, ${inputs.lacunarity}, ${inputs.gain});`
  },
}
