/**
 * HSV to RGB node - Convert HSV color space to RGB
 * H = Hue (0-1), S = Saturation (0-1), V = Value/Brightness (0-1)
 */

import type { NodeDefinition } from '../types'
import { addFunction } from '../types'
import { variable, call, declare, raw } from '../../compiler/ir/types'
import type { IRFunction } from '../../compiler/ir/types'

export const hsvToRgbNode: NodeDefinition = {
  type: 'hsv_to_rgb',
  label: 'HSV to RGB',
  category: 'Color',
  description: 'Convert HSV color space to RGB',

  inputs: [
    {
      id: 'h',
      label: 'Hue',
      type: 'float',
      default: 0.0,
    },
    {
      id: 's',
      label: 'Saturation',
      type: 'float',
      default: 1.0,
    },
    {
      id: 'v',
      label: 'Value',
      type: 'float',
      default: 1.0,
    },
  ],

  outputs: [
    {
      id: 'rgb',
      label: 'RGB',
      type: 'vec3',
    },
  ],

  params: [],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx

    addFunction(ctx, 'hsv2rgb', `vec3 hsv2rgb(float h, float s, float v) {
  vec3 c = vec3(h, s, v);
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}`)

    return `vec3 ${outputs.rgb} = hsv2rgb(${inputs.h}, ${inputs.s}, ${inputs.v});`
  },

  ir: (ctx) => {
    const hsv2rgbFn: IRFunction = {
      key: 'hsv2rgb',
      name: 'hsv2rgb',
      params: [
        { name: 'h', type: 'float' },
        { name: 's', type: 'float' },
        { name: 'v', type: 'float' },
      ],
      returnType: 'vec3',
      body: [raw(
        `vec3 c = vec3(h, s, v);\n` +
        `vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);\n` +
        `vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);\n` +
        `return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);`,
        // WGSL: clamp(vec3, f32, f32) is invalid — promote to vec3f
        `var c: vec3f = vec3f(h, s, v);\n` +
        `var K: vec4f = vec4f(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);\n` +
        `var p: vec3f = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);\n` +
        `return c.z * mix(K.xxx, clamp(p - K.xxx, vec3f(0.0), vec3f(1.0)), c.y);`,
      )],
    }

    return {
      statements: [
        declare(ctx.outputs.rgb, 'vec3',
          call('hsv2rgb', [
            variable(ctx.inputs.h),
            variable(ctx.inputs.s),
            variable(ctx.inputs.v),
          ], 'vec3'),
        ),
      ],
      uniforms: [],
      standardUniforms: new Set<string>(),
      functions: [hsv2rgbFn],
    }
  },
}
