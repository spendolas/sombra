/**
 * Random Number node - outputs a deterministic pseudo-random float.
 * Each instance gets a different value via node ID hashing.
 * Value is stable — only changes when the user clicks Randomise.
 */

import type { NodeDefinition } from '../types'
import { variable, declare, binary, call, literal } from '../../compiler/ir/types'

/** Simple string hash → float 0-1 */
export function hashNodeId(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash) / 2147483647
}

export const randomNode: NodeDefinition = {
  type: 'random',
  label: 'Random',
  category: 'Input',
  description: 'Random float with Randomise button (stable between edits)',
  hidePreview: true,

  inputs: [],

  outputs: [
    { id: 'value', label: 'Value', type: 'float' },
  ],

  params: [
    { id: 'min', label: 'Min', type: 'float', default: 0, min: -99999, max: 99999, step: 1, connectable: true, updateMode: 'uniform' },
    { id: 'max', label: 'Max', type: 'float', default: 1, min: -99999, max: 99999, step: 1, connectable: true, updateMode: 'uniform' },
    { id: 'decimals', label: 'Decimals', type: 'float', default: 7, min: 0, max: 7, step: 1, updateMode: 'recompile' },
    { id: 'seed', label: 'Seed', type: 'float', default: 0, hidden: true, updateMode: 'uniform' },
  ],



  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    const decimals = Number(ctx.params.decimals) ?? 7
    const nodeHash = hashNodeId(ctx.nodeId).toFixed(6)
    const decimalsStr = Number.isInteger(decimals) ? `${decimals}.0` : `${decimals}`
    return `float ${outputs.value}_step = pow(10.0, -${decimalsStr});
float ${outputs.value}_raw = ${inputs.min} + fract(${inputs.seed} + ${nodeHash}) * (${inputs.max} - ${inputs.min});
float ${outputs.value} = floor(${outputs.value}_raw / ${outputs.value}_step + 0.5) * ${outputs.value}_step;`
  },

  ir: (ctx) => {
    const decimals = Number(ctx.params.decimals) ?? 7
    const nodeHash = hashNodeId(ctx.nodeId).toFixed(6)
    const decimalsStr = Number.isInteger(decimals) ? `${decimals}.0` : `${decimals}`
    const out = ctx.outputs.value
    const stepVar = `${out}_step`
    const rawVar = `${out}_raw`

    return {
      statements: [
        // float step = pow(10.0, -decimals);
        declare(stepVar, 'float',
          call('pow', [literal('float', 10.0), literal('float', -Number(decimalsStr))], 'float'),
        ),
        // float raw = min + fract(seed + nodeHash) * (max - min);
        declare(rawVar, 'float',
          binary('+',
            variable(ctx.inputs.min),
            binary('*',
              call('fract', [
                binary('+',
                  variable(ctx.inputs.seed),
                  literal('float', Number(nodeHash)),
                  'float',
                ),
              ], 'float'),
              binary('-',
                variable(ctx.inputs.max),
                variable(ctx.inputs.min),
                'float',
              ),
              'float',
            ),
            'float',
          ),
        ),
        // float value = floor(raw / step + 0.5) * step;
        declare(out, 'float',
          binary('*',
            call('floor', [
              binary('+',
                binary('/', variable(rawVar), variable(stepVar), 'float'),
                literal('float', 0.5),
                'float',
              ),
            ], 'float'),
            variable(stepVar),
            'float',
          ),
        ),
      ],
      uniforms: [],
      standardUniforms: new Set<string>(),
    }
  },
}
