/**
 * Hue Shift — rotate a colour's hue around the grey axis.
 *
 * Uses a Rodrigues rotation about (1,1,1)/√3 instead of an RGB→HSV→RGB round-trip:
 * cheaper (no branchy rgb2hsv), smooth with no hue-seam discontinuity, and
 * luma-stable (rotating about the grey axis preserves perceived brightness).
 * Per-pixel colour op → single-pass. Alpha passes through untouched.
 */

import type { NodeDefinition } from '../types'
import { addFunction } from '../types'
import { variable, call, declare, construct, swizzle, raw } from '../../compiler/ir/types'
import type { IRFunction } from '../../compiler/ir/types'

const HUE_SHIFT_GLSL = `vec3 hueShift(vec3 col, float a) {
  const vec3 k = vec3(0.57735026919);
  float c = cos(a);
  float s = sin(a);
  return col * c + cross(k, col) * s + k * dot(k, col) * (1.0 - c);
}`

const HUE_SHIFT_WGSL = `let k = vec3f(0.57735026919);
  let c = cos(a);
  let s = sin(a);
  return col * c + cross(k, col) * s + k * dot(k, col) * (1.0 - c);`

export const hueShiftNode: NodeDefinition = {
  type: 'hue_shift',
  label: 'Hue Shift',
  category: 'Color',
  description: 'Rotate hue around the grey axis (luma-stable, no HSV round-trip)',

  inputs: [
    { id: 'color', label: 'Color', type: 'color', default: [0.5, 0.5, 0.5] },
  ],

  outputs: [
    { id: 'result', label: 'Result', type: 'color' },
  ],

  params: [
    {
      id: 'shift',
      label: 'Shift',
      type: 'float',
      default: 0,
      min: -180,
      max: 180,
      step: 1,
      connectable: true,
      updateMode: 'uniform',
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    addFunction(ctx, 'hueShift', HUE_SHIFT_GLSL)

    const id = ctx.nodeId.replace(/-/g, '_')
    const rgbVar = `hs_rgb_${id}`
    // radians() exists in GLSL + WGSL, so shift stays authored in degrees.
    return `vec3 ${rgbVar} = hueShift(${inputs.color}.rgb, radians(${inputs.shift}));
  vec4 ${outputs.result} = vec4(${rgbVar}, ${inputs.color}.a);`
  },

  ir: (ctx) => {
    const hueShiftFn: IRFunction = {
      key: 'hueShift',
      name: 'hueShift',
      params: [
        { name: 'col', type: 'vec3' },
        { name: 'a', type: 'float' },
      ],
      returnType: 'vec3',
      // GLSL uses `const vec3 k`; WGSL requires function-scope `let`.
      body: [raw(
        `const vec3 k = vec3(0.57735026919);\n  float c = cos(a);\n  float s = sin(a);\n  return col * c + cross(k, col) * s + k * dot(k, col) * (1.0 - c);`,
        HUE_SHIFT_WGSL,
      )],
    }

    const id = ctx.nodeId.replace(/-/g, '_')
    const rgbVar = `hs_rgb_${id}`
    const color = variable(ctx.inputs.color)

    return {
      statements: [
        declare(rgbVar, 'vec3',
          call('hueShift', [
            swizzle(color, 'rgb', 'vec3'),
            call('radians', [variable(ctx.inputs.shift)], 'float'),
          ], 'vec3'),
        ),
        declare(ctx.outputs.result, 'vec4',
          construct('vec4', [
            variable(rgbVar),
            swizzle(color, 'a', 'float'),
          ]),
        ),
      ],
      uniforms: [],
      standardUniforms: new Set<string>(),
      functions: [hueShiftFn],
    }
  },
}
