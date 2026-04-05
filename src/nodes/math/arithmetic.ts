/**
 * Arithmetic node - unified add/subtract/multiply/divide with dynamic 2-8 inputs
 */

import type { NodeDefinition, PortDefinition } from '../types'
import { variable, binary, declare, type IRExpr } from '../../compiler/ir/types'

const OPERATIONS = [
  { value: 'add', label: 'Add' },
  { value: 'subtract', label: 'Subtract' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'divide', label: 'Divide' },
]

const OP_SYMBOLS: Record<string, string> = {
  add: '+',
  subtract: '-',
  multiply: '*',
  divide: '/',
}

const OP_DEFAULTS: Record<string, number> = {
  add: 0.0,
  subtract: 0.0,
  multiply: 1.0,
  divide: 1.0,
}

function buildInputs(params: Record<string, unknown>): PortDefinition[] {
  const count = Math.max(2, Math.min(8, Number(params.inputCount) || 2))
  const op = (params.operation as string) || 'add'
  const defaultVal = OP_DEFAULTS[op] ?? 0.0
  return Array.from({ length: count }, (_, i) => ({
    id: `in_${i}`,
    label: String.fromCharCode(65 + i),
    type: 'float' as const,
    default: defaultVal,
  }))
}

export const arithmeticNode: NodeDefinition = {
  type: 'arithmetic',
  label: 'Arithmetic',
  category: 'Math',
  description: 'Add, subtract, multiply, or divide values (2-8 inputs)',
  conditionalPreview: true,

  inputs: [
    { id: 'in_0', label: 'A', type: 'float', default: 0.0 },
    { id: 'in_1', label: 'B', type: 'float', default: 0.0 },
  ],

  dynamicInputs: buildInputs,

  outputs: [
    { id: 'result', label: 'Result', type: 'float' },
  ],

  params: [
    {
      id: 'operation',
      label: 'Operation',
      type: 'enum',
      default: 'add',
      options: OPERATIONS,
      updateMode: 'recompile',
    },
    {
      id: 'inputCount',
      label: 'Input Count',
      type: 'float',
      default: 2,
      min: 2,
      max: 8,
      step: 1,
      hidden: true,
      updateMode: 'recompile',
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, params } = ctx
    const op = (params.operation as string) || 'add'
    const count = Math.max(2, Math.min(8, Number(params.inputCount) || 2))
    const symbol = OP_SYMBOLS[op] || '+'

    const parts: string[] = []
    for (let i = 0; i < count; i++) {
      parts.push(inputs[`in_${i}`] || formatDefault(op))
    }

    return `float ${outputs.result} = ${parts.join(` ${symbol} `)};`
  },

  ir: (ctx) => {
    const op = (ctx.params.operation as string) || 'add'
    const count = Math.max(2, Math.min(8, Number(ctx.params.inputCount) || 2))
    const IR_OP_SYMBOLS: Record<string, '+' | '-' | '*' | '/'> = {
      add: '+', subtract: '-', multiply: '*', divide: '/',
    }
    const symbol = IR_OP_SYMBOLS[op] || '+'

    // Build a left-associative chain: ((in_0 op in_1) op in_2) ...
    let expr: IRExpr = variable(ctx.inputs.in_0)
    for (let i = 1; i < count; i++) {
      expr = binary(symbol, expr, variable(ctx.inputs[`in_${i}`]), 'float')
    }

    return {
      statements: [declare(ctx.outputs.result, 'float', expr)],
      uniforms: [],
      standardUniforms: new Set(),
    }
  },
}

function formatDefault(op: string): string {
  const val = OP_DEFAULTS[op] ?? 0.0
  return Number.isInteger(val) ? `${val}.0` : `${val}`
}
