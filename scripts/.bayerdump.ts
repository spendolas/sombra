import { initializeNodeLibrary } from '../src/nodes'
import { compileGraphIR } from '../src/compiler/ir-compiler'
import type { Node, Edge } from '@xyflow/react'
initializeNodeLibrary()
const n = (id: string, t: string, p: Record<string, unknown> = {}) =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: t, params: p } }) as unknown as Node
const e = (id: string, s: string, sh: string, tg: string, th: string) =>
  ({ id, source: s, sourceHandle: sh, target: tg, targetHandle: th }) as unknown as Edge
// dither node with bayer — find the param that triggers bayer8x8
const nodes = [n('src','checkerboard'), n('fx','dither',{ ditherType: 'ordered' }), n('out','fragment_output')]
const edges = [e('e1','src','color','fx','source'), e('e2','fx','color','out','color')]
const r = compileGraphIR(nodes, edges)
if (!r) { console.log('// null plan'); process.exit(0) }
const wgsl = r.passes.map(p=>p.shaderCode).join('\n')
const m = wgsl.match(/fn bayer8x8\([^]*?\n}/)
console.log(m ? m[0] : '// bayer8x8 NOT in output — wrong ditherType')
