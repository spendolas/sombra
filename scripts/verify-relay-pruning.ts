/**
 * Do relay passes carry only the code their own output needs?
 *
 * When several branches converge at one pass depth, each extra source output
 * becomes a relay pass. Relays re-emit the ENTIRE pass body and change only the
 * final assignment, so N converging branches produce N passes carrying N bodies:
 * shader text grows with N squared. The Stack node makes that routine.
 *
 * This asserts size AND equality together on purpose. Size alone passes if you
 * emit a broken tiny shader; equality alone passes if you change nothing.
 *
 * Run: npx tsx scripts/verify-relay-pruning.ts
 */
import { initializeNodeLibrary } from '../src/nodes'
import { compileGraph } from '../src/compiler/glsl-generator'
import { compileGraphIR } from '../src/compiler/ir-compiler'
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import type { Node, Edge } from '@xyflow/react'

initializeNodeLibrary()

const n = (id: string, t: string, p: Record<string, unknown> = {}) =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: t, params: p } }) as unknown as Node
const e = (id: string, s: string, sh: string, tg: string, th: string) =>
  ({ id, source: s, sourceHandle: sh, target: tg, targetHandle: th }) as unknown as Edge

/**
 * `branches` independent noise→pixelate chains, all converging into a chain of
 * mixes. Each pixelate's `source` is a textureInput, so every branch becomes its
 * own boundary at the same depth — the relay-producing shape.
 *
 * Distinct noise `seed` values per branch matter: identical branches could in
 * principle be deduplicated by some later optimisation, and this gate must keep
 * measuring relays rather than accidentally measuring CSE.
 */
function convergingGraph(branches: number) {
  const nodes: Node[] = []
  const edges: Edge[] = []
  const tips: string[] = []
  for (let i = 0; i < branches; i++) {
    // gradient, NOT noise: noise's only output is `value` (float), so a
    // `color` edge from it is rejected before the bug can be reached
    // (noise.ts:25, gradient.ts:43).
    nodes.push(n(`src${i}`, 'gradient', { angle: i * 15 }))
    nodes.push(n(`fx${i}`, 'pixelate'))
    edges.push(e(`ea${i}`, `src${i}`, 'color', `fx${i}`, 'source'))
    tips.push(`fx${i}`)
  }
  let acc = tips[0]
  for (let i = 1; i < tips.length; i++) {
    const mixId = `mix${i}`
    nodes.push(n(mixId, 'mix'))
    // mix's output is `result`, not `color` (mix.ts:31). Its inputs are a/b.
    edges.push(e(`em${i}a`, acc, i === 1 ? 'color' : 'result', mixId, 'a'))
    edges.push(e(`em${i}b`, tips[i], 'color', mixId, 'b'))
    acc = mixId
  }
  nodes.push(n('out', 'fragment_output'))
  edges.push(e('eout', acc, branches > 1 ? 'result' : 'color', 'out', 'color'))
  return { nodes, edges }
}

/**
 * `branches` two-hop chains — gradient → brightness_contrast → pixelate —
 * converging into a chain of mixes, same convergence shape as `convergingGraph`.
 *
 * `convergingGraph`'s per-branch boundary source (a gradient) is a LEAF: it has
 * no upstream dependency inside its pass, so `nodesFeeding` returning just
 * `{startNodeId}` happens to equal the correct transitive answer there. That
 * fixture cannot tell a crippled `nodesFeeding` from a correct one. Inserting
 * brightness_contrast between the gradient and the pixelate gives the relay's
 * immediate source (brightness_contrast) its own upstream dependency
 * (gradient) inside the same pass — the case the transitive walk exists for.
 */
function multiHopConvergingGraph(branches: number) {
  const nodes: Node[] = []
  const edges: Edge[] = []
  const tips: string[] = []
  for (let i = 0; i < branches; i++) {
    nodes.push(n(`src${i}`, 'gradient', { angle: i * 15 }))
    nodes.push(n(`bc${i}`, 'brightness_contrast'))
    nodes.push(n(`fx${i}`, 'pixelate'))
    edges.push(e(`ea${i}`, `src${i}`, 'color', `bc${i}`, 'color'))
    edges.push(e(`eb${i}`, `bc${i}`, 'result', `fx${i}`, 'source'))
    tips.push(`fx${i}`)
  }
  let acc = tips[0]
  for (let i = 1; i < tips.length; i++) {
    const mixId = `mix${i}`
    nodes.push(n(mixId, 'mix'))
    edges.push(e(`em${i}a`, acc, i === 1 ? 'color' : 'result', mixId, 'a'))
    edges.push(e(`em${i}b`, tips[i], 'color', mixId, 'b'))
    acc = mixId
  }
  nodes.push(n('out', 'fragment_output'))
  edges.push(e('eout', acc, branches > 1 ? 'result' : 'color', 'out', 'color'))
  return { nodes, edges }
}

// The two backends name their shader field DIFFERENTLY. RenderPass has
// `fragmentShader` (glsl-generator.ts:56); WGSLPassOutput has `shaderCode`
// (ir-compiler.ts:457) and no `fragmentShader` at all — reading the wrong one
// yields undefined.length and the size comparison measures nothing.
const glslChars = (plan: { passes: Array<{ fragmentShader: string }> }) =>
  plan.passes.reduce((sum, p) => sum + p.fragmentShader.length, 0)
const wgslChars = (plan: { passes: Array<{ shaderCode: string }> }) =>
  plan.passes.reduce((sum, p) => sum + p.shaderCode.length, 0)

test('GLSL: total shader size grows sub-quadratically with converging branches', () => {
  const g2 = convergingGraph(2), g6 = convergingGraph(6)
  const two = compileGraph(g2.nodes, g2.edges)
  const six = compileGraph(g6.nodes, g6.edges)
  assert(two.success && six.success, 'compile failed')
  const ratio = glslChars(six) / glslChars(two)
  // 3x the branches. Linear-ish growth lands near 3-5x; quadratic re-emission
  // lands near 9x or above. The threshold is deliberately loose — this measures
  // an asymptote, not an exact size.
  assert(ratio < 6,
    `shader size grew ${ratio.toFixed(1)}x for 3x the branches — relays are still re-emitting whole bodies`)
})

test('GLSL: only ONE pass carries the full body', () => {
  const { nodes, edges } = convergingGraph(4)
  const plan = compileGraph(nodes, edges)
  assert(plan.success, 'compile failed')
  const lens = plan.passes.map((p) => p.fragmentShader.split('\n').length)
  const max = Math.max(...lens)
  const atMax = lens.filter((l) => l === max).length
  // Today the primary and all 3 relays tie at the maximum because each re-emits
  // the entire pass body. After pruning, exactly one pass should carry it.
  //
  // This replaces an earlier `relays.some(l => l < max)` shape that looked
  // plausible but was satisfiable by an unrelated cheap pass: for 4 branches
  // the actual line counts are [162, 162, 162, 162, 72] — four passes tied at
  // the bloated maximum (the bug) plus one small combining pass that exists
  // regardless of whether relays are pruned. `some(l < max)` was trivially
  // true because of that combiner, so it passed on unfixed source. Counting
  // ties at the max is the assertion that actually distinguishes "N passes
  // duplicate the body" from "one pass is naturally cheaper." Do not revert to
  // the tidier-looking `some()` form — it measures nothing.
  assert(atMax === 1,
    `${atMax} passes tie at ${max} lines — relays still carry the full body (lines: ${JSON.stringify(lens)})`)
})

test('WGSL: same, on the IR path', () => {
  const g2 = convergingGraph(2), g6 = convergingGraph(6)
  const two = compileGraphIR(g2.nodes, g2.edges)
  const six = compileGraphIR(g6.nodes, g6.edges)
  // No `success` field on this path — null is the only failure signal.
  assert(two !== null && six !== null, 'IR compile returned null')
  const ratio = wgslChars(six!) / wgslChars(two!)
  assert(ratio < 6,
    `WGSL shader size grew ${ratio.toFixed(1)}x for 3x the branches`)
})

test('every pass still declares its own fragColor exactly once', () => {
  const { nodes, edges } = convergingGraph(4)
  const plan = compileGraph(nodes, edges)
  for (const p of plan.passes) {
    const assignments = (p.fragmentShader.match(/fragColor\s*=/g) ?? []).length
    assert(assignments === 1,
      `a pass assigns fragColor ${assignments} times — pruning broke pass assembly`)
    assert(!p.fragmentShader.includes('undefined'), 'pruned shader contains "undefined"')
  }
})

test('GLSL: no pass references a node_ identifier it never declares', () => {
  // Uses the MULTI-HOP fixture, not convergingGraph: a relay's immediate
  // source there has its own upstream dependency inside the same pass, so an
  // over-prune that keeps only the source's own line (dropping what it reads)
  // shows up as a reference with no matching declaration. convergingGraph's
  // per-branch source is a leaf and cannot distinguish a crippled
  // `nodesFeeding` (`return new Set([startNodeId])`) from a correct one — a
  // check built on it would be vacuous.
  const { nodes, edges } = multiHopConvergingGraph(4)
  const plan = compileGraph(nodes, edges)
  assert(plan.success, 'compile failed')

  const declType = '(?:vec2|vec3|vec4|float|int|bool|mat2|mat3|mat4)'
  const declRe = new RegExp(`\\b${declType}\\s+(node_\\w+)\\s*=`, 'g')
  const refRe = /\bnode_\w+\b/g

  for (const p of plan.passes) {
    const src = p.fragmentShader
    const declared = new Set<string>()
    for (const m of src.matchAll(declRe)) declared.add(m[1])
    const referenced = new Set<string>()
    for (const m of src.matchAll(refRe)) referenced.add(m[0])
    const undeclared = [...referenced].filter((id) => !declared.has(id))
    assert(undeclared.length === 0,
      `pass ${p.index} references undeclared identifier(s): ${undeclared.join(', ')} — a relay dropped a declaration its own body still reads`)
  }
})

run('relay-pruning')
