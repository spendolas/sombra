/**
 * Does consumer-ordered emission produce a VALID schedule, on both backends,
 * and does it turn a deep Stack's memory from linear into constant?
 *
 * Order of assertions is deliberate — correctness before the saving:
 *   1. validity: every pass reads only EARLIER passes; the output pass is last
 *   2. permutation only: same pass count, same shader texts, same final pass
 *   3. the two compilers agree on the ordering
 *   4. only then: slot counts, bounded AND constant across layer count
 *
 * Every shape is compiled through the REAL compiler and expander. Hand-built
 * pass lists gave optimistic slot counts three separate times during this work
 * (docs/superpowers/plans/2026-09-14-consumer-ordered-emission.md).
 *
 * TODO(stack): the Stack-shaped cases use `test_pass_order_stack`, a
 * test-registered copy of the `test_stackish` fixture in
 * verify-subpass-routing.ts with a param-driven layer count. Re-point them at
 * the real Stack node once it lands (docs/superpowers/plans/2026-10-07-stack-node.md).
 *
 * Run: npx tsx scripts/verify-pass-order.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Node, Edge } from '@xyflow/react'
import { initializeNodeLibrary } from '../src/nodes'
import { nodeRegistry } from '../src/nodes/registry'
import type { NodeDefinition } from '../src/nodes/types'
import { compileGraph, type RenderPlan } from '../src/compiler/glsl-generator'
import { compileGraphIR, toPlanWgsl, type WGSLMultiPassOutput } from '../src/compiler/ir-compiler'
import { encodeArtifact, decodeArtifact, stripPlan, reconstructPlan, type SceneArtifact } from '../src/embed/artifact'
import { orderPassesByConsumer, setPassOrderingEnabled } from '../src/compiler/pass-order'
import { decodeSombraPackage, importFromFile } from '../src/utils/sombra-file'
import { test, run, assert } from './blur-bakeoff/lib/test-util'

initializeNodeLibrary()

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// Fixture: a Stack-shaped multiPass chain (see TODO(stack) above)
// ---------------------------------------------------------------------------

const MAX_LAYERS = 16
const layerPort = (i: number) => ({
  id: `layer_${i}`, label: `Layer ${i}`, type: 'color' as const,
  textureInput: true, default: [0, 0, 0, 0] as [number, number, number, number],
})

const stackNode: NodeDefinition = {
  type: 'test_pass_order_stack',
  label: 'Test Pass-Order Stack',
  category: 'effect',
  inputs: [
    { id: 'backdrop', label: 'Backdrop', type: 'color', textureInput: true, default: [0, 0, 0, 0] },
    ...Array.from({ length: MAX_LAYERS }, (_, i) => layerPort(i)),
  ],
  outputs: [{ id: 'color', label: 'Color', type: 'color' }],
  params: [{ id: 'layers', label: 'Layers', type: 'float', default: 2, hidden: true }],
  multiPass: {
    count: (p) => Number(p.layers ?? 2),
    from: 'color',
    to: 'backdrop',
    requiresWiredSource: false,
    routeEdge: (targetHandle, passIndex) =>
      targetHandle.startsWith('layer_') ? targetHandle === `layer_${passIndex}` : true,
  },
  glsl: (ctx) => `vec4 ${ctx.outputs.color} = vec4(0.0);`,
  ir: () => ({ statements: [], uniforms: [], standardUniforms: new Set<string>() }),
}
nodeRegistry.register(stackNode)

const n = (id: string, t: string, p: Record<string, unknown> = {}) =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: t, params: p } }) as unknown as Node
const e = (id: string, s: string, sh: string, tg: string, th: string) =>
  ({ id, source: s, sourceHandle: sh, target: tg, targetHandle: th }) as unknown as Edge

interface Graph { nodes: Node[]; edges: Edge[] }

/** A stack of `layers` independent sources. `feed(k)` may override layer k's source. */
function stackGraph(
  prefix: string,
  layers: number,
  feed: (k: number, g: Graph) => string | null = () => null,
): Graph & { out: string } {
  const g: Graph = { nodes: [], edges: [] }
  const stack = `${prefix}stack`
  g.nodes.push(n(stack, 'test_pass_order_stack', { layers }))
  for (let k = 0; k < layers; k++) {
    let src = feed(k, g)
    if (src === null) {
      src = `${prefix}src${k}`
      g.nodes.push(n(src, k % 2 ? 'gradient' : 'checkerboard'))
    }
    g.edges.push(e(`${prefix}e${k}`, src, 'color', stack, `layer_${k}`))
  }
  return { ...g, out: stack }
}

function withOutput(g: Graph & { out: string }): Graph {
  return {
    nodes: [...g.nodes, n('out', 'fragment_output')],
    edges: [...g.edges, e('e_out', g.out, 'color', 'out', 'color')],
  }
}

const plainStack = (layers: number) => withOutput(stackGraph('', layers))

/** 8 layers; layer 7 reuses layer 0's source node. */
const fanOut = () => withOutput(stackGraph('', 8, (k) => (k === 7 ? 'src0' : null)))

/** 8 layers; layer 3 is fed through a multi-pass blur. */
const blurLayer = () => withOutput(stackGraph('', 8, (k, g) => {
  if (k !== 3) return null
  g.nodes.push(n('bsrc', 'checkerboard'), n('blur3', 'blur'))
  g.edges.push(e('e_bsrc', 'bsrc', 'color', 'blur3', 'source'))
  return 'blur3'
}))

/** A 4-layer stack whose layer `at` is itself a 4-layer stack. */
const nested = (at: number) => withOutput(stackGraph('', 4, (k, g) => {
  if (k !== at) return null
  const inner = stackGraph('in_', 4)
  g.nodes.push(...inner.nodes)
  g.edges.push(...inner.edges)
  return inner.out
}))

// ---------------------------------------------------------------------------
// Compile both ways, both backends
// ---------------------------------------------------------------------------

type GlslPass = RenderPlan['passes'][number]
type WgslPass = WGSLMultiPassOutput['passes'][number]

interface Compiled {
  glsl: GlslPass[]
  wgsl: WgslPass[]
  glslSlots: number
  wgslSlots: number
}

function compileOnce(g: Graph, ordered: boolean, label: string): Compiled {
  setPassOrderingEnabled(ordered)
  try {
    const plan = compileGraph(g.nodes as never, g.edges as never)
    assert(plan.success, `${label}: GLSL compile failed: ${JSON.stringify(plan.errors)}`)
    const ir = compileGraphIR(g.nodes as never, g.edges as never)
    assert(ir !== null, `${label}: IR compile returned null`)
    // A single-pass plan owns no intermediate and carries no slotCount. Any
    // multi-pass plan must, or every count below is vacuous.
    const slots = (count: number | undefined, passes: number, which: string) => {
      if (passes === 1 && count === undefined) return 0
      assert(typeof count === 'number', `${label}: ${which} ${passes}-pass plan carries no slotCount`)
      return count!
    }
    return {
      glsl: plan.passes, wgsl: ir!.passes,
      glslSlots: slots(plan.slotCount, plan.passes.length, 'GLSL'),
      wgslSlots: slots(ir!.slotCount, ir!.passes.length, 'WGSL'),
    }
  } finally {
    setPassOrderingEnabled(true)
  }
}

const glslReads = (p: GlslPass) => Object.values(p.inputTextures)
const wgslReads = (p: WgslPass) => p.inputTextures.map((t) => t.passIndex)

/** Step 1. Every read is of an EARLIER pass; nothing reads the final pass. */
function assertValid(reads: number[][], label: string) {
  reads.forEach((srcs, i) => {
    for (const s of srcs) {
      assert(Number.isInteger(s) && s >= 0 && s < i,
        `${label}: INVALID SCHEDULE — pass ${i} reads pass ${s}, which is not earlier than it`)
    }
  })
  const last = reads.length - 1
  reads.forEach((srcs, i) => assert(!srcs.includes(last),
    `${label}: pass ${i} reads the final pass ${last} — the output pass is not last`))
}

/**
 * Step 1b. The output pass is the SAME pass it was before ordering. Reads alone
 * cannot prove this: a schedule can be valid and still end on the wrong pass.
 */
function assertOutputLast(before: string[], after: string[], label: string) {
  assert(after[after.length - 1] === before[before.length - 1],
    `${label}: the final pass after ordering is not the original output pass`)
}

/** Step 2. A permutation: same count, same multiset of shader texts. */
function assertPermutation(before: string[], after: string[], label: string) {
  assert(before.length === after.length,
    `${label}: pass count changed ${before.length} → ${after.length}`)
  const a = [...before].sort(), b = [...after].sort()
  assert(a.every((s, i) => s === b[i]), `${label}: shader texts changed — ordering must not alter any pass`)
}

/** Step 3. Both compilers schedule the same passes in the same order. */
function assertBackendsAgree(c: Compiled, label: string) {
  assert(c.glsl.length === c.wgsl.length,
    `${label}: GLSL has ${c.glsl.length} passes, WGSL ${c.wgsl.length}`)
  c.glsl.forEach((gp, i) => {
    assert(gp.index === i, `${label}: GLSL pass at position ${i} carries index ${gp.index}`)
    const wp = c.wgsl[i]
    const gr = Object.entries(gp.inputTextures).map(([s, ix]) => `${s}@${ix}`).sort().join(',')
    const wr = wp.inputTextures.map((t) => `${t.samplerName}@${t.passIndex}`).sort().join(',')
    assert(gr === wr, `${label}: pass ${i} reads differ — GLSL [${gr}] vs WGSL [${wr}]`)
    assert((gp.resolution ?? 1) === (wp.resolution ?? 1),
      `${label}: pass ${i} resolution differs — GLSL ${gp.resolution} vs WGSL ${wp.resolution}`)
    assert(gp.targetSlot === wp.targetSlot,
      `${label}: pass ${i} slot differs — GLSL ${gp.targetSlot} vs WGSL ${wp.targetSlot}`)
  })
}

/** No slot is overwritten while a later pass still needs its contents. */
function assertNoAliasing(reads: number[][], slots: Array<number | undefined>, label: string) {
  const lastReader = new Array<number>(reads.length).fill(-1)
  reads.forEach((srcs, i) => { for (const s of srcs) lastReader[s] = Math.max(lastReader[s], i) })
  if (reads.length === 1) return // single pass: renders to the canvas, owns no slot
  slots.forEach((slot, w) => {
    assert(typeof slot === 'number', `${label}: pass ${w} carries no targetSlot`)
    if (slot === -1) return
    for (let o = 0; o < w; o++) {
      if (slots[o] === slot) {
        assert(lastReader[o] < w,
          `${label}: pass ${w} overwrites slot ${slot} while pass ${o} is still read by pass ${lastReader[o]}`)
      }
    }
  })
}

interface Measured { passes: number; before: number; after: number; floor: number; optimum: number | null }

const OPTIMUM_MAX_PASSES = 18

/**
 * The fewest slots ANY valid order (output pass last) can use, by exhaustive
 * search over the set of passes already run — 2^n states, so only for small
 * plans. Peak live textures equals the liveness allocator's slot count for a
 * given order (one size class; interval colouring is optimal), so this is the
 * number the ordering heuristic is measured against, not a bound it might hit
 * by luck.
 */
function optimumSlots(reads: number[][]): number | null {
  const n = reads.length
  if (n > OPTIMUM_MAX_PASSES) return null
  const last = n - 1
  const readers = new Array<number>(n).fill(0)
  const needs = new Array<number>(n).fill(0)
  reads.forEach((srcs, i) => { for (const s of srcs) { readers[s] |= 1 << i; needs[i] |= 1 << s } })
  const full = (1 << n) - 1
  const memo = new Int8Array(1 << n).fill(-1)
  const best = (done: number): number => {
    if (done === full) return 0
    if (memo[done] >= 0) return memo[done]
    let live = 0
    for (let j = 0; j < n; j++) if ((done >> j) & 1 && readers[j] & ~done) live++
    let res = 127
    for (let i = 0; i < n; i++) {
      if ((done >> i) & 1 || (needs[i] & done) !== needs[i]) continue
      if (i === last && done !== (full ^ (1 << last))) continue
      res = Math.min(res, Math.max(live + (readers[i] ? 1 : 0), best(done | (1 << i))))
    }
    memo[done] = res
    return res
  }
  return best(0)
}

/**
 * The fewest slots ANY order could use: a pass that writes an intermediate
 * holds all its inputs plus its own target at once. When the partitioner
 * merges several composites into one pass that reads k textures, no
 * permutation gets below k + 1 — that is a partitioning property, not an
 * ordering one, and the gate must not demand the impossible.
 */
function slotFloor(reads: number[][]): number {
  const last = reads.length - 1
  return reads.reduce((m, r, i) => Math.max(m, new Set(r).size + (i === last ? 0 : 1)), 0)
}

/** Steps 1–3 on both backends, then return the slot counts for step 4. */
function measure(g: Graph, label: string): Measured {
  const before = compileOnce(g, false, `${label} [depth order]`)
  const after = compileOnce(g, true, label)

  assertValid(after.glsl.map(glslReads), `${label} GLSL`)
  assertValid(after.wgsl.map(wgslReads), `${label} WGSL`)
  assertOutputLast(before.glsl.map((p) => p.fragmentShader), after.glsl.map((p) => p.fragmentShader), `${label} GLSL`)
  assertOutputLast(before.wgsl.map((p) => p.shaderCode), after.wgsl.map((p) => p.shaderCode), `${label} WGSL`)
  assertPermutation(before.glsl.map((p) => p.fragmentShader), after.glsl.map((p) => p.fragmentShader), `${label} GLSL`)
  assertPermutation(before.wgsl.map((p) => p.shaderCode), after.wgsl.map((p) => p.shaderCode), `${label} WGSL`)
  assertBackendsAgree(after, label)
  assertNoAliasing(after.glsl.map(glslReads), after.glsl.map((p) => p.targetSlot), `${label} GLSL`)
  assertNoAliasing(after.wgsl.map(wgslReads), after.wgsl.map((p) => p.targetSlot), `${label} WGSL`)
  assert(after.glslSlots === after.wgslSlots,
    `${label}: GLSL needs ${after.glslSlots} slots, WGSL ${after.wgslSlots}`)

  const floor = slotFloor(after.glsl.map(glslReads))
  assert(after.glslSlots >= floor, `${label}: ${after.glslSlots} slots is below the structural floor ${floor} — aliasing`)
  const optimum = optimumSlots(after.glsl.map(glslReads))
  if (optimum !== null) {
    assert(after.glslSlots >= optimum, `${label}: ${after.glslSlots} slots is below the optimum ${optimum} — aliasing`)
  }
  return { passes: after.glsl.length, before: before.glslSlots, after: after.glslSlots, floor, optimum }
}

const table: string[] = []
const record = (shape: string, m: Measured) => table.push(
  `  ${shape.padEnd(34)} ${String(m.passes).padStart(6)} ${String(m.passes - 1).padStart(10)} ` +
  `${String(m.before).padStart(10)} ${String(m.after).padStart(10)} ${String(m.optimum ?? '—').padStart(8)}`,
)

// ---------------------------------------------------------------------------
// The permutation's own contract (hand-built lists are fine HERE: these test
// the function's fallback, not a slot count)
// ---------------------------------------------------------------------------

type P = { id: string; reads: number[] }
/**
 * Reorder, then assert the result is a PERMUTATION whose reads still name the
 * same passes. "Valid and ends on `out`" is satisfied by a schedule that runs
 * the output twice and drops another pass — seen when the output pin was
 * removed — so every unit result is checked for that first.
 */
const reorder = (ps: P[]) => {
  const out = orderPassesByConsumer(
    ps, (p) => p.reads, (p, m) => ({ ...p, reads: p.reads.map((r) => m[r]) }),
  )
  const ids = (xs: P[]) => xs.map((p) => p.id)
  assert(JSON.stringify([...ids(out)].sort()) === JSON.stringify([...ids(ps)].sort()),
    `not a permutation: ${JSON.stringify(ids(ps))} → ${JSON.stringify(ids(out))}`)
  const byId = new Map(ps.map((p) => [p.id, p.reads.map((r) => ps[r]?.id)]))
  for (const p of out) {
    assert(JSON.stringify(p.reads.map((r) => out[r]?.id)) === JSON.stringify(byId.get(p.id)),
      `${p.id}'s reads were not remapped with it`)
  }
  return out
}

test('fallback: a cyclic plan comes back in its ORIGINAL order, untouched', () => {
  const ps: P[] = [{ id: 'a', reads: [1] }, { id: 'b', reads: [0] }, { id: 'c', reads: [] }, { id: 'out', reads: [1] }]
  const out = reorder(ps)
  assert(out === ps, `expected the original array back, got ${JSON.stringify(out.map((p) => p.id))}`)
})

test('fallback: a read of a non-existent pass comes back in its ORIGINAL order', () => {
  const ps: P[] = [{ id: 'a', reads: [] }, { id: 'b', reads: [7] }, { id: 'c', reads: [] }, { id: 'out', reads: [0, 1, 2] }]
  const out = reorder(ps)
  assert(out === ps, `expected the original array back, got ${JSON.stringify(out.map((p) => p.id))}`)
})

// On every compiler-produced plan the output pass transitively reads every
// other pass, so it can only ever become ready LAST and removing the pin
// changes nothing there. This plan has a pass the output does not read, which
// is the only way the pin becomes observable: without it, the output (which
// frees its input, scoring better than the pending side chain r1 → r2) would
// be picked as soon as `m` has run.
test('the output pass stays last even when another pass is not its ancestor', () => {
  const ps: P[] = [
    { id: 'a', reads: [] }, { id: 'm', reads: [0] },
    { id: 'r1', reads: [] }, { id: 'r2', reads: [2] },
    { id: 'out', reads: [1] },
  ]
  const out = reorder(ps)
  assertValid(out.map((p) => p.reads), 'unit')
  assert(out[out.length - 1].id === 'out',
    `the output pass is not last: ${JSON.stringify(out.map((p) => p.id))}`)
})

test('a source moves next to its consumer, and indices are remapped with it', () => {
  // depth order: s0 s1 s2 | c0(s0) c1(c0,s1) out(c1,s2)
  const ps: P[] = [
    { id: 's0', reads: [] }, { id: 's1', reads: [] }, { id: 's2', reads: [] },
    { id: 'c0', reads: [0] }, { id: 'c1', reads: [3, 1] }, { id: 'out', reads: [4, 2] },
  ]
  const out = reorder(ps)
  assertValid(out.map((p) => p.reads), 'unit')
  assert(out[out.length - 1].id === 'out', 'output pass is not last')
  const ids = out.map((p) => p.id).join(' ')
  assert(ids === 's0 c0 s1 c1 s2 out', `expected "s0 c0 s1 c1 s2 out", got "${ids}"`)
})

// ---------------------------------------------------------------------------
// Compiler-produced Stack shapes
// ---------------------------------------------------------------------------

const STACK_BOUND = 3
const IRREGULAR_BOUND = 4
const LAYER_COUNTS = [2, 4, 8, 16]

/**
 * The answers, written down — measured on these compiler-produced plans. A
 * bound alone is satisfied by a lucky small case; a pinned number moves the
 * moment ordering, partitioning or relay grouping changes, and then has to be
 * re-measured on purpose. Each entry is [depth order + liveness, + ordering].
 */
const EXPECTED: Record<string, [number, number]> = {
  'stack×2': [3, 2], 'stack×4': [5, 3], 'stack×8': [9, 3], 'stack×16': [17, 3],
  'fan-out': [9, 4],
  'blur-layer': [9, 4],
  'nested@0': [8, 3], 'nested@1': [8, 4], 'nested@2': [8, 5], 'nested@3': [8, 5],
}

function expectSlots(label: string, m: Measured) {
  // Where the optimum is computable, the ordering must reach it exactly.
  if (m.optimum !== null) {
    assert(m.after === m.optimum, `${label}: ordered plan needs ${m.after} slots, the best valid order needs ${m.optimum} — ordering left slack`)
  }
  const [before, after] = EXPECTED[label]
  assert(m.before === before, `${label}: depth order needs ${m.before} slots, expected ${before} — re-measure`)
  assert(m.after === after, `${label}: ordered plan needs ${m.after} slots, expected ${after} — re-measure`)
}

test('plain stack: valid on both backends, ≤ 3 slots, and CONSTANT from 4 to 16 layers', () => {
  const counts: number[] = []
  const measured: Measured[] = []
  for (const layers of LAYER_COUNTS) {
    const m = measure(plainStack(layers), `stack×${layers}`)
    measured.push(m)
    record(`stack, ${layers} layers`, m)
    assert(m.passes === 2 * layers,
      `stack×${layers}: expected ${2 * layers} passes (N sources + N composites), got ${m.passes} — the fixture no longer has the Stack's shape`)
    counts.push(m.after)
  }
  // Validity for every N is asserted inside measure() before any count is read.
  for (const [i, c] of counts.entries()) {
    assert(c <= STACK_BOUND, `stack×${LAYER_COUNTS[i]}: ${c} slots, bound is ${STACK_BOUND}`)
  }
  // The property that distinguishes a bound from a coincidence. Two layers is
  // excluded from EQUALITY only: s0 c0 s1 out holds at most two textures, so it
  // sits under the bound rather than at it.
  const deep = counts.slice(1)
  assert(deep.every((c) => c === deep[0]),
    `slot count is not constant across layer count: ${LAYER_COUNTS.map((l, i) => `${l}→${counts[i]}`).join(', ')}`)
  measured.forEach((m, i) => expectSlots(`stack×${LAYER_COUNTS[i]}`, m))
})

test('fan-out: 8 layers, one source feeding two layers — ≤ 4 slots', () => {
  const m = measure(fanOut(), 'fan-out')
  record('fan-out (8 layers, 0 reused by 7)', m)
  assert(m.after <= IRREGULAR_BOUND, `fan-out: ${m.after} slots, bound is ${IRREGULAR_BOUND}`)
  expectSlots('fan-out', m)
})

test('multi-pass blur feeding layer 3 of 8 — ≤ 4 slots', () => {
  const m = measure(blurLayer(), 'blur-layer')
  record('8 layers, layer 3 via multi-pass blur', m)
  assert(m.after <= IRREGULAR_BOUND, `blur-layer: ${m.after} slots, bound is ${IRREGULAR_BOUND}`)
  expectSlots('blur-layer', m)
})

test('4-layer stack nested in a 4-layer stack, at every layer position — ≤ 4, or the optimum where the partition forces more', () => {
  for (const at of [0, 1, 2, 3]) {
    const m = measure(nested(at), `nested@${at}`)
    record(`4-in-4 nested, inner at layer ${at}`, m)
    // At layers 2 and 3 the partitioner merges an inner and an outer composite
    // into one pass reading 4 textures, so 5 is forced by the PARTITION and no
    // order can do better. There the gate demands the exhaustive optimum
    // (expectSlots) instead of a bound the plan cannot meet.
    if (m.floor > IRREGULAR_BOUND) {
      assert(m.optimum !== null, `nested@${at}: floor ${m.floor} exceeds the bound and no optimum was computed`)
    } else {
      assert(m.after <= IRREGULAR_BOUND, `nested@${at}: ${m.after} slots, bound is ${IRREGULAR_BOUND}`)
    }
    expectSlots(`nested@${at}`, m)
  }
})

// The embed artifact bakes a compiled plan. Its codec carries passes through
// whole, but a reordered plan is exactly what a codec with an index
// assumption would mishandle — so round-trip one rather than assume it.
test('a reordered plan survives the embed artifact round trip with every read intact', () => {
  const g = plainStack(8)
  const plan = compileGraph(g.nodes as never, g.edges as never)
  const ir = compileGraphIR(g.nodes as never, g.edges as never)
  assert(plan.success && ir !== null, 'compile failed')
  plan.wgsl = toPlanWgsl(ir!)
  const reads = plan.passes.map(glslReads)
  assert(reads.some((r, i) => r.some((s) => s !== i - 1)),
    'fixture has no non-adjacent read — it would not exercise the remap')
  const artifact: SceneArtifact = {
    v: 1, kind: 'frozen', plan: stripPlan(plan), manifest: [], images: [],
    meta: { anchor: [0.5, 0.5], timeSpeed: 1 },
  }
  const back = reconstructPlan(decodeArtifact(encodeArtifact(artifact)).plan)
  assert(back.passes.length === plan.passes.length, 'pass count changed across the round trip')
  back.passes.forEach((p, i) => {
    assert(p.index === i, `pass ${i} came back with index ${p.index}`)
    assert(JSON.stringify(p.inputTextures) === JSON.stringify(plan.passes[i].inputTextures),
      `pass ${i} reads changed across the round trip`)
    assert(p.targetSlot === plan.passes[i].targetSlot, `pass ${i} slot changed across the round trip`)
    assert(p.fragmentShader === plan.passes[i].fragmentShader, `pass ${i} shader changed across the round trip`)
  })
  assert(back.slotCount === plan.slotCount, 'GLSL slotCount lost across the round trip')
  assert(back.wgsl?.slotCount === plan.wgsl!.slotCount, 'WGSL slotCount lost across the round trip')
  back.wgsl!.passes.forEach((p, i) => {
    assert(JSON.stringify(p.inputTextures) === JSON.stringify(plan.wgsl!.passes[i].inputTextures),
      `WGSL pass ${i} reads changed across the round trip`)
    assert(p.targetSlot === plan.wgsl!.passes[i].targetSlot, `WGSL pass ${i} slot changed across the round trip`)
  })
})

// ---------------------------------------------------------------------------
// The real corpus: ordering must change NOTHING here
// ---------------------------------------------------------------------------

test('real saved graphs: valid, backends agree, and slot counts UNCHANGED', () => {
  const dir = path.join(ROOT, 'shaders')
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.sombra') || f.endsWith('.json')).sort()
    : []
  if (files.length === 0) {
    // shaders/ is gitignored and never reaches a worktree or CI. Say so loudly
    // rather than reporting an unchanged corpus that was never looked at.
    console.warn('  WARN: shaders/ is empty or absent — the corpus check ran on NOTHING. ' +
      'Copy it from the main checkout to run it.')
    return
  }
  let before = 0, after = 0, multiPass = 0, reordered = 0
  for (const f of files) {
    const payload = decodeSombraPackage(new Uint8Array(fs.readFileSync(path.join(dir, f))))
    const { nodes, edges } = importFromFile(payload)
    const g = { nodes: nodes as unknown as Node[], edges: edges as unknown as Edge[] }
    const m = measure(g, `corpus:${f}`)
    assert(m.after === m.before,
      `corpus:${f}: slot count moved ${m.before} → ${m.after}. Real graphs are expected to be ` +
      `unchanged; if this is a genuine improvement, re-measure and update this expectation deliberately`)
    before += m.before
    after += m.after
    if (m.passes > 1) multiPass++
    const plain = compileOnce(g, false, f).glsl.map((p) => p.fragmentShader).join('\0')
    const ord = compileOnce(g, true, f).glsl.map((p) => p.fragmentShader).join('\0')
    if (plain !== ord) reordered++
  }
  console.log(`  corpus: ${files.length} graphs (${multiPass} multi-pass, ${reordered} reordered) — ` +
    `slots ${before} → ${after}`)
})

test('summary', () => {
  console.log('  shape                              passes  one-per-pass  +liveness  +ordering  optimum')
  for (const row of table) console.log(row)
})

run('pass-order')
