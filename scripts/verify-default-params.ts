/**
 * Does every node-creation site get its OWN copy of a structured default?
 *
 * Six sites materialise a node's params from its definition: canvas drop
 * (FlowCanvas), command palette, dev bridge, image file drop, share-URL decode
 * and .sombra import's defaults merge. Each copied `p.default` by reference.
 * For scalars that is harmless; for a structured default — Stack's layer list,
 * an array of objects — every node created from the definition, and the
 * registry itself, would share ONE array. Undo snapshots are shallow, so a
 * single in-place edit would reach every node and every snapshot, and the
 * share-URL encoder strips params `deepEqual` to the default — which
 * short-circuits on identity.
 *
 * Two halves, deliberately:
 *   - BEHAVIOUR on the sites reachable without React (the helper itself,
 *     share-URL decode, .sombra import): the materialised value is a deep copy,
 *     and mutating it in place leaves the registry default untouched.
 *   - ROUTING for the React-bound sites (FlowCanvas, CommandPalette) and the
 *     dev bridge, which can't be driven from tsx: no file under src/ may still
 *     assign `<x>.default` into a params slot. Every site has to go through
 *     `defaultParams` / `cloneParamDefault`.
 *
 * Run: npm run verify:default-params
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initializeNodeLibrary } from '../src/nodes'
import { nodeRegistry } from '../src/nodes/registry'
import { defaultParams } from '../src/nodes/default-params'
import { encodeCompactHash, decodeCompactHash, importFromFile } from '../src/utils/sombra-file'
import { declare, literal } from '../src/compiler/ir/types'
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import type { Node, Edge } from '@xyflow/react'
import type { NodeDefinition, NodeData, EdgeData } from '../src/nodes/types'

initializeNodeLibrary()

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TYPE = 'test_structured_default'
const DEFAULT_LIST = [
  { id: 'a', name: 'Layer 1', blendMode: 'normal', visible: true },
  { id: 'b', name: 'Layer 2', blendMode: 'normal', visible: true },
]

const fixture: NodeDefinition = {
  type: TYPE,
  label: 'Test Structured Default',
  category: 'effect',
  inputs: [],
  outputs: [{ id: 'color', label: 'Color', type: 'color' }],
  params: [
    { id: 'items', label: 'Items', type: 'float', default: DEFAULT_LIST, hidden: true, updateMode: 'recompile' },
    { id: 'gain', label: 'Gain', type: 'float', default: 0.5, updateMode: 'uniform' },
  ],
  glsl: (ctx) => `vec4 ${ctx.outputs.color} = vec4(1.0);`,
  ir: (ctx) => ({
    statements: [declare(ctx.outputs.color, 'vec4', literal('vec4', [1, 1, 1, 1]))],
    uniforms: [], standardUniforms: new Set<string>(),
  }),
}
nodeRegistry.register(fixture)

const registryDefault = () => nodeRegistry.get(TYPE)!.params!.find((p) => p.id === 'items')!.default as typeof DEFAULT_LIST
const snapshot = JSON.stringify(DEFAULT_LIST)

function assertIsolated(items: unknown, where: string) {
  assert(Array.isArray(items), `${where}: items is not an array (${JSON.stringify(items)})`)
  const list = items as typeof DEFAULT_LIST
  assert(JSON.stringify(list) === snapshot, `${where}: the copy does not equal the default`)
  assert(list !== registryDefault(), `${where}: the list IS the registry's default array (aliased)`)
  assert(list[0] !== registryDefault()[0], `${where}: the list's first item IS the registry's object (shallow copy)`)
  // The consequence, not just the identity: an in-place edit stays local.
  list[0].name = 'EDITED'
  assert(registryDefault()[0].name === 'Layer 1',
    `${where}: editing the node's list in place changed the REGISTRY default to "${registryDefault()[0].name}"`)
}

test('defaultParams deep-copies a structured default and passes scalars through', () => {
  const a = defaultParams(nodeRegistry.get(TYPE))
  assert(a.gain === 0.5, `scalar default lost: ${a.gain}`)
  assertIsolated(a.items, 'defaultParams')
  const b = defaultParams(nodeRegistry.get(TYPE))
  assert(b.items !== a.items, 'two nodes created from one definition share an items array')
})

test('share-URL decode gives each node its own copy of a stripped default', () => {
  const nodes = [
    { id: 'n1', type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: TYPE, params: defaultParams(nodeRegistry.get(TYPE)) } },
    { id: 'out', type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: 'fragment_output', params: {} } },
  ] as unknown as Node<NodeData>[]
  const edges = [{ id: 'e', source: 'n1', sourceHandle: 'color', target: 'out', targetHandle: 'color' }] as unknown as Edge<EdgeData>[]
  const hash = encodeCompactHash(nodes, edges)
  const decoded = decodeCompactHash(hash)
  const n1 = decoded.nodes.find((n) => n.id === 'n1')!
  // The default was stripped on encode, so this value came from the decode's
  // own defaults merge — the site under test.
  assertIsolated(n1.data.params.items, 'decodeCompactHash')
})

test('a list edited away from the default survives the share URL', () => {
  const params = defaultParams(nodeRegistry.get(TYPE))
  params.items = [...(params.items as typeof DEFAULT_LIST), { id: 'c', name: 'Layer 3', blendMode: 'screen', visible: false }]
  const nodes = [
    { id: 'n1', type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: TYPE, params } },
    { id: 'out', type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: 'fragment_output', params: {} } },
  ] as unknown as Node<NodeData>[]
  const edges = [{ id: 'e', source: 'n1', sourceHandle: 'color', target: 'out', targetHandle: 'color' }] as unknown as Edge<EdgeData>[]
  const decoded = decodeCompactHash(encodeCompactHash(nodes, edges))
  const items = decoded.nodes.find((n) => n.id === 'n1')!.data.params.items as typeof DEFAULT_LIST
  assert(Array.isArray(items) && items.length === 3 && items[2].name === 'Layer 3',
    `the edited list did not survive the round trip: ${JSON.stringify(items)}`)
})

test('.sombra import merges a missing structured default as a copy', () => {
  const file = {
    sombra: 3,
    nodes: [{ id: 'n1', type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: TYPE, params: { gain: 0.7 } } }],
    edges: [],
  }
  const { nodes } = importFromFile(file)
  const n1 = nodes.find((n) => n.id === 'n1')!
  assert(n1.data.params.gain === 0.7, 'stored scalar lost')
  assertIsolated(n1.data.params.items, 'importFromFile')
})

test('no site under src/ still assigns a parameter default by reference', () => {
  // The React-bound sites cannot be driven from here, so this is how they are
  // held: the pattern every one of them used — `params[p.id] = p.default` —
  // must not appear anywhere outside the helper that clones.
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) { walk(p); continue }
      if (!/\.(ts|tsx)$/.test(ent.name)) continue
      if (p.endsWith(path.join('nodes', 'default-params.ts'))) continue
      fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        if (/\]\s*=\s*[\w.]*\bdefault\b\s*$|\]\s*=\s*[\w.]*\.default\b(?!\s*\()/.test(line.replace(/\/\/.*$/, '').trimEnd())) {
          offenders.push(`${path.relative(ROOT, p)}:${i + 1}: ${line.trim()}`)
        }
      })
    }
  }
  walk(path.join(ROOT, 'src'))
  assert(offenders.length === 0, `default assigned by reference:\n      ${offenders.join('\n      ')}`)
})

await run('default-params')
