import { initializeNodeLibrary } from '../src/nodes'
import { compileGraphIR } from '../src/compiler/ir-compiler'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../src/nodes/types'
import { writeFileSync } from 'fs'

initializeNodeLibrary()

const OUT = '/private/tmp/claude-501/-Volumes-Origami-Users-spendolas-Library-CloudStorage-Dropbox-Sombra/9431581c-340a-4a08-b8fe-e51c5ec3ee4c/scratchpad'

function n(id: string, type: string, params: Record<string, unknown> = {}): Node<NodeData> {
  return { id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params } }
}
function e(source: string, target: string, sourceHandle: string, targetHandle: string): Edge<EdgeData> {
  return {
    id: `${source}-${sourceHandle}-${target}-${targetHandle}`,
    source, target, sourceHandle, targetHandle, type: 'typed',
    data: { sourcePort: sourceHandle, targetPort: targetHandle, sourcePortType: 'float' },
  }
}

function build(wireFrost: boolean) {
  const nodes = [
    n('src', 'noise', { noiseType: 'simplex' }),
    n('ramp', 'color_ramp'),
    n('rg', 'reeded_glass', { frost: 0.5 }),
    n('out', 'fragment_output'),
  ]
  const edges = [
    e('src', 'ramp', 'value', 'value'),
    e('ramp', 'rg', 'color', 'source'),
    e('rg', 'out', 'color', 'color'),
  ]
  if (wireFrost) {
    nodes.push(n('fn', 'noise', { noiseType: 'value' }))
    edges.push(e('fn', 'rg', 'value', 'frost'))
  }
  return { nodes, edges }
}

for (const wired of [false, true]) {
  const { nodes, edges } = build(wired)
  const plan = compileGraphIR(nodes, edges)
  if (!plan) { console.log(`wired=${wired}: IR compile returned null`); continue }
  console.log(`\n===== frost wired=${wired}: ${plan.passes.length} passes =====`)
  plan.passes.forEach((p, i) => {
    const tag = wired ? 'wired' : 'unwired'
    const f = `${OUT}/pass-${tag}-${i}.wgsl`
    writeFileSync(f, p.shaderCode)
    console.log(`  pass ${i}: ${f} lines=${p.shaderCode.split('\n').length} textureSample=${/textureSample/.test(p.shaderCode)}`)
  })
}
