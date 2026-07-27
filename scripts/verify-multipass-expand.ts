/**
 * Verifies multi-pass node expansion.
 *
 * A node declaring `multiPass` needs more than one render pass, but the compiler
 * gives each node exactly one (partitionPasses assigns one depth per node).
 * Rather than rework the pass machinery, such a node is expanded into a chain of
 * virtual nodes before partitioning, so every existing stage — partitioning,
 * texture boundaries, the renderer — keeps working unchanged.
 *
 * Run: npx tsx scripts/verify-multipass-expand.ts
 */

import { test, run, assert } from './blur-bakeoff/lib/test-util'
import { initializeNodeLibrary } from '../src/nodes'
import { expandMultiPassNodes, SUB_PASS_PARAM, baseNodeId } from '../src/compiler/expand-passes'
import { compileNodePreview } from '../src/compiler/subgraph-compiler'
import { compileNodePreviewIR } from '../src/compiler/ir-subgraph-compiler'
import type { Node, Edge } from '@xyflow/react'

initializeNodeLibrary()

type N = Node<Record<string, unknown>>
type E = Edge<Record<string, unknown>>

function n(id: string, type: string, params: Record<string, unknown> = {}): N {
  return { id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params } } as unknown as N
}
function e(id: string, source: string, sourceHandle: string, target: string, targetHandle: string): E {
  return { id, source, sourceHandle, target, targetHandle } as unknown as E
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (nodes: N[], edges: E[]) => expandMultiPassNodes(nodes as any, edges as any)

test('a graph with no multi-pass nodes is returned unchanged', () => {
  const nodes = [n('a', 'image'), n('b', 'pixelate'), n('c', 'fragment_output')]
  const edges = [e('e1', 'a', 'color', 'b', 'source'), e('e2', 'b', 'color', 'c', 'color')]
  const out = call(nodes, edges)
  assert(out.nodes.length === 3, `expected 3 nodes, got ${out.nodes.length}`)
  assert(out.edges.length === 2, `expected 2 edges, got ${out.edges.length}`)
})

test('a 2-pass node becomes two chained nodes', () => {
  const nodes = [n('img', 'image'), n('bl', 'blur', { radius: 12 }), n('out', 'fragment_output')]
  const edges = [e('e1', 'img', 'color', 'bl', 'source'), e('e2', 'bl', 'color', 'out', 'color')]
  const out = call(nodes, edges)
  assert(out.nodes.length === 4, `expected 4 nodes after expansion, got ${out.nodes.length}`)
  const ids = out.nodes.map((x) => x.id)
  assert(ids.includes('bl'), 'original id is kept for the first sub-pass')
  assert(ids.some((i) => i.startsWith('bl') && i !== 'bl'), 'a second sub-pass node exists')
})

test('the incoming edge still targets the FIRST sub-pass', () => {
  const nodes = [n('img', 'image'), n('bl', 'blur', { radius: 12 }), n('out', 'fragment_output')]
  const edges = [e('e1', 'img', 'color', 'bl', 'source'), e('e2', 'bl', 'color', 'out', 'color')]
  const out = call(nodes, edges)
  const incoming = out.edges.find((x) => x.source === 'img')!
  assert(incoming.target === 'bl', `incoming should feed 'bl', got ${incoming.target}`)
})

test('the outgoing edge is rewired to the LAST sub-pass', () => {
  const nodes = [n('img', 'image'), n('bl', 'blur', { radius: 12 }), n('out', 'fragment_output')]
  const edges = [e('e1', 'img', 'color', 'bl', 'source'), e('e2', 'bl', 'color', 'out', 'color')]
  const out = call(nodes, edges)
  const outgoing = out.edges.find((x) => x.target === 'out')!
  assert(outgoing.source !== 'bl', 'downstream must read the last sub-pass, not the first')
  assert(baseNodeId(outgoing.source) === 'bl', `should still resolve to 'bl', got ${outgoing.source}`)
})

test('sub-passes are chained output -> textureInput', () => {
  const nodes = [n('img', 'image'), n('bl', 'blur', { radius: 12 }), n('out', 'fragment_output')]
  const edges = [e('e1', 'img', 'color', 'bl', 'source'), e('e2', 'bl', 'color', 'out', 'color')]
  const out = call(nodes, edges)
  const link = out.edges.find((x) => x.source === 'bl' && x.target !== 'out')
  assert(!!link, 'a link from the first sub-pass to the second must exist')
  assert(link!.sourceHandle === 'color' && link!.targetHandle === 'source', `chained on wrong ports: ${link!.sourceHandle}->${link!.targetHandle}`)
})

test('each sub-pass carries its index so the node can emit different code', () => {
  const nodes = [n('img', 'image'), n('bl', 'blur', { radius: 12 }), n('out', 'fragment_output')]
  const edges = [e('e1', 'img', 'color', 'bl', 'source'), e('e2', 'bl', 'color', 'out', 'color')]
  const out = call(nodes, edges)
  const subs = out.nodes
    .filter((x) => baseNodeId(x.id) === 'bl')
    .map((x) => (x.data as { params: Record<string, unknown> }).params[SUB_PASS_PARAM])
  assert(subs.length === 2, `expected 2 sub-passes, got ${subs.length}`)
  assert(subs.includes(0) && subs.includes(1), `sub-pass indices wrong: ${JSON.stringify(subs)}`)
})

test('generated ids and edge ids are unique', () => {
  const nodes = [n('img', 'image'), n('b1', 'blur', { radius: 8 }), n('b2', 'blur', { radius: 20 }), n('out', 'fragment_output')]
  const edges = [
    e('e1', 'img', 'color', 'b1', 'source'),
    e('e2', 'b1', 'color', 'b2', 'source'),
    e('e3', 'b2', 'color', 'out', 'color'),
  ]
  const out = call(nodes, edges)
  assert(new Set(out.nodes.map((x) => x.id)).size === out.nodes.length, 'duplicate node id')
  assert(new Set(out.edges.map((x) => x.id)).size === out.edges.length, 'duplicate edge id')
})

test('an unwired multi-pass node is NOT expanded (nothing to blur)', () => {
  const nodes = [n('bl', 'blur', { radius: 12 }), n('out', 'fragment_output')]
  const edges = [e('e2', 'bl', 'color', 'out', 'color')]
  const out = call(nodes, edges)
  assert(out.nodes.length === 2, `unwired node should stay single, got ${out.nodes.length}`)
})

// --- per-node preview (thumbnails) -----------------------------------------
// Both of these shipped broken and were caught by looking at the node thumbs.

test('a node preview runs ALL sub-passes, not just the first', () => {
  const nodes = [n('cb', 'checkerboard'), n('bl', 'blur', { radius: 20 })]
  const edges = [e('e1', 'cb', 'color', 'bl', 'source')]
  const r = compileNodePreview(nodes as never, edges as never, 'bl')
  assert(r.success, `preview failed: ${JSON.stringify(r.errors)}`)
  const axes = r.passes.map((p) =>
    /vec2\(1\.0, 0\.0\)/.test(p.fragmentShader) ? 'H' : /vec2\(0\.0, 1\.0\)/.test(p.fragmentShader) ? 'V' : '-',
  )
  assert(axes.includes('H'), `horizontal pass missing: ${axes.join(',')}`)
  assert(axes.includes('V'), `vertical pass missing — preview only ran the first sub-pass: ${axes.join(',')}`)
})

test('an UNWIRED multi-pass node emits valid WGSL (no GLSL-style constructors)', () => {
  // An explicit WGSL override skips the backend's mechanical translation, so a
  // GLSL-syntax port default leaked through as `vec4(...)`, which WGSL rejects.
  // The shader then failed to compile and the thumbnail showed stale content.
  const nodes = [n('bl', 'blur', { radius: 20 })]
  const ir = compileNodePreviewIR(nodes as never, [] as never, 'bl') as unknown as
    { success: boolean; wgslPasses: Array<{ shaderCode: string }> }
  assert(ir.success, 'unwired preview should compile')
  const code = ir.wgslPasses.map((p) => p.shaderCode).join('\n')
  const bad = code.match(/\bvec[234]\(/g)
  assert(!bad, `GLSL-style constructor left in WGSL: ${bad?.slice(0, 3).join(', ')}`)
  assert(!/\bfloat\b/.test(code), 'GLSL `float` left in WGSL')
})

test('a wired connectable param reaches EVERY sub-pass, not just the first', () => {
  // Shipped broken: only the first sub-pass saw the wire, so the second silently
  // used the stored default — a blur whose two axes disagreed.
  const nodes = [n('cb', 'checkerboard'), n('bl', 'blur', { radius: 12 }), n('out', 'fragment_output'), n('num', 'float_constant', { value: 40 })]
  const edges = [
    e('e1', 'cb', 'color', 'bl', 'source'),
    e('e2', 'bl', 'color', 'out', 'color'),
    e('e3', 'num', 'value', 'bl', 'radius'),
  ]
  const out = call(nodes, edges)
  const subs = out.nodes.filter((x) => baseNodeId(x.id) === 'bl').map((x) => x.id)
  assert(subs.length === 2, `expected 2 sub-passes, got ${subs.length}`)
  for (const id of subs) {
    const fed = out.edges.some((x) => x.target === id && x.targetHandle === 'radius' && x.source === 'num')
    assert(fed, `sub-pass ${id} is missing the wired radius`)
  }
  // and the chain input must NOT be duplicated onto the later sub-pass
  const chainInputs = out.edges.filter((x) => x.targetHandle === 'source' && x.target === subs[1])
  assert(chainInputs.length === 1, `sub-pass 2 should have exactly one source edge, got ${chainInputs.length}`)
  assert(baseNodeId(chainInputs[0].source) === 'bl', 'sub-pass 2 must read the previous sub-pass, not the original source')
})

test('baseNodeId maps a sub-pass id back to the authored node', () => {
  assert(baseNodeId('bl') === 'bl', 'plain id unchanged')
  assert(baseNodeId('bl-sp1') === 'bl', 'sub-pass id resolves to base')
  assert(baseNodeId('my-node-1-sp3') === 'my-node-1', 'hyphenated base preserved')
})

run('multipass-expand')
