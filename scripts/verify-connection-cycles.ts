/**
 * Does the canvas REFUSE to draw a cycle — and still allow everything else?
 *
 * Cycles were diagnosed, never prevented. `isValidConnection` checked node
 * existence, port existence and type compatibility, so an output could be
 * wired back into its own upstream. Compilation then reported "Graph contains
 * cycles" — but `topologicalSort` itself has no cycle detection and returns a
 * silently mis-ordered list, so every path that sorts without first calling
 * `hasCycles` is working from a bad order.
 *
 * The assertion that actually proves the fix is not "a cycle is rejected" —
 * `() => true` passes that. It is that a DIAMOND is still accepted. `A→B`,
 * `A→C`, `B→D`, `C→D` reaches D by two paths and is a DAG; a reachability
 * walk with a mishandled visited set rejects it, and rejecting fan-out-and-
 * converge would break the topology every multi-input node is made of — far
 * worse than the bug being fixed, and invisible to an outcome-only test.
 *
 * Three halves:
 *   - BEHAVIOUR   true cycles rejected AND diamonds, fan-out, joins and edges
 *                 into connectable params all still connectable.
 *   - AGREEMENT   `wouldCreateCycle` matches `hasCycles` over the same graph
 *                 plus the candidate, on every shape below. Two traversals
 *                 that must agree about what a cycle is are two that can
 *                 disagree; this is what keeps the fast walk honest against
 *                 the definition the four compilers actually use.
 *   - TERMINATION a cyclic graph can still ARRIVE by file load or share URL,
 *                 so hovering a handle over one must not walk the loop
 *                 forever. Checked out-of-process with a time limit, because
 *                 a hang inside the runner is a hung CI job, not a failure.
 *   - REACH       a source scan proving `isValidConnection` in FlowCanvas.tsx
 *                 calls it and depends on `edges`. A helper that passes its
 *                 own tests while nothing wires it into the canvas is the
 *                 failure mode this half exists for — FlowCanvas.tsx cannot
 *                 be imported in Node, so the scan stands in for it.
 *
 * Run: npx tsx scripts/verify-connection-cycles.ts
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import { hasCycles } from '../src/compiler/topological-sort'
import { compileGraph } from '../src/compiler/glsl-generator'
import { initializeNodeLibrary } from '../src/nodes'

// Imported by name rather than statically, so a missing export reports as a
// failed case instead of crashing the runner before the source-scan gate runs.
type Sorter = typeof import('../src/compiler/topological-sort')
const sorter = await import('../src/compiler/topological-sort') as Partial<Sorter>
const wouldCreateCycle: Sorter['wouldCreateCycle'] = sorter.wouldCreateCycle
  ?? (() => { throw new Error('wouldCreateCycle is not exported from src/compiler/topological-sort.ts') })
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../src/nodes/types'

const ROOT = resolve(import.meta.dirname, '..')

initializeNodeLibrary()

const nShader = (id: string, type: string) =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params: {} } }) as unknown as Node<NodeData>

const n = (id: string) =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: 'mix', params: {} } }) as unknown as Node<NodeData>
const e = (s: string, t: string, targetHandle = 'a') =>
  ({ id: `${s}-${t}`, source: s, sourceHandle: 'result', target: t, targetHandle }) as unknown as Edge<EdgeData>

const nodes = ['a', 'b', 'c', 'd', 'out'].map(n)

/**
 * Every case below, recorded so the agreement gate can replay them against
 * `hasCycles`. `expected` is what `wouldCreateCycle` must answer.
 */
const cases: Array<{ what: string; edges: Edge<EdgeData>[]; candidate: { source: string; target: string }; expected: boolean }> = []
const record = (what: string, edges: Edge<EdgeData>[], candidate: { source: string; target: string }, expected: boolean) => {
  cases.push({ what, edges, candidate, expected })
  return { edges, candidate }
}

test('1 · a wire back into its own upstream is rejected', () => {
  // a → b → c, then c → a closes the loop.
  const c = record('back-edge over a chain', [e('a', 'b'), e('b', 'c')], { source: 'c', target: 'a' }, true)
  assert(wouldCreateCycle(c.edges, c.candidate), 'c → a over a → b → c must be refused')
})

test('2 · a two-node loop is rejected', () => {
  const c = record('two-node loop', [e('a', 'b')], { source: 'b', target: 'a' }, true)
  assert(wouldCreateCycle(c.edges, c.candidate), 'b → a over a → b must be refused')
})

test('3 · a self-connection is rejected', () => {
  const c = record('self-connection', [], { source: 'a', target: 'a' }, true)
  assert(wouldCreateCycle(c.edges, c.candidate), 'a → a must be refused')
})

test('4 · a long chain closing on its head is rejected, and terminates', () => {
  // 400 links: a walk that revisits nodes would not come back from this.
  const long: Edge<EdgeData>[] = []
  const many: Node<NodeData>[] = []
  for (let i = 0; i < 400; i++) {
    many.push(n(`x${i}`))
    if (i > 0) long.push(e(`x${i - 1}`, `x${i}`))
  }
  const candidate = { source: 'x399', target: 'x0' }
  cases.push({ what: 'long chain', edges: long, candidate, expected: true })
  const t0 = performance.now()
  const got = wouldCreateCycle(long, candidate)
  const ms = performance.now() - t0
  assert(got, 'x399 → x0 over a 400-link chain must be refused')
  assert(ms < 50, `the walk took ${ms.toFixed(1)}ms on 400 nodes — it is not terminating early`)
})

// --- the half that matters: the check must not refuse valid graphs -----

test('5 · a plain forward connection is allowed', () => {
  const c = record('forward edge', [e('a', 'b')], { source: 'b', target: 'c' }, false)
  assert(!wouldCreateCycle(c.edges, c.candidate), 'b → c is a DAG edge and must stay connectable')
})

test('6 · a DIAMOND is allowed — two paths to the same node are not a cycle', () => {
  // A→B, A→C, B→D; adding C→D converges. A visited set handled wrongly
  // rejects this, and rejecting it breaks every multi-input node there is.
  const c = record('diamond', [e('a', 'b'), e('a', 'c'), e('b', 'd')], { source: 'c', target: 'd' }, false)
  assert(!wouldCreateCycle(c.edges, c.candidate),
    'convergence is not a cycle — this is the shape fan-out-and-converge makes')
})

test('7 · fan-out from one output is allowed', () => {
  const c = record('fan-out', [e('a', 'b'), e('a', 'c')], { source: 'a', target: 'd' }, false)
  assert(!wouldCreateCycle(c.edges, c.candidate), 'a third consumer of the same output is not a cycle')
})

test('8 · connecting two disjoint sub-graphs is allowed', () => {
  const c = record('join two chains', [e('a', 'b'), e('c', 'd')], { source: 'b', target: 'c' }, false)
  assert(!wouldCreateCycle(c.edges, c.candidate), 'joining two chains head-to-tail is not a cycle')
})

test('9 · an edge into a CONNECTABLE PARAM carries a cycle like any other', () => {
  // Connectable params are handles too (`factor` on mix), and the existing
  // edges here arrive on one. Handles are irrelevant to reachability — the
  // check must key on node ids, or a loop closed through a param slips past.
  const viaParam = [e('a', 'b', 'factor'), e('b', 'c', 'factor')]
  const bad = record('cycle through a param handle', viaParam, { source: 'c', target: 'a' }, true)
  assert(wouldCreateCycle(bad.edges, bad.candidate),
    'c → a.factor over a → b.factor → c must be refused')
  const good = record('param edge, no cycle', viaParam, { source: 'a', target: 'c' }, false)
  assert(!wouldCreateCycle(good.edges, good.candidate),
    'a → c.factor adds a second path, not a loop')
})

test('10 · the candidate edge is a probe, not a mutation', () => {
  // A check that appended to the caller's array would corrupt the graph on
  // every rejected hover during a drag.
  const edges = [e('a', 'b')]
  const before = edges.length
  wouldCreateCycle(edges, { source: 'b', target: 'a' })
  assert(edges.length === before, `wouldCreateCycle mutated the edge list (${before} → ${edges.length})`)
  assert(!hasCycles(nodes, edges), 'the graph must be unchanged after a rejected probe')
})

test('11 · every case agrees with hasCycles, the definition the compilers use', () => {
  // The fast walk is a SECOND traversal; this is what stops it drifting from
  // the one `glsl-generator`, `ir-compiler` and both subgraph compilers call.
  assert(cases.length >= 10, `expected the cases above to have registered, got ${cases.length}`)
  for (const c of cases) {
    const all = [...new Set([...c.edges.flatMap((x) => [x.source, x.target]), c.candidate.source, c.candidate.target])].map(n)
    const probe = { id: '__probe__', source: c.candidate.source, target: c.candidate.target } as unknown as Edge<EdgeData>
    const authoritative = hasCycles(all, [...c.edges, probe])
    const got = wouldCreateCycle(c.edges, c.candidate)
    assert(got === c.expected, `${c.what}: wouldCreateCycle said ${got}, expected ${c.expected}`)
    assert(got === authoritative,
      `${c.what}: wouldCreateCycle said ${got} but hasCycles over the same graph said ${authoritative}`)
  }
})

test('12 · a cyclic graph that arrives by file load still compiles to an error', () => {
  // This gate guards NEW connections only. A cycle from a .sombra file or a
  // share URL must still load and fail at compile with the existing message —
  // adding validation to the load path would silently drop the user's edges.
  const graph = [nShader('s', 'checkerboard'), nShader('m', 'mix'), nShader('o', 'fragment_output')]
  const cyclic = [
    { id: 'c1', source: 's', sourceHandle: 'color', target: 'm', targetHandle: 'a' },
    { id: 'c2', source: 'm', sourceHandle: 'result', target: 'm', targetHandle: 'b' },
    { id: 'c3', source: 'm', sourceHandle: 'result', target: 'o', targetHandle: 'color' },
  ] as unknown as Edge<EdgeData>[]
  const plan = compileGraph(graph, cyclic)
  assert(!plan.success, 'a cyclic graph must not compile')
  assert(plan.errors.some((x) => /cycle/i.test(x.message)),
    `expected a cycle error, got: ${plan.errors.map((x) => x.message).join('; ')}`)
})

test('13 · the walk terminates on a graph that is ALREADY cyclic', () => {
  // Reachable: gate 12 keeps the load path unvalidated on purpose, so a cycle
  // from a file is live in the editor, and hovering any handle calls this.
  // Run it in a child process — without the visited set this does not return,
  // and a hang inside the runner is a hung CI job rather than a red gate.
  const probe = `
    import { wouldCreateCycle } from ${JSON.stringify(resolve(ROOT, 'src/compiler/topological-sort.ts'))}
    const edges = []
    for (let i = 0; i < 24; i++) edges.push({ id: 'e' + i, source: 'k' + i, target: 'k' + ((i + 1) % 24) })
    // A second chord through the loop, so a walk without a visited set
    // explodes combinatorially even before it fails to terminate.
    for (let i = 0; i < 24; i += 2) edges.push({ id: 'c' + i, source: 'k' + i, target: 'k' + ((i + 5) % 24) })
    wouldCreateCycle(edges, { source: 'zzz', target: 'k0' })
    console.log('RETURNED')
  `
  const r = spawnSync('npx', ['tsx', '--eval', probe], { cwd: ROOT, encoding: 'utf8', timeout: 25_000 })
  assert(r.error === undefined || (r.error as NodeJS.ErrnoException).code !== 'ETIMEDOUT',
    'wouldCreateCycle did not return on an already-cyclic graph — it walks the loop forever')
  assert(r.stdout.includes('RETURNED'),
    `the probe did not complete: ${r.stderr.split('\n').slice(0, 3).join(' ')}`)
})

test('14 · isValidConnection in FlowCanvas.tsx actually calls it', () => {
  const src = readFileSync(resolve(ROOT, 'src/components/FlowCanvas.tsx'), 'utf8')
  const start = src.indexOf('const isValidConnection')
  assert(start >= 0, 'isValidConnection not found in FlowCanvas.tsx — renamed?')
  // Up to the end of that useCallback, i.e. its dependency array.
  const end = src.indexOf('  )', src.indexOf('    },', start))
  const body = src.slice(start, end)
  assert(/wouldCreateCycle\s*\(/.test(body),
    'isValidConnection does not call wouldCreateCycle — a cycle can still be drawn')
  assert(/\[[^\]]*\bedges\b[^\]]*\]/.test(body),
    'isValidConnection must depend on `edges`, or it validates against a stale graph')
})

await run('connection-cycles')
