/**
 * Does an edge into a connectable DYNAMIC param survive persistence?
 *
 * Two places validate an edge's targetHandle against a set built from the node
 * definition. Both resolve dynamicInputs and then read the STATIC def.params for
 * connectable ones, so a handle that exists only through dynamicParams is not in
 * the set and the edge is silently dropped.
 *
 * The assertions check that the EDGE SURVIVES, not that the function returns —
 * both functions return happily today while deleting it.
 *
 * Run: npx tsx scripts/verify-dynamic-param-edges.ts
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initializeNodeLibrary } from '../src/nodes'
import { nodeRegistry } from '../src/nodes/registry'
import { exportToFile, importFromFile } from '../src/utils/sombra-file'
import { buildValidHandles } from '../src/stores/graphStore'
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import type { Node, Edge } from '@xyflow/react'
import type { NodeDefinition, NodeParameter } from '../src/nodes/types'

initializeNodeLibrary()

const n = (id: string, t: string, p: Record<string, unknown> = {}) =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: t, params: p } }) as unknown as Node
const e = (id: string, s: string, sh: string, tg: string, th: string) =>
  ({ id, source: s, sourceHandle: sh, target: tg, targetHandle: th }) as unknown as Edge

const gain = (i: number): NodeParameter => ({
  id: `gain_${i}`, label: `Gain ${i}`, type: 'float', default: 0.5,
  min: 0, max: 1, step: 0.01, connectable: true, updateMode: 'uniform',
})

/**
 * `gain_0` is static, `gain_1` exists only through dynamicParams. Both are
 * wired. The static one must survive (proving the fixture works); the dynamic
 * one is the bug.
 */
const testNode: NodeDefinition = {
  type: 'test_dyn_param_edges',
  label: 'Test Dynamic Param Edges',
  category: 'effect',
  inputs: [{ id: 'color', label: 'Color', type: 'color', default: [1, 1, 1, 1] }],
  outputs: [{ id: 'color', label: 'Color', type: 'color' }],
  params: [gain(0)],
  dynamicParams: (params) => {
    const count = Math.max(1, Math.min(8, Number(params.gainCount) || 1))
    return Array.from({ length: count }, (_, i) => gain(i))
  },
  glsl: (ctx) => `vec4 ${ctx.outputs.color} = ${ctx.inputs.color};`,
  ir: () => ({
    // Body intentionally trivial — this gate is about persistence, not codegen.
    // Never reaches a codegen path: the gate only exports/imports the graph.
    statements: [],
    uniforms: [],
    standardUniforms: new Set<string>(),
  }),
}
nodeRegistry.register(testNode)

function graph() {
  const nodes = [
    n('a', 'checkerboard'),
    n('g0', 'gradient'),
    n('g1', 'gradient'),
    n('fx', 'test_dyn_param_edges', { gainCount: 2 }),
    n('out', 'fragment_output'),
  ]
  const edges = [
    e('e0', 'a', 'color', 'fx', 'color'),
    e('e1', 'g0', 'value', 'fx', 'gain_0'),   // static param — must survive
    e('e2', 'g1', 'value', 'fx', 'gain_1'),   // DYNAMIC param — the bug
    e('e3', 'fx', 'color', 'out', 'color'),
    e('e4', 'g0', 'value', 'fx', 'removed_param'),   // handle does not exist at all — must be pruned
  ]
  return { nodes, edges }
}

test('a .sombra round trip keeps the wire into a dynamic param', () => {
  const { nodes, edges } = graph()
  const back = importFromFile(exportToFile(nodes as never, edges as never))
  const ids = back.edges.map((x) => x.id)
  assert(ids.includes('e1'), 'the STATIC param wire was dropped — the fixture is wrong, fix it before reading anything else')
  assert(ids.includes('e2'),
    `the wire into the dynamic param gain_1 was deleted on load. Survivors: ${JSON.stringify(ids)}`)
  // The other half of the fix: pruning stale handles is the entire reason
  // these functions exist (e.g. `boxFreq` → `frequency`). An edge into a
  // handle that genuinely does not exist on the target node must still be
  // dropped — an over-permissive fix that stops pruning would leave every
  // other assertion in this file green.
  assert(!ids.includes('e4'),
    `the wire into removed_param (a handle that does not exist on the target node) survived the round trip — the prune stopped pruning. Survivors: ${JSON.stringify(ids)}`)
})

test('buildValidHandles resolves connectable dynamic params, not just static def.params', () => {
  const testDef = nodeRegistry.get('test_dyn_param_edges')!
  const handles = buildValidHandles(testDef, { gainCount: 2 })
  assert(handles.has('gain_1'),
    `buildValidHandles(def, { gainCount: 2 }) did not contain gain_1 — it read static def.params instead of resolving dynamicParams. Got: ${JSON.stringify([...handles])}`)
  // Negative direction: with gainCount 2, only gain_0/gain_1 exist through
  // dynamicParams. gain_5 must NOT be in the set — an over-permissive
  // buildValidHandles (e.g. dropping the `.filter(p => p.connectable)`, or
  // unioning def.params with resolveParams "to be safe") would let this pass
  // silently while every other assertion here stays green.
  assert(!handles.has('gain_5'),
    `buildValidHandles(def, { gainCount: 2 }) contained gain_5, which does not exist at gainCount 2 — the set is over-permissive. Got: ${JSON.stringify([...handles])}`)
})

test('migrate actually calls buildValidHandles (not a parallel inline set)', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(__dirname, '../src/stores/graphStore.ts'), 'utf8')
  const migrateStart = src.indexOf('migrate: (persisted: unknown) => {')
  assert(migrateStart !== -1, 'could not find the `migrate:` block in graphStore.ts — has it been renamed/restructured?')
  // The migrate closure runs until the matching `return state` that closes it out.
  const migrateEnd = src.indexOf('return state', migrateStart)
  assert(migrateEnd !== -1, 'could not find the end of the `migrate:` block in graphStore.ts')
  const migrateBody = src.slice(migrateStart, migrateEnd)
  // Scanning for the bare substring `buildValidHandles(` is satisfied by
  // `buildValidHandles(def, {})`, which reintroduces the original bug for any
  // node whose dynamic param count is driven by a param (dynamicParams keyed
  // off nodeParams never sees them). Pin the full call with its real
  // arguments so a regression to the loose form fails here.
  assert(migrateBody.includes('buildValidHandles(def, targetNode.data.params)'),
    'migrate does not call buildValidHandles(def, targetNode.data.params) — it may be computing validHandles inline again, or calling it with the wrong/empty params object, which the extracted-helper gate alone cannot see')
  assert(!migrateBody.includes('def.params?.filter(p => p.connectable)'),
    'migrate still contains the old inline static-params construction — half-migrated: the helper may be correct but migrate is not calling it')
})

run('dynamic-param-edges')
