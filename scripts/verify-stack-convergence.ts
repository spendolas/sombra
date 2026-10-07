/**
 * Convergence, relays and the full-resolution pin, on COMPILER-PRODUCED plans.
 *
 * verify-pass-resolution.ts covers one linear chain. Stack is the first node
 * that makes graphs CONVERGE routinely: N independent layer sources meet in a
 * chain of composites, and every depth group with more than one output splits
 * into a primary pass plus relays. Nothing tested that shape, nor the
 * `anyFullRes` rule in pass-resolution.ts, under which any node that declares
 * no resolution pins its whole depth group to full size.
 *
 * Every number below is read off the plans the real compilers produced, on
 * BOTH backends (glsl-generator's RenderPlan and ir-compiler's WGSL plan), and
 * the two plans must agree pass for pass — reads, resolution, slot count.
 *
 *   N layers     2, 4, 8: 2N passes; each composite reads exactly the previous
 *                composite and its own source; 2 / 3 / 3 texture slots under
 *                consumer-ordered emission (was N+1 before pass-order.ts).
 *   blur layer   a multi-pass blur as one layer: every pass ≤ 2 textures, the
 *                blur keeps its own reduced-resolution sub-pass, the top
 *                composite reads the blur's LAST sub-pass.
 *   shared src   one source feeding two layers is rendered ONCE.
 *   nested       a Stack as a layer of a Stack: the outer chain reads the
 *                inner chain's last composite.
 *   full-res pin a Gaussian or pyramid blur as a layer beside a plain layer
 *                keeps every sub-pass at its declared scale. Spec §10's
 *                hazard: Stack's bottom composite lands in the blur's first
 *                depth group, which used to pin that half-size pass to full
 *                size; scales now resolve per emitted pass.
 *
 * Run: npm run verify:stack-convergence
 */
import { initializeNodeLibrary } from '../src/nodes'
import { compileGraph } from '../src/compiler/glsl-generator'
import { compileGraphIR, toPlanWgsl } from '../src/compiler/ir-compiler'
import { compileNodePreview } from '../src/compiler/subgraph-compiler'
import { compileNodePreviewIR } from '../src/compiler/ir-subgraph-compiler'
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import type { Node, Edge } from '@xyflow/react'

initializeNodeLibrary()

interface Pass { reads: number[]; resolution: number | undefined }
interface Plan { passes: Pass[]; slotCount: number }

class G {
  nodes: Node[] = []
  edges: Edge[] = []
  node(id: string, type: string, params: Record<string, unknown> = {}) {
    this.nodes.push({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params } } as unknown as Node)
    return this
  }
  wire(s: string, sh: string, t: string, th: string) {
    this.edges.push({ id: `e${this.edges.length}`, source: s, sourceHandle: sh, target: t, targetHandle: th } as unknown as Edge)
    return this
  }
}
const L = (id: string, blendMode = 'normal') => ({ id, name: id, blendMode, visible: true })

/** Both backends' plans, asserted identical, as one normalised plan. */
function plans(g: G): Plan {
  const gl = compileGraph(g.nodes as never, g.edges as never)
  assert(gl.success, `GLSL compile failed: ${JSON.stringify(gl.errors)}`)
  const ir = compileGraphIR(g.nodes as never, g.edges as never)
  assert(ir !== null, 'IR compile returned null')
  const w = toPlanWgsl(ir!)
  const a: Plan = {
    passes: gl.passes.map((p) => ({ reads: Object.values(p.inputTextures ?? {}).sort((x, y) => x - y), resolution: p.resolution })),
    slotCount: gl.slotCount ?? -1,
  }
  const b: Plan = {
    passes: w.passes.map((p) => ({ reads: p.inputTextures.map((t) => t.passIndex).sort((x, y) => x - y), resolution: p.resolution })),
    slotCount: w.slotCount ?? -1,
  }
  assert(JSON.stringify(a) === JSON.stringify(b),
    `backends disagree on the plan:\n      GLSL ${JSON.stringify(a)}\n      WGSL ${JSON.stringify(b)}`)
  for (const [i, p] of a.passes.entries()) {
    assert(p.reads.length <= 2, `pass ${i} binds ${p.reads.length} textures ${JSON.stringify(p.reads)} — the chain must bind at most 2`)
  }
  return a
}

/**
 * Slots the compiler must reach for an N-layer Stack. Consumer-ordered pass
 * emission (pass-order.ts, f22c340) puts each layer's source immediately
 * before the composite that reads it, so liveness keeps three textures alive
 * at any depth: running result, next source, next result. Two at N = 2. This
 * read N+1 before that ordering landed — spec §4's "+ liveness" column; the
 * number moved because the pass ORDER changed, not the allocator.
 */
const expectedSlots = (N: number) => (N <= 2 ? 2 : 3)

for (const N of [2, 4, 8]) {
  test(`${N} layers: 2N passes, a strict chain, ${expectedSlots(N)} slots, both backends identical`, () => {
    const g = new G().node('stk', 'stack', { layers: Array.from({ length: N }, (_, i) => L(`a${i}`, i % 2 ? 'screen' : 'multiply')) })
      .node('out', 'fragment_output').wire('stk', 'color', 'out', 'color')
    for (let i = 0; i < N; i++) g.node(`s${i}`, i % 2 ? 'gradient' : 'checkerboard').wire(`s${i}`, 'color', 'stk', `layer_a${i}`)
    const p = plans(g)
    assert(p.passes.length === 2 * N, `${p.passes.length} passes, expected ${2 * N}`)
    // Order-independent: N sources read nothing; N composites form one chain.
    // Walk it from the last pass (the output) down to the bottom composite.
    const sources = p.passes.map((x, i) => (x.reads.length === 0 ? i : -1)).filter((i) => i >= 0)
    assert(sources.length === N, `${sources.length} source passes, expected ${N}`)
    const seenSources = new Set<number>()
    let cur = p.passes.length - 1
    for (let k = N - 1; k >= 0; k--) {
      const reads = p.passes[cur].reads
      const src = reads.filter((r) => sources.includes(r))
      const prev = reads.filter((r) => !sources.includes(r))
      assert(src.length === 1, `composite ${k} (pass ${cur}) reads ${JSON.stringify(reads)} — expected exactly one source`)
      assert(!seenSources.has(src[0]), `source pass ${src[0]} is composited twice`)
      seenSources.add(src[0])
      if (k === 0) {
        assert(prev.length === 0, `the bottom composite (pass ${cur}) reads a backdrop ${JSON.stringify(prev)}`)
      } else {
        assert(prev.length === 1 && prev[0] < cur, `composite ${k} (pass ${cur}) reads ${JSON.stringify(reads)} — expected its source and the previous composite`)
        cur = prev[0]
      }
    }
    assert(seenSources.size === N, `${seenSources.size} sources reached the chain, expected ${N}`)
    assert(p.slotCount === expectedSlots(N), `slotCount ${p.slotCount}, expected ${expectedSlots(N)} (consumer-ordered emission)`)
    assert(p.passes.every((x) => x.resolution === undefined), 'a plain Stack must render every pass at full resolution')
  })
}

test('a multi-pass blur as a layer: ≤2 textures per pass, the blur keeps its scale, the top composite reads its last sub-pass', () => {
  const g = new G().node('stk', 'stack', { layers: [L('a'), L('b', 'screen')] }).node('out', 'fragment_output')
    .node('gr', 'gradient').node('cb', 'checkerboard').node('bl', 'blur', { radius: 16 })
    .wire('gr', 'color', 'stk', 'layer_a').wire('cb', 'color', 'bl', 'source').wire('bl', 'color', 'stk', 'layer_b').wire('stk', 'color', 'out', 'color')
  const p = plans(g)
  const last = p.passes.length - 1
  // The top composite reads exactly two textures: the bottom composite and the
  // blur's FINAL sub-pass, which keeps the blur's own half-size scale (it is
  // alone in its depth group, so nothing pins it).
  assert(p.passes[last].reads.length === 2, `top composite reads ${p.passes[last].reads.length} textures`)
  const blurLast = p.passes[last].reads.find((i) => p.passes[i].resolution === 0.5)
  assert(blurLast !== undefined,
    `the top composite reads ${JSON.stringify(p.passes[last].reads.map((i) => ({ pass: i, res: p.passes[i].resolution })))} — none is the blur's half-size final sub-pass`)
  assert(p.passes[blurLast!].reads.length === 1, 'the blur\'s final sub-pass should read only its own first sub-pass')
})

test('one source feeding two layers is rendered once', () => {
  const g = new G().node('stk', 'stack', { layers: [L('a'), L('b', 'difference')] }).node('out', 'fragment_output').node('gr', 'gradient')
    .wire('gr', 'color', 'stk', 'layer_a').wire('gr', 'color', 'stk', 'layer_b').wire('stk', 'color', 'out', 'color')
  const p = plans(g)
  assert(p.passes.length === 3, `${p.passes.length} passes, expected 3 (one source, two composites)`)
  assert(JSON.stringify(p.passes[1].reads) === '[0]' && JSON.stringify(p.passes[2].reads) === '[0,1]',
    `both composites must read the single source pass 0: ${JSON.stringify(p.passes.map((x) => x.reads))}`)
})

test('a Stack nested in a Stack: the outer chain reads the inner chain\'s last composite', () => {
  const g = new G().node('inner', 'stack', { layers: [L('a'), L('b', 'multiply')] }).node('outer', 'stack', { layers: [L('x'), L('y', 'screen')] })
    .node('out', 'fragment_output').node('gr', 'gradient').node('cb', 'checkerboard').node('dt', 'dots')
    .wire('gr', 'color', 'inner', 'layer_a').wire('cb', 'color', 'inner', 'layer_b')
    .wire('inner', 'color', 'outer', 'layer_x').wire('dt', 'color', 'outer', 'layer_y').wire('outer', 'color', 'out', 'color')
  const p = plans(g)
  // 3 sources, 2 inner composites, 2 outer composites.
  assert(p.passes.length === 7, `${p.passes.length} passes, expected 7`)
  const last = p.passes.length - 1
  // Outer top reads the outer bottom composite and the dots source.
  const outerBottom = p.passes[last].reads.find((r) => p.passes[r].reads.length > 0)
  assert(outerBottom !== undefined, `the outer top composite reads no composite: ${JSON.stringify(p.passes.map((x) => x.reads))}`)
  // The outer bottom composite's only input is the inner chain's top.
  assert(p.passes[outerBottom!].reads.length === 1, `outer bottom composite reads ${JSON.stringify(p.passes[outerBottom!].reads)}`)
  const innerTop = p.passes[outerBottom!].reads[0]
  assert(p.passes[innerTop].reads.length === 2, `the outer chain's bottom reads pass ${innerTop}, which is not the inner top composite`)
  // Inner at outer position 0: consumer order needs 3 (was 4 before
  // pass-order.ts landed). Deeper positions need more — see verify-pass-order.
  assert(p.slotCount === 3, `slotCount ${p.slotCount}, expected 3`)
})

/**
 * The blur's sub-passes, first to last, in a Stack plan: start from the top
 * composite's input that carries a declared scale (the blur's last sub-pass)
 * and walk back while each pass reads exactly one texture that is not a
 * source.
 */
function blurChain(p: Plan): number[] {
  const top = p.passes[p.passes.length - 1]
  const lastSub = top.reads.find((r) => p.passes[r].resolution !== undefined)
  assert(lastSub !== undefined, `the top composite reads no scaled pass: ${JSON.stringify(p.passes)}`)
  const chain = [lastSub!]
  for (;;) {
    const reads = p.passes[chain[0]].reads
    const prev = reads.filter((r) => p.passes[r].reads.length > 0)
    if (prev.length !== 1) break
    chain.unshift(prev[0])
  }
  return chain
}

for (const [type, radius] of [['blur', 16], ['pyramid_blur', 64]] as const) {
  test(`full-res pin fixed: a ${type} layer beside another layer keeps every declared scale`, () => {
    // Spec §10's hazard, fixed: Stack's bottom composite shares the blur's
    // first depth group, but each emitted pass now resolves its scale from the
    // nodes feeding ITS output — so the composite no longer pins the blur.
    const alone = plans(new G().node('cb', 'checkerboard').node('bl', type, { radius }).node('out', 'fragment_output')
      .wire('cb', 'color', 'bl', 'source').wire('bl', 'color', 'out', 'color'))
    // Alone, the blur's sub-passes are passes 1..n-1; the last is the canvas
    // pass, forced to full size, so compare all but that one.
    const aloneScales = alone.passes.slice(1, -1).map((x) => x.resolution)
    assert(aloneScales.length > 0 && aloneScales[0] === 0.5, `fixture assumption broken: ${type} alone starts at ${aloneScales[0]}`)
    const p = plans(new G().node('stk', 'stack', { layers: [L('a'), L('b', 'screen')] }).node('out', 'fragment_output')
      .node('gr', 'gradient').node('cb', 'checkerboard').node('bl', type, { radius })
      .wire('gr', 'color', 'stk', 'layer_a').wire('cb', 'color', 'bl', 'source').wire('bl', 'color', 'stk', 'layer_b').wire('stk', 'color', 'out', 'color'))
    const chain = blurChain(p)
    const scales = chain.map((i) => p.passes[i].resolution)
    assert(JSON.stringify(scales.slice(0, aloneScales.length)) === JSON.stringify(aloneScales),
      `${type} beside a Stack composite renders its sub-passes at ${JSON.stringify(scales)}, alone at ${JSON.stringify(aloneScales)} — a scale was pinned`)
    // The bottom composite (the top composite's other input) stays full size.
    const top = p.passes[p.passes.length - 1]
    const bottom = top.reads.find((r) => !chain.includes(r))
    assert(bottom !== undefined && p.passes[bottom].resolution === undefined,
      `the Stack's bottom composite was downscaled: ${JSON.stringify(bottom !== undefined ? p.passes[bottom] : top)}`)
  })
}

test('preview compilers resolve the same per-pass scales as the main compilers', () => {
  // The node thumbnails compile through their own two compilers; a fix in the
  // main pair alone would leave a Stack's thumbnail pinning its blur layer.
  const g = new G().node('stk', 'stack', { layers: [L('a'), L('b', 'screen')] }).node('out', 'fragment_output')
    .node('gr', 'gradient').node('cb', 'checkerboard').node('bl', 'blur', { radius: 16 })
    .wire('gr', 'color', 'stk', 'layer_a').wire('cb', 'color', 'bl', 'source').wire('bl', 'color', 'stk', 'layer_b').wire('stk', 'color', 'out', 'color')
  const main = plans(g)
  const pv = compileNodePreview(g.nodes as never, g.edges as never, 'stk')
  assert(pv.success && !pv.depthExceeded, `GLSL preview failed: ${JSON.stringify(pv.errors)}`)
  const pvIr = compileNodePreviewIR(g.nodes as never, g.edges as never, 'stk')
  assert(pvIr.success && !pvIr.depthExceeded, `IR preview failed: ${JSON.stringify(pvIr.errors)}`)
  const asPlan = (passes: Array<{ reads: number[]; resolution: number | undefined }>): Plan => ({ passes, slotCount: -1 })
  const a = asPlan(pv.passes.map((x) => ({ reads: Object.values(x.inputTextures).sort((m, n) => m - n), resolution: x.resolution })))
  const b = asPlan(pvIr.wgslPasses.map((x) => ({ reads: x.inputTextures.map((t) => t.passIndex).sort((m, n) => m - n), resolution: x.resolution })))
  const scales = (p: Plan) => blurChain(p).map((i) => p.passes[i].resolution)
  const want = scales(main)
  assert(want[0] === 0.5, `fixture assumption broken: main plan blur chain ${JSON.stringify(want)}`)
  assert(JSON.stringify(scales(a)) === JSON.stringify(want), `GLSL preview renders the blur at ${JSON.stringify(scales(a))}, main at ${JSON.stringify(want)}`)
  assert(JSON.stringify(scales(b)) === JSON.stringify(want), `IR preview renders the blur at ${JSON.stringify(scales(b))}, main at ${JSON.stringify(want)}`)
})

await run('stack-convergence')
