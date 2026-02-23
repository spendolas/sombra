/**
 * Random Number node - outputs a deterministic pseudo-random float.
 * Each instance gets a different value via node ID hashing.
 * Value is stable — only changes when the user clicks Randomise.
 */

import type { NodeDefinition } from '../types'
import { RandomDisplay } from '../../components/RandomDisplay'

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

  inputs: [],

  outputs: [
    { id: 'value', label: 'Value', type: 'float' },
  ],

  params: [
    { id: 'min', label: 'Min', type: 'float', default: 0, min: -99999, max: 99999, step: 1, connectable: true },
    { id: 'max', label: 'Max', type: 'float', default: 1, min: -99999, max: 99999, step: 1, connectable: true },
    { id: 'decimals', label: 'Decimals', type: 'float', default: 7, min: 0, max: 7, step: 1 },
    { id: 'seed', label: 'Seed', type: 'float', default: 0, hidden: true },
  ],

  component: RandomDisplay,

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    const seed = Number(ctx.params.seed) || 0
    const decimals = Number(ctx.params.decimals) ?? 7
    const nodeHash = hashNodeId(ctx.nodeId).toFixed(6)
    const seedStr = Number.isInteger(seed) ? `${seed}.0` : `${seed}`
    const decimalsStr = Number.isInteger(decimals) ? `${decimals}.0` : `${decimals}`
    return `float ${outputs.value}_step = pow(10.0, -${decimalsStr});
float ${outputs.value}_raw = ${inputs.min} + fract(${seedStr} + ${nodeHash}) * (${inputs.max} - ${inputs.min});
float ${outputs.value} = floor(${outputs.value}_raw / ${outputs.value}_step + 0.5) * ${outputs.value}_step;`
  },
}
