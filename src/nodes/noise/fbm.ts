/**
 * FBM (Fractal Brownian Motion) - Multi-octave fractal accumulator.
 */

import type { NodeDefinition, SpatialConfig } from '../types'
import { addFunction, getSpatialParams } from '../types'
import { NOISE_TYPE_OPTIONS, resolveNoiseFn, registerNoiseType, getIRNoiseFunctions } from './noise-functions'
import { variable, call, declare, assign, binary, construct, forLoop, literal, raw } from '../../compiler/ir/types'
import type { IRFunction, IRStmt } from '../../compiler/ir/types'

export const fbmNode: NodeDefinition = {
  type: 'fbm',
  label: 'FBM',
  category: 'Noise',
  description: 'Multi-octave fractal noise with selectable noise type and fractal mode',
  spatial: { transforms: ['scale', 'translate'] } satisfies SpatialConfig,

  inputs: [
    { id: 'coords', label: 'Coords', type: 'vec2', default: 'auto_uv' },
    { id: 'phase', label: 'Phase', type: 'float', default: 0.0 },
  ],

  outputs: [
    { id: 'value', label: 'Value', type: 'float' },
  ],

  params: [
    ...getSpatialParams({ transforms: ['scale', 'translate'] }),
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
    // Loop has a compile-time bound (8) + runtime early break `if (float(i) >= oct)`,
    // so octaves rides as a uniform (`oct` arg) — changing it uploads, no recompile.
    { id: 'octaves', label: 'Octaves', type: 'float', default: 4, min: 1, max: 8, step: 1, connectable: true, updateMode: 'uniform', warnAbove: 6 },
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

    // Content-addressed key: instances with same fractalMode+noiseType share one function
    const sanitizedId = ctx.nodeId.replace(/-/g, '_')
    const fbmKey = `fbm_${fractalMode}_${noiseType}`

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
    return `vec2 ${seedOff} = fract(vec2(${inputs.seed}) * vec2(12.9898, 78.233)) * 1000.0;\n  vec2 ${sc} = ${inputs.coords} + ${seedOff};\n  float ${outputs.value} = ${fbmKey}(vec3(${sc}, ${inputs.phase}), ${inputs.octaves}, ${inputs.lacunarity}, ${inputs.gain});`
  },

  ir: (ctx) => {
    const fractalMode = (ctx.params.fractalMode as string) || 'standard'
    const noiseType = (ctx.params.noiseType as string) || 'simplex'
    const noiseFn = resolveNoiseFn(noiseType)
    const sanitizedId = ctx.nodeId.replace(/-/g, '_')
    const fbmKey = `fbm_${fractalMode}_${noiseType}`
    const seedOff = `fbm_soff_${sanitizedId}`
    const sc = `fbm_sc_${sanitizedId}`

    // Collect noise dependency functions + the FBM function itself
    const functions: IRFunction[] = getIRNoiseFunctions(noiseType)

    // `noiseFn(p) * 2.0 - 1.0`, the signed sample the two non-standard modes fold.
    const f = (n: number) => literal('float', n)
    const signedSample = binary('-', binary('*', call(noiseFn, [variable('p')], 'float'), f(2.0), 'float'), f(1.0), 'float')

    // The per-octave accumulation, one statement list per fractal mode.
    let accumulate: IRStmt[]
    if (fractalMode === 'turbulence') {
      accumulate = [assign('total', binary('+', variable('total'),
        binary('*', call('abs', [signedSample], 'float'), variable('amp'), 'float'), 'float'))]
    } else if (fractalMode === 'ridged') {
      accumulate = [
        declare('n', 'float', binary('-', f(1.0), call('abs', [signedSample], 'float'), 'float')),
        assign('total', binary('+', variable('total'),
          binary('*', binary('*', variable('n'), variable('n'), 'float'), variable('amp'), 'float'), 'float')),
      ]
    } else {
      accumulate = [assign('total', binary('+', variable('total'),
        binary('*', call(noiseFn, [variable('p')], 'float'), variable('amp'), 'float'), 'float'))]
    }

    // The octave loop is now structured rather than hand-written text. This is the first
    // caller of `forLoop` — it shipped with the comment "used by FBM octave loops" and had
    // never been constructed, because `int` literals lowered through formatFloat as `0.0`
    // and the loop header was invalid on both backends until that was fixed.
    //
    // `return total / maxAmp;` stays raw: the IR has no return statement, so every
    // IRFunction in the codebase ends this way. That is the next construct worth adding,
    // deliberately not folded in here.
    const fbmFn: IRFunction = {
      key: fbmKey,
      name: fbmKey,
      params: [
        { name: 'p', type: 'vec3' },
        { name: 'oct', type: 'float' },
        { name: 'lac', type: 'float' },
        { name: 'g', type: 'float' },
      ],
      returnType: 'float',
      body: [
        declare('total', 'float', f(0.0)),
        declare('amp', 'float', f(0.5)),
        declare('maxAmp', 'float', f(0.0)),
        forLoop('i', literal('int', 0), literal('int', 8), [
          ...accumulate,
          assign('maxAmp', binary('+', variable('maxAmp'), variable('amp'), 'float')),
          assign('p', binary('*', variable('p'), variable('lac'), 'vec3')),
          assign('amp', binary('*', variable('amp'), variable('g'), 'float')),
        ], variable('oct')),
        raw('return total / maxAmp;'),
      ],
    }
    functions.push(fbmFn)

    return {
      statements: [
        // Seed offset preamble
        raw(
          `vec2 ${seedOff} = fract(vec2(${ctx.inputs.seed}) * vec2(12.9898, 78.233)) * 1000.0;\n` +
          `vec2 ${sc} = ${ctx.inputs.coords} + ${seedOff};`,
        ),
        // Call FBM function
        declare(ctx.outputs.value, 'float',
          call(fbmKey, [
            construct('vec3', [variable(sc), variable(ctx.inputs.phase)]),
            variable(ctx.inputs.octaves),
            variable(ctx.inputs.lacunarity),
            variable(ctx.inputs.gain),
          ], 'float'),
        ),
      ],
      uniforms: [],
      standardUniforms: new Set<string>(),
      functions,
    }
  },
}
