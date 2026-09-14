/**
 * Can a wire be drawn into a port that only exists on THIS instance?
 *
 * A node's connectable params were looked up in the static `def.params`. A node
 * whose params vary per instance declares them through `dynamicParams`, so the
 * lookup missed them and the canvas refused the drop — silently, because React
 * Flow's only vocabulary for "no" is not attaching the wire. Every other site
 * that iterates params already went through `resolveParams`; the canvas was the
 * last holdout. Stack's per-layer opacity and mask are exactly this shape, which
 * is why this is the last framework piece it needs.
 *
 * The fixture is the point. `late_*` exists ONLY through `dynamicParams`, so a
 * predicate that reads the static list cannot see it — and each test asserts
 * that is still true before asserting the wire is accepted, so a fixture that
 * quietly gains a static `late` fails loudly instead of passing for free.
 *
 * The mirror matters as much: "accepted" is satisfiable by `() => true`, so
 * every acceptance here is paired with a refusal that must still hold —
 * a port that does not exist, a type that cannot coerce, a loop.
 *
 * Run: npx tsx scripts/verify-connection-validity.ts
 */
import { initializeNodeLibrary } from '../src/nodes'
import { nodeRegistry } from '../src/nodes/registry'
import { isConnectionValid } from '../src/nodes/connection-validity'
import type { ValidityNode, ValidityEdge } from '../src/nodes/connection-validity'
import { declare, variable, binary } from '../src/compiler/ir/types'
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import type { NodeDefinition, NodeParameter } from '../src/nodes/types'

initializeNodeLibrary()

const lookup = (t: string) => nodeRegistry.get(t)

const node = (id: string, type: string, params: Record<string, unknown> = {}): ValidityNode =>
  ({ id, data: { type, params } })
const edge = (source: string, target: string): ValidityEdge => ({ source, target })

/** Connectable, and reachable only through dynamicParams. */
const late = (i: number): NodeParameter => ({
  id: `late_${i}`, label: `Late ${i}`, type: 'float', default: 0.5,
  min: 0, max: 1, step: 0.01, connectable: true, updateMode: 'uniform',
})

/**
 * A sampler2D connectable param, also dynamic. Every numeric port type coerces
 * to every other one (float↔vec2↔vec3↔vec4↔color), so a numeric fixture cannot
 * tell "the port was found" apart from "the type check was skipped". sampler2D
 * is the only type outside that family, so it is the only one that can.
 */
const lateTex = (i: number): NodeParameter => ({
  id: `lateTex_${i}`, label: `Late Tex ${i}`, type: 'sampler2D', default: 0,
  connectable: true, updateMode: 'uniform',
})

const layersNode: NodeDefinition = {
  type: 'test_conn_validity',
  label: 'Test Connection Validity',
  category: 'effect',
  inputs: [{ id: 'color', label: 'Color', type: 'color', default: [1, 1, 1, 1] }],
  outputs: [{ id: 'color', label: 'Color', type: 'color' }],
  // Deliberately EMPTY. `late_*` and `lateTex_0` exist only through
  // dynamicParams, so a predicate reading this array sees no connectable param
  // at all and the acceptance tests below cannot pass by accident.
  params: [],
  dynamicParams: (params) => {
    const count = Math.max(1, Math.min(8, Number(params.layerCount) || 1))
    return [
      ...Array.from({ length: count }, (_, i) => late(i)),
      lateTex(0),
    ]
  },
  glsl: (ctx) => `vec4 ${ctx.outputs.color} = ${ctx.inputs.color} * ${ctx.inputs.late_0};`,
  ir: (ctx) => ({
    statements: [declare(ctx.outputs.color, 'vec4',
      binary('*', variable(ctx.inputs.color), variable(ctx.inputs.late_0), 'vec4'))],
    uniforms: [], standardUniforms: new Set<string>(),
  }),
}
nodeRegistry.register(layersNode)

/**
 * The fixture is only meaningful while the port is absent from the static list
 * and present on this instance.
 *
 * Both halves ask the node DEFINITION directly rather than going through
 * `targetPorts`. Using the subject to vet its own fixture is how a guard stops
 * being a guard: perturb `targetPorts` back to the static lookup and a
 * `targetPorts`-based check fails as "fixture is broken", hiding the real
 * finding — that the wire is refused — behind a fixture complaint.
 */
function assertOnlyDynamic(id: string, params: Record<string, unknown>) {
  const def = nodeRegistry.get('test_conn_validity')!
  assert(!(def.params ?? []).some((p) => p.id === id),
    `fixture no longer exercises the bug: ${id} is in the STATIC params, so a predicate reading def.params would find it`)
  assert(def.dynamicParams !== undefined, 'fixture is broken: the node lost its dynamicParams')
  assert(def.dynamicParams!(params).some((p) => p.id === id && p.connectable),
    `fixture is broken: ${id} is not a connectable param of this instance at all`)
}

const twoLayers = { layerCount: 2 }
const base = () => [
  node('src', 'float_constant'),
  node('fx', 'test_conn_validity', twoLayers),
  node('out', 'fragment_output'),
]

test('1 · a wire into a per-instance connectable param is ACCEPTED', () => {
  assertOnlyDynamic('late_0', twoLayers)
  assert(isConnectionValid(
    { source: 'src', sourceHandle: 'value', target: 'fx', targetHandle: 'late_0' },
    base(), [], lookup,
  ), 'a wire into late_0 was refused — the canvas cannot see per-instance params')
})

test('2 · a param that appears only at a HIGHER count is accepted at that count', () => {
  // The count is what creates the port, so this is the half that proves the
  // predicate reads THIS node's params rather than any fixed resolution.
  const atFour = { layerCount: 4 }
  assertOnlyDynamic('late_3', atFour)
  const nodesAtFour = [node('src', 'float_constant'), node('fx', 'test_conn_validity', atFour)]
  assert(isConnectionValid(
    { source: 'src', sourceHandle: 'value', target: 'fx', targetHandle: 'late_3' },
    nodesAtFour, [], lookup,
  ), 'late_3 was refused at layerCount 4, where it exists')
})

test('3 · the same param is REFUSED at a count that does not have it', () => {
  // The mirror of test 2 on the same identifier: if this passed too, the
  // predicate would be accepting any handle name rather than resolving ports.
  assert(!isConnectionValid(
    { source: 'src', sourceHandle: 'value', target: 'fx', targetHandle: 'late_3' },
    base(), [], lookup,
  ), 'late_3 was accepted at layerCount 2, where that port does not exist')
})

test('4 · a type that cannot coerce is REFUSED on a dynamic param', () => {
  // Proves the type check still runs on this path, rather than the port simply
  // being waved through once it is found. Only sampler2D can show this: the
  // numeric types all coerce to one another.
  assertOnlyDynamic('lateTex_0', twoLayers)
  assert(!isConnectionValid(
    { source: 'src', sourceHandle: 'value', target: 'fx', targetHandle: 'lateTex_0' },
    base(), [], lookup,
  ), 'a float source was accepted into a sampler2D param')
})

test('5 · a wire that would close a loop is REFUSED, dynamic param or not', () => {
  const nodes = [node('a', 'test_conn_validity', twoLayers), node('b', 'test_conn_validity', twoLayers)]
  const edges = [edge('a', 'b')]
  assert(!isConnectionValid(
    { source: 'b', sourceHandle: 'color', target: 'a', targetHandle: 'late_0' },
    nodes, edges, lookup,
  ), 'a wire into a dynamic param closed a loop and was accepted')
})

test('6 · fan-out and converge is still ACCEPTED', () => {
  // The diamond that the cycle walk must not mistake for a loop, asked through
  // this predicate rather than through wouldCreateCycle directly.
  const nodes = [
    node('a', 'float_constant'),
    node('b', 'test_conn_validity', twoLayers),
    node('c', 'test_conn_validity', twoLayers),
    node('d', 'test_conn_validity', twoLayers),
  ]
  const edges = [edge('a', 'b'), edge('a', 'c'), edge('b', 'd')]
  assert(isConnectionValid(
    { source: 'c', sourceHandle: 'color', target: 'd', targetHandle: 'color' },
    nodes, edges, lookup,
  ), 'c→d was refused, so fan-out-and-converge reads as a cycle')
})

test('7 · a static connectable param on a shipped node still works', () => {
  // dynamicParams is the exception, not the rule: every shipped node reaches
  // this path through the `def.params` branch of resolveParams. If that
  // regressed, nothing else here would notice.
  const def = nodeRegistry.get('mix')!
  const staticConnectable = (def.params ?? []).find((p) => p.connectable)
  assert(staticConnectable !== undefined, 'fixture assumption broken: mix has no static connectable param')
  assert(!def.dynamicParams, 'fixture assumption broken: mix now has dynamicParams')
  const nodes = [node('src', 'float_constant'), node('m', 'mix')]
  assert(isConnectionValid(
    { source: 'src', sourceHandle: 'value', target: 'm', targetHandle: staticConnectable!.id },
    nodes, [], lookup,
  ), `a wire into mix's static connectable param ${staticConnectable!.id} was refused`)
})

test('8 · a handle that exists on NO node is REFUSED', () => {
  assert(!isConnectionValid(
    { source: 'src', sourceHandle: 'value', target: 'fx', targetHandle: 'not_a_port' },
    base(), [], lookup,
  ), 'a made-up handle was accepted')
})

test('9 · dynamic INPUTS are still resolved, not just dynamic params', () => {
  // The predicate resolves two different per-instance sources. A change that
  // fixed params by replacing the inputs branch would pass every test above.
  const def = nodeRegistry.get('test_conn_validity')!
  assert(!def.dynamicInputs, 'fixture assumption broken — see the note below')
  // No shipped node pairs dynamicInputs with dynamicParams yet, so this asserts
  // the static-input branch still resolves rather than faking a dynamic one.
  assert(isConnectionValid(
    { source: 'src', sourceHandle: 'value', target: 'fx', targetHandle: 'color' },
    base(), [], lookup,
  ), 'a wire into the static `color` input was refused')
})

await run('connection-validity')
