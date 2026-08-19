/**
 * Node-id uniqueness verification — regression gate for the duplicate-node-id
 * bug (wrong preview + cross-node math entanglement).
 *
 * Root cause: node ids were minted as `${type}-${Date.now()}`, so two same-type
 * nodes created in the same millisecond got identical ids. Every id-keyed
 * structure then collapsed onto one key — the preview store, and (silently) the
 * compiler, whose `topologicalSort` visited-set and `new Map(nodes.map(...))`
 * keep only the last node with a given id. One node drove the other's math and
 * both cards showed the same thumbnail.
 *
 * This gate proves:
 *   A. makeNodeId never collides, even minted in a tight synchronous loop.
 *   B. (property) N same-type nodes with UNIQUE ids compile to N distinct node
 *      output vars — no collapse, no entanglement.
 *   C. (control / mechanism-engaged) the SAME graph with a shared id collapses
 *      to ONE output var, and the downstream `mix` reads that one var for BOTH
 *      of its inputs — proving B's metric genuinely detects entanglement and is
 *      not vacuously true. Perturbing unique→shared MUST flip B's result.
 *   D. dedupeNodeIds repairs an already-poisoned graph to all-unique ids, and
 *      is a reference-equal no-op when the graph is already clean.
 *   E. preview-store keys never alias between two unique-id nodes.
 *
 * Run: npx tsx scripts/verify-node-id.ts
 */

import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../src/nodes/types'
import { makeNodeId, dedupeNodeIds } from '../src/utils/node-id'
import { initializeNodeLibrary } from '../src/nodes/index'
import { compileGraph } from '../src/compiler/glsl-generator'

initializeNodeLibrary()

let failures = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  [PASS] ${name}`)
  } else {
    failures++
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// --- helpers to build a minimal, valid, single-pass graph -------------------
function node(id: string, type: string, params: Record<string, unknown> = {}): Node<NodeData> {
  return { id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params } } as Node<NodeData>
}
function edge(source: string, sourceHandle: string, target: string, targetHandle: string): Edge<EdgeData> {
  return { id: `${source}:${sourceHandle}->${target}:${targetHandle}`, source, sourceHandle, target, targetHandle } as Edge<EdgeData>
}

/** Two gradients → mix(a,b) → fragment_output. Both gradients are reachable, so
 *  each contributes a `node_<sanitizedId>_color` output var when ids differ. */
function buildGraph(gid1: string, gid2: string): { nodes: Node<NodeData>[]; edges: Edge<EdgeData>[] } {
  const nodes = [
    node(gid1, 'gradient'),
    node(gid2, 'gradient'),
    node('mix-1', 'mix'),
    node('output-1', 'fragment_output'),
  ]
  const edges = [
    edge(gid1, 'color', 'mix-1', 'a'),
    edge(gid2, 'color', 'mix-1', 'b'),
    edge('mix-1', 'result', 'output-1', 'color'),
  ]
  return { nodes, edges }
}

const sanitize = (id: string) => id.replace(/-/g, '_')
/** distinct gradient output vars (`node_<id>_color`) present in the shader */
function gradientOutputVars(src: string, ids: string[]): string[] {
  return ids.filter((id) => src.includes(`node_${sanitize(id)}_color`))
}

// ===========================================================================
console.log('\nA. makeNodeId uniqueness (tight synchronous loop)')
{
  const N = 200_000
  const seen = new Set<string>()
  for (let i = 0; i < N; i++) seen.add(makeNodeId('gradient'))
  check(`${N} ids minted in one tick are all unique`, seen.size === N, `got ${seen.size} distinct`)
  check('ids keep the readable type prefix', makeNodeId('color_ramp').startsWith('color_ramp-'))
}

console.log('\nB. property — unique ids compile to distinct output vars (no collapse)')
let distinctVarCount = -1
{
  const gid1 = 'gradient-aaaaaaaa'
  const gid2 = 'gradient-bbbbbbbb'
  const { nodes, edges } = buildGraph(gid1, gid2)
  const plan = compileGraph(nodes, edges)
  const src = plan.fragmentShader
  const vars = gradientOutputVars(src, [gid1, gid2])
  distinctVarCount = vars.length
  check('two unique-id gradients → 2 distinct output vars', vars.length === 2, `got ${vars.length}`)
  const gradIds = new Set(plan.userUniforms.map((u) => u.nodeId).filter((n) => n === gid1 || n === gid2))
  check('two unique-id gradients → uniforms keyed under 2 distinct nodeIds', gradIds.size === 2, `got ${gradIds.size}`)
  check('compile produced no error pass', !src.includes('COMPILE_ERROR') && src.length > 0)
}

console.log('\nC. control — shared id collapses (proves the metric detects entanglement)')
{
  const shared = 'gradient-dupdupdup'
  const { nodes, edges } = buildGraph(shared, shared)
  const plan = compileGraph(nodes, edges)
  const src = plan.fragmentShader
  const vars = gradientOutputVars(src, [shared])
  check('two SHARED-id gradients → only 1 output var (collapse)', vars.length === 1, `got ${vars.length}`)
  // Entanglement: mix's a and b both read the single collapsed gradient var.
  const readCount = (src.match(new RegExp(`node_${sanitize(shared)}_color`, 'g')) || []).length
  check('collapsed var is read ≥2× (mix.a and mix.b entangled onto it)', readCount >= 2, `read ${readCount}×`)
  // The perturbation MUST flip B's outcome, or B was vacuous.
  check('perturbing unique→shared flips the distinct-var count (2 → 1)', distinctVarCount === 2 && vars.length === 1)
}

console.log('\nD. dedupeNodeIds — repairs poisoned graphs, no-op when clean')
{
  const shared = 'gradient-dupdupdup'
  const { nodes, edges } = buildGraph(shared, shared)
  const repaired = dedupeNodeIds(nodes, edges)
  const ids = repaired.nodes.map((n) => n.id)
  check('duplicate id is reassigned', new Set(ids).size === ids.length, `ids=${JSON.stringify(ids)}`)
  check('exactly 1 node repaired', repaired.repaired === 1, `repaired=${repaired.repaired}`)
  check('first occurrence keeps its id', ids[0] === shared)
  check('reassigned node keeps its type prefix', ids[1].startsWith('gradient-') && ids[1] !== shared)

  const clean = buildGraph('gradient-x', 'gradient-y')
  const noop = dedupeNodeIds(clean.nodes, clean.edges)
  check('clean graph → reference-equal no-op', noop.nodes === clean.nodes && noop.repaired === 0)

  // After repair, a re-compile no longer collapses the two gradient nodes into
  // one node id (they are distinct node objects now, even if the reassigned one
  // is unwired). Prove the node-id map no longer collapses:
  const mapSize = new Map(repaired.nodes.map((n) => [n.id, n])).size
  check('repaired graph: node-id map does not collapse', mapSize === repaired.nodes.length, `mapSize=${mapSize}/${repaired.nodes.length}`)
}

console.log('\nE. preview-store keying never aliases between unique-id nodes')
{
  // Mirrors ShaderNode.tsx: `usePreviewStore((s) => s.previews[nodeId])`.
  const previews: Record<string, string> = {}
  const a = makeNodeId('gradient')
  const b = makeNodeId('gradient')
  previews[a] = 'bitmap-A'
  previews[b] = 'bitmap-B'
  check('two unique-id nodes read different preview keys', previews[a] !== previews[b])
  // A shared id WOULD alias — confirm the store model, then confirm dedupe fixes it.
  const shared = 'gradient-same'
  const sharedPreviews: Record<string, string> = {}
  sharedPreviews[shared] = 'bitmap-A'
  sharedPreviews[shared] = 'bitmap-B' // second node overwrites → both cards show B
  check('shared id aliases in the store (bug model)', sharedPreviews[shared] === 'bitmap-B')
  const fixed = dedupeNodeIds([node(shared, 'gradient'), node(shared, 'gradient')], [])
  check('after dedupe the two nodes have distinct preview keys', fixed.nodes[0].id !== fixed.nodes[1].id)
}

// ===========================================================================
console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(`  SUMMARY: all checks passed`)
  console.log('='.repeat(60))
  process.exit(0)
} else {
  console.log(`  SUMMARY: ${failures} FAILED`)
  console.log('='.repeat(60))
  process.exit(1)
}
