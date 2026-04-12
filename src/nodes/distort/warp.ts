/**
 * Warp — Distorts coordinates using a selectable noise function.
 */

import type { NodeDefinition, SpatialConfig } from '../types'
import { getSpatialParams } from '../types'
import { NOISE_TYPE_OPTIONS, resolveNoiseFn, registerNoiseType, getIRNoiseFunctions } from '../noise/noise-functions'
import type { IRContext, IRNodeOutput, IRStmt } from '../../compiler/ir/types'
import { variable, call, declare, construct, binary, literal, textureSample, swizzle, raw } from '../../compiler/ir/types'

const EDGE_OPTIONS = [
  { value: 'clamp', label: 'Clamp' },
  { value: 'repeat', label: 'Repeat' },
  { value: 'mirror', label: 'Mirror' },
]

export const warpNode: NodeDefinition = {
  type: 'warp',
  label: 'Warp',
  category: 'Distort',
  description: 'Distorts coordinates using noise for organic warping effects',
  spatial: { transforms: ['scale', 'translate'] } satisfies SpatialConfig,

  inputs: [
    { id: 'source', label: 'Source', type: 'vec3', textureInput: true, default: [0, 0, 0] },
    { id: 'coords', label: 'Coords', type: 'vec2', default: 'auto_uv' },
    { id: 'phase', label: 'Phase', type: 'float', default: 0.0 },
  ],

  outputs: [
    { id: 'color', label: 'Color', type: 'vec3' },
    { id: 'warped', label: 'Warped', type: 'vec2' },
    { id: 'warpedPhase', label: 'Warped Phase', type: 'float' },
  ],

  params: [
    ...getSpatialParams({ transforms: ['scale', 'translate'] }),
    {
      id: 'noiseType', label: 'Noise Type', type: 'enum', default: 'value',
      options: NOISE_TYPE_OPTIONS, updateMode: 'recompile',
    },
    { id: 'strength', label: 'Strength', type: 'float', default: 0.3, min: 0.0, max: 10.0, step: 0.01, connectable: true, updateMode: 'uniform' },
    { id: 'seed', label: 'Seed', type: 'float', default: 12345, min: 0, max: 99999, step: 1, connectable: true, updateMode: 'uniform' },
    {
      id: 'warpDepth', label: 'Depth', type: 'enum', default: '2',
      options: [
        { value: '2', label: 'Standard (2 samples)' },
        { value: '3', label: 'Deep (3 samples)' },
      ],
      updateMode: 'recompile',
    },
    {
      id: 'edge', label: 'Edge', type: 'enum', default: 'clamp',
      options: EDGE_OPTIONS, updateMode: 'recompile',
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, params } = ctx
    const noiseType = (params.noiseType as string) || 'value'
    const noiseFn = resolveNoiseFn(noiseType)
    const warpDepth = (params.warpDepth as string) || '2'
    const edge = (params.edge as string) || 'clamp'

    // Register GLSL functions for the selected noise type
    registerNoiseType(ctx, noiseType)

    const prefix = outputs.warped
    const id = ctx.nodeId.replace(/-/g, '_')
    const seedOff = `dw_soff_${id}`
    const sc = `dw_sc_${id}`
    const noiseCoords = `dw_nc_${id}`
    const lines: string[] = []

    // In texture mode, coords is v_uv (screen space) for correct FBO sampling.
    // Compute auto_uv internally for aspect-correct noise evaluation,
    // then apply SRT scale/translate so the noise pattern responds to sliders.
    if (ctx.textureSamplers?.source) {
      ctx.uniforms.add('u_resolution')
      ctx.uniforms.add('u_dpr')
      ctx.uniforms.add('u_ref_size')
      ctx.uniforms.add('u_anchor')
      lines.push(`vec2 ${noiseCoords} = (vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y) - u_resolution * u_anchor) / (u_dpr * u_ref_size) + u_anchor;`)
      lines.push(`${noiseCoords} = (${noiseCoords} - 0.5) / vec2(${inputs.srt_scale}) - vec2(${inputs.srt_translateX}, -(${inputs.srt_translateY})) / (u_dpr * u_ref_size) + 0.5;`)
    } else {
      // Single-pass: coords is already auto_uv
      lines.push(`vec2 ${noiseCoords} = ${inputs.coords};`)
    }

    lines.push(
      `vec2 ${seedOff} = fract(vec2(${inputs.seed}) * vec2(12.9898, 78.233)) * 1000.0;`,
      `vec2 ${sc} = ${noiseCoords} + ${seedOff};`,
      `float ${prefix}_x = ${noiseFn}(vec3(${sc}, ${inputs.phase})) * 2.0 - 1.0;`,
      `float ${prefix}_y = ${noiseFn}(vec3(${sc} + 100.0, ${inputs.phase})) * 2.0 - 1.0;`,
    )

    if (warpDepth === '3') {
      lines.push(
        `float ${prefix}_z = ${noiseFn}(vec3(${sc} + 73.156, ${inputs.phase} + 9.151)) * 2.0 - 1.0;`,
      )
    }

    lines.push(
      `vec2 ${outputs.warped} = ${inputs.coords} + vec2(${prefix}_x, ${prefix}_y) * ${inputs.strength};`,
      warpDepth === '3'
        ? `float ${outputs.warpedPhase} = ${inputs.phase} + ${prefix}_z * ${inputs.strength};`
        : `float ${outputs.warpedPhase} = ${inputs.phase};`,
    )

    // Color output — texture mode (source wired) vs UV gradient fallback
    const samplerName = ctx.textureSamplers?.source
    if (samplerName) {
      // Apply edge wrapping before texture sampling
      const edgeUV = `dw_edge_${id}`
      if (edge === 'repeat') {
        lines.push(`vec2 ${edgeUV} = fract(${outputs.warped});`)
      } else if (edge === 'mirror') {
        lines.push(`vec2 ${edgeUV} = vec2(`)
        lines.push(`  mod(${outputs.warped}.x, 2.0) < 1.0 ? fract(${outputs.warped}.x) : 1.0 - fract(${outputs.warped}.x),`)
        lines.push(`  mod(${outputs.warped}.y, 2.0) < 1.0 ? fract(${outputs.warped}.y) : 1.0 - fract(${outputs.warped}.y)`)
        lines.push(`);`)
      } else {
        lines.push(`vec2 ${edgeUV} = clamp(${outputs.warped}, 0.0, 1.0);`)
      }
      lines.push(`vec3 ${outputs.color} = texture(${samplerName}, ${edgeUV}).rgb;`)
    } else {
      // No source — show warped UV as gradient to visualize distortion
      lines.push(`vec3 ${outputs.color} = vec3(${outputs.warped}, 0.5);`)
    }

    return lines.join('\n  ')
  },

  ir: (ctx: IRContext): IRNodeOutput => {
    const noiseType = (ctx.params.noiseType as string) || 'value'
    const noiseFn = resolveNoiseFn(noiseType)
    const warpDepth = (ctx.params.warpDepth as string) || '2'
    const edge = (ctx.params.edge as string) || 'clamp'
    const id = ctx.nodeId.replace(/-/g, '_')
    const prefix = ctx.outputs.warped

    const samplerName = ctx.textureSamplers?.source
    const isTextureMode = !!samplerName

    const seedOff = `dw_soff_${id}`
    const sc = `dw_sc_${id}`
    const noiseCoords = `dw_nc_${id}`
    const standardUniforms = new Set<string>()

    const stmts: IRStmt[] = []

    // Noise coordinate computation
    if (isTextureMode) {
      // Texture mode: compute auto_uv from gl_FragCoord, then apply SRT
      standardUniforms.add('u_resolution')
      standardUniforms.add('u_dpr')
      standardUniforms.add('u_ref_size')
      standardUniforms.add('u_anchor')
      stmts.push(
        raw(`vec2 ${noiseCoords} = (vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y) - u_resolution * u_anchor) / (u_dpr * u_ref_size) + u_anchor;`),
        raw(`${noiseCoords} = (${noiseCoords} - 0.5) / vec2(${ctx.inputs.srt_scale}) - vec2(${ctx.inputs.srt_translateX}, -(${ctx.inputs.srt_translateY})) / (u_dpr * u_ref_size) + 0.5;`),
      )
    } else {
      // Single-pass: coords is already auto_uv
      stmts.push(declare(noiseCoords, 'vec2', variable(ctx.inputs.coords)))
    }

    // Seed offset
    stmts.push(
      declare(seedOff, 'vec2',
        binary('*',
          call('fract', [
            binary('*',
              construct('vec2', [variable(ctx.inputs.seed)]),
              construct('vec2', [literal('float', 12.9898), literal('float', 78.233)]),
              'vec2',
            ),
          ], 'vec2'),
          literal('float', 1000.0),
          'vec2',
        ),
      ),
      // Scaled coords
      declare(sc, 'vec2',
        binary('+', variable(noiseCoords), variable(seedOff), 'vec2'),
      ),
      // Noise sample X: noise(sc, phase) * 2.0 - 1.0
      declare(`${prefix}_x`, 'float',
        binary('-',
          binary('*',
            call(noiseFn, [
              construct('vec3', [variable(sc), variable(ctx.inputs.phase)]),
            ], 'float'),
            literal('float', 2.0),
            'float',
          ),
          literal('float', 1.0),
          'float',
        ),
      ),
      // Noise sample Y: noise(sc + 100.0, phase) * 2.0 - 1.0
      declare(`${prefix}_y`, 'float',
        binary('-',
          binary('*',
            call(noiseFn, [
              construct('vec3', [
                binary('+', variable(sc), literal('float', 100.0), 'vec2'),
                variable(ctx.inputs.phase),
              ]),
            ], 'float'),
            literal('float', 2.0),
            'float',
          ),
          literal('float', 1.0),
          'float',
        ),
      ),
    )

    // Optional deep warp (3rd noise sample for phase warping)
    if (warpDepth === '3') {
      stmts.push(
        declare(`${prefix}_z`, 'float',
          binary('-',
            binary('*',
              call(noiseFn, [
                construct('vec3', [
                  binary('+', variable(sc), literal('float', 73.156), 'vec2'),
                  binary('+', variable(ctx.inputs.phase), literal('float', 9.151), 'float'),
                ]),
              ], 'float'),
              literal('float', 2.0),
              'float',
            ),
            literal('float', 1.0),
            'float',
          ),
        ),
      )
    }

    // Warped coords output
    stmts.push(
      declare(ctx.outputs.warped, 'vec2',
        binary('+',
          variable(ctx.inputs.coords),
          binary('*',
            construct('vec2', [variable(`${prefix}_x`), variable(`${prefix}_y`)]),
            variable(ctx.inputs.strength),
            'vec2',
          ),
          'vec2',
        ),
      ),
    )

    // Warped phase output
    if (warpDepth === '3') {
      stmts.push(
        declare(ctx.outputs.warpedPhase, 'float',
          binary('+',
            variable(ctx.inputs.phase),
            binary('*', variable(`${prefix}_z`), variable(ctx.inputs.strength), 'float'),
            'float',
          ),
        ),
      )
    } else {
      stmts.push(
        declare(ctx.outputs.warpedPhase, 'float', variable(ctx.inputs.phase)),
      )
    }

    // Color output
    if (samplerName) {
      // Texture mode: apply edge wrapping then sample FBO texture
      const edgeUV = `dw_edge_${id}`
      if (edge === 'repeat') {
        stmts.push(declare(edgeUV, 'vec2', call('fract', [variable(ctx.outputs.warped)], 'vec2')))
      } else if (edge === 'mirror') {
        stmts.push(raw(`vec2 ${edgeUV} = vec2(
    mod(${ctx.outputs.warped}.x, 2.0) < 1.0 ? fract(${ctx.outputs.warped}.x) : 1.0 - fract(${ctx.outputs.warped}.x),
    mod(${ctx.outputs.warped}.y, 2.0) < 1.0 ? fract(${ctx.outputs.warped}.y) : 1.0 - fract(${ctx.outputs.warped}.y)
  );`))
      } else {
        // clamp — WGSL requires matching types: vec2f args for vec2f result
        stmts.push(declare(edgeUV, 'vec2',
          call('clamp', [variable(ctx.outputs.warped), construct('vec2', [literal('float', 0.0)]), construct('vec2', [literal('float', 1.0)])], 'vec2'),
        ))
      }
      stmts.push(
        declare(ctx.outputs.color, 'vec3',
          swizzle(textureSample(samplerName, variable(edgeUV)), 'rgb', 'vec3'),
        ),
      )
    } else {
      // No source texture — show warped UV as gradient to visualize distortion
      stmts.push(
        declare(ctx.outputs.color, 'vec3',
          construct('vec3', [
            variable(ctx.outputs.warped),
            literal('float', 0.5),
          ]),
        ),
      )
    }

    return {
      statements: stmts,
      uniforms: [],
      standardUniforms,
      functions: getIRNoiseFunctions(noiseType),
    }
  },
}
