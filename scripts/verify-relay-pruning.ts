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

/**
 * `branches` THREE-hop chains — gradient → pixelate → tile — converging into
 * a chain of mixes. Both pixelate and tile declare a `textureInput` source,
 * so this graph is TWO passes deep before the branches converge: pass0 is the
 * gradients, pass1 is the pixelates (each sampling its own gradient's
 * boundary), pass2+ is the tiles/mixes/output.
 *
 * That matters because pass1 is where a relay gets born (both branches'
 * pixelates sit in the same pass, each feeding a distinct tile downstream —
 * one primary output, one relay), and pass1 ALSO has its own input samplers
 * (from pass0). `convergingGraph` and `multiHopConvergingGraph` both put
 * every relay in pass 0, which never has input samplers of its own — that is
 * exactly why the stale-declaration regression (relay keeps a sampler its
 * pruned body no longer references) went uncaught: there was nothing for it
 * to leave behind.
 */
function twoLevelConvergingGraph(branches: number) {
  const nodes: Node[] = []
  const edges: Edge[] = []
  const tips: string[] = []
  for (let i = 0; i < branches; i++) {
    nodes.push(n(`src${i}`, 'gradient', { angle: i * 15 }))
    nodes.push(n(`px${i}`, 'pixelate'))
    nodes.push(n(`tl${i}`, 'tile'))
    edges.push(e(`ea${i}`, `src${i}`, 'color', `px${i}`, 'source'))
    edges.push(e(`eb${i}`, `px${i}`, 'color', `tl${i}`, 'source'))
    tips.push(`tl${i}`)
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

// Splits each pass's shader text at its entry point into a preamble (uniform/
// sampler/function declarations, re-emitted in full by every relay — untouched
// by this fix) and a body (the fragment-main statements, which relay pruning
// actually controls). Bounding the TOTAL conflates the two: at 2->6 branches
// the preamble grows 6.809x (it is the next plan's lever) while the body grows
// only 3.455x under the fix. Fails loudly rather than silently treating the
// whole text as body if the marker is missing — a split that degenerates
// quietly would make the body assertion measure nothing.
const splitAtMarker = (text: string, marker: string, label: string) => {
  const idx = text.indexOf(marker)
  assert(idx !== -1, `${label}: no '${marker}' entry-point marker found — cannot split preamble from body`)
  return text.slice(idx)
}
const glslBodyChars = (plan: { passes: Array<{ fragmentShader: string }> }) =>
  plan.passes.reduce((sum, p) => sum + splitAtMarker(p.fragmentShader, 'void main', 'GLSL pass').length, 0)
// WGSL's entry point is NOT `void main` — confirmed by printing a generated
// `shaderCode`, which emits `@fragment fn fs_main(in: VertexOutput) -> ...`.
const wgslBodyChars = (plan: { passes: Array<{ shaderCode: string }> }) =>
  plan.passes.reduce((sum, p) => sum + splitAtMarker(p.shaderCode, '@fragment fn fs_main', 'WGSL pass').length, 0)

test('GLSL: total shader size grows sub-quadratically with converging branches', () => {
  const g2 = convergingGraph(2), g6 = convergingGraph(6)
  const two = compileGraph(g2.nodes, g2.edges)
  const six = compileGraph(g6.nodes, g6.edges)
  assert(two.success && six.success, 'compile failed')
  const ratio = glslChars(six) / glslChars(two)
  // 3x the branches. This is the COARSE bound: it is currently dominated by
  // the un-pruned preamble (measured 4.470x now, 7.478x before the fix — see
  // the body assertion below for what relay pruning actually controls) and a
  // later plan that prunes per-pass declarations addresses the preamble. Keep
  // this loose at <6 rather than tightening it — at <4.5 the preamble's
  // growth alone would put it within 0.7% of the fix's actual margin, too
  // thin to trust as a gate.
  assert(ratio < 6,
    `shader size grew ${ratio.toFixed(1)}x for 3x the branches — relays are still re-emitting whole bodies`)
})

test('GLSL: relay-pruned BODY size grows sub-quadratically with converging branches', () => {
  const g2 = convergingGraph(2), g6 = convergingGraph(6)
  const two = compileGraph(g2.nodes, g2.edges)
  const six = compileGraph(g6.nodes, g6.edges)
  assert(two.success && six.success, 'compile failed')
  const ratio = glslBodyChars(six) / glslBodyChars(two)
  // 3x the branches; linear growth is ~3x. This is the quantity relay pruning
  // actually controls (the preamble is out of scope for this fix — see the
  // total-size test above). Measured 3.455x now (~23% headroom under 4.5)
  // against 7.710x before the fix, so 4.5 has real margin in both directions.
  assert(ratio < 4.5,
    `body size grew ${ratio.toFixed(2)}x for 3x the branches — relays are still re-emitting whole bodies`)
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
  // Coarse bound, same reasoning as the GLSL total test above: dominated by
  // the un-pruned preamble, addressed by a later plan. Kept at <6.
  assert(ratio < 6,
    `WGSL shader size grew ${ratio.toFixed(1)}x for 3x the branches`)
})

test('WGSL: relay-pruned BODY size grows sub-quadratically with converging branches', () => {
  const g2 = convergingGraph(2), g6 = convergingGraph(6)
  const two = compileGraphIR(g2.nodes, g2.edges)
  const six = compileGraphIR(g6.nodes, g6.edges)
  assert(two !== null && six !== null, 'IR compile returned null')
  const ratio = wgslBodyChars(six!) / wgslBodyChars(two!)
  // Same reasoning as the GLSL body test above. Measured 3.455x now against
  // 7.710x before the fix — real margin under the 4.5 bound in both directions.
  assert(ratio < 4.5,
    `WGSL body size grew ${ratio.toFixed(2)}x for 3x the branches — relays are still re-emitting whole bodies`)
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
  //
  // This relies on the codegen's naming convention: per-node outputs are
  // named `node_<id>_<port>` and always declared with an initializer at their
  // point of definition (`<type> node_x = ...`). A future node-authoring
  // change that drops that convention (e.g. declares without an initializer,
  // or stops prefixing with `node_`) silently defeats this gate.
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

test('WGSL: no pass references a node_ identifier it never declares', () => {
  // Same fixture and same reasoning as the GLSL test above — multiHopConvergingGraph,
  // not convergingGraph, because a leaf-source graph can't distinguish a crippled
  // `nodesFeeding` from a correct one. Reads `shaderCode` (WGSLPassOutput's field —
  // there is no `fragmentShader` on this type).
  //
  // This relies on the codegen's naming convention too: per-node outputs are
  // named `node_<id>_<port>` and are declared with an initializer via the IR
  // `declare()` builder, which the WGSL backend always lowers to
  // `var <name>: <type> = <expr>;` (see lowerStmtToWGSL's 'declare' case in
  // ir/wgsl-backend.ts — `let` is never used for declares because IR doesn't
  // track mutability and some node_ outputs are reassigned later). A future
  // change to that convention (dropping the `node_` prefix, or declaring
  // without an initializer) silently defeats this gate.
  const { nodes, edges } = multiHopConvergingGraph(4)
  const plan = compileGraphIR(nodes, edges)
  assert(plan !== null, 'IR compile failed')

  const declRe = /\b(?:var|let)\s+(node_\w+)\s*:\s*\w+\s*=/g
  const refRe = /\bnode_\w+\b/g

  for (const p of plan!.passes) {
    const src = p.shaderCode
    const declared = new Set<string>()
    for (const m of src.matchAll(declRe)) declared.add(m[1])
    const referenced = new Set<string>()
    for (const m of src.matchAll(refRe)) referenced.add(m[0])
    const undeclared = [...referenced].filter((id) => !declared.has(id))
    assert(undeclared.length === 0,
      `WGSL pass references undeclared identifier(s): ${undeclared.join(', ')} — a relay dropped a declaration its own body still reads`)
  }
})

test('GLSL: every declared sampler is statically used in that pass\'s shader', () => {
  // Uses twoLevelConvergingGraph, not convergingGraph/multiHopConvergingGraph:
  // both of those put every relay in pass 0, which has no input samplers of
  // its own, so a relay that carries the primary's FULL samplerNames/
  // inputTextures (instead of the ones its pruned body actually needs) has
  // nothing stale to declare there. Only a relay pass that is itself fed by
  // an earlier pass's boundary can expose the bug: this fixture's pass1
  // (the pixelates) is exactly that.
  const { nodes, edges } = twoLevelConvergingGraph(2)
  const plan = compileGraph(nodes, edges)
  assert(plan.success, 'compile failed')

  const declRe = /uniform sampler2D (\w+);/g
  for (const p of plan.passes) {
    const src = p.fragmentShader
    const declared = [...src.matchAll(declRe)].map((m) => m[1])
    for (const name of declared) {
      // The declaration line itself is one occurrence — a sampler that is
      // genuinely used appears at least once more (in a texture() call).
      const uses = (src.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length
      assert(uses > 1,
        `pass ${p.index} declares sampler '${name}' but never uses it in the body — a relay carried a stale declaration its pruned body doesn't read`)
    }
  }
})

test('WGSL: every declared texture binding is statically used in that pass\'s shader', () => {
  // Same fixture and reasoning as the GLSL test above. WGSL declares a
  // texture/sampler pair per boundary as `var <name>_tex: texture_2d<f32>;`
  // / `var <name>_samp: sampler;` (wgsl-assembler.ts) — checking `<name>_tex`
  // is enough to catch a stale binding, since the pair is always added and
  // used together.
  const { nodes, edges } = twoLevelConvergingGraph(2)
  const plan = compileGraphIR(nodes, edges)
  assert(plan !== null, 'IR compile failed')

  const declRe = /var (\w+_tex): texture_2d<f32>;/g
  for (const p of plan!.passes) {
    const src = p.shaderCode
    const declared = [...src.matchAll(declRe)].map((m) => m[1])
    for (const name of declared) {
      const uses = (src.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length
      assert(uses > 1,
        `pass declares texture binding '${name}' but never uses it in the body — a relay carried a stale declaration its pruned body doesn't read`)
    }
  }
})

run('relay-pruning')
