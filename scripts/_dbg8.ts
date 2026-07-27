import { initializeNodeLibrary } from '../src/nodes'
import { compileGraphIR } from '../src/compiler/ir-compiler'
import type { Node, Edge } from '@xyflow/react'
initializeNodeLibrary()
const n = (id: string, type: string, params: Record<string, unknown> = {}) =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params } }) as unknown as Node
const e = (id: string, s: string, sh: string, t: string, th: string) =>
  ({ id, source: s, sourceHandle: sh, target: t, targetHandle: th }) as unknown as Edge
const nodes = [n('cb','checkerboard'), n('bl','blur',{radius:12}), n('out','fragment_output'), n('num','float_constant',{value:40})]
const edges = [e('e1','cb','color','bl','source'), e('e2','bl','color','out','color'), e('e3','num','value','bl','radius')]
const ir = compileGraphIR(nodes as never, edges as never)
console.log('passes:', ir?.passes?.length, 'errors:', JSON.stringify(ir?.errors ?? []))
;(ir?.passes ?? []).forEach((p, i) => {
  const has = /\bundefined\b/.test(p.shaderCode)
  console.log('pass %d undefined=%s', i, has)
  if (has) {
    p.shaderCode.split('\n').forEach((l, k) => { if (l.includes('undefined')) console.log('   L%d: %s', k+1, l.trim().slice(0,130)) })
  }
})
