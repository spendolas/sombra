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
 *                composite and its own source; N+1 texture slots (the
 *                liveness column of spec §4, measured, not hand-built).
 *   blur layer   a multi-pass blur as one layer: every pass ≤ 2 textures, the
 *                blur keeps its own reduced-resolution sub-pass, the top
 *                composite reads the blur's LAST sub-pass.
 *   shared src   one source feeding two layers is rendered ONCE.
 *   nested       a Stack as a layer of a Stack: the outer chain reads the
 *                inner chain's last composite.
 *   full-res pin a Gaussian or pyramid blur as a layer beside a plain layer.
 *                KNOWN (spec §10): Stack's bottom composite lands in the
 *                blur's first depth group and pins that half-size pass to
 *                full size.
 *                Pinned here as a tripwire — see the test for what to do when
 *                it goes red.
 *
 * Run: npm run verify:stack-convergence
 */
import { initializeNodeLibrary } from '../src/nodes'
import { compileGraph } from '../src/compiler/glsl-generator'
import { compileGraphIR, toPlanWgsl } from '../src/compiler/ir-compiler'
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

for (const N of [2, 4, 8]) {
  test(`${N} layers: 2N passes, a strict chain, N+1 slots, both backends identical`, () => {
    const g = new G().node('stk', 'stack', { layers: Array.from({ length: N }, (_, i) => L(`a${i}`, i % 2 ? 'screen' : 'multiply')) })
      .node('out', 'fragment_output').wire('stk', 'color', 'out', 'color')
    for (let i = 0; i < N; i++) g.node(`s${i}`, i % 2 ? 'gradient' : 'checkerboard').wire(`s${i}`, 'color', 'stk', `layer_a${i}`)
    const p = plans(g)
    assert(p.passes.length === 2 * N, `${p.passes.length} passes, expected ${2 * N}`)
    // Sources occupy passes 0..N-1 (depth 0, primary + relays) and read nothing.
    for (let i = 0; i < N; i++) assert(p.passes[i].reads.length === 0, `source pass ${i} reads ${JSON.stringify(p.passes[i].reads)}`)
    // Composite k (pass N+k) reads its own source and, for k > 0, composite k-1.
    for (let k = 0; k < N; k++) {
      const want = k === 0 ? [0] : [k, N + k - 1].sort((x, y) => x - y)
      assert(JSON.stringify(p.passes[N + k].reads) === JSON.stringify(want),
        `composite ${k} (pass ${N + k}) reads ${JSON.stringify(p.passes[N + k].reads)}, expected ${JSON.stringify(want)}`)
    }
    assert(p.slotCount === N + 1, `slotCount ${p.slotCount}, expected N+1 = ${N + 1} (spec §4 liveness column)`)
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
  const innerTop = p.passes.findIndex((x, i) => i > 0 && x.reads.length === 2) // inner composite 1
  assert(innerTop > 0, 'no inner top composite found')
  const outerBottom = p.passes.findIndex((x) => x.reads.length === 1 && x.reads[0] === innerTop)
  assert(outerBottom > innerTop, `the outer chain's bottom composite does not read the inner chain's top (pass ${innerTop}): ${JSON.stringify(p.passes.map((x) => x.reads))}`)
  assert(p.passes[6].reads.includes(outerBottom), 'the outer top composite does not read the outer bottom composite')
  assert(p.slotCount === 4, `slotCount ${p.slotCount}, expected 4`)
})

test('full-res pin (KNOWN, spec §10): a Stack beside a Gaussian blur pins the blur\'s first half-size pass', () => {
  const alone = plans(new G().node('cb', 'checkerboard').node('bl', 'blur', { radius: 16 }).node('out', 'fragment_output')
    .wire('cb', 'color', 'bl', 'source').wire('bl', 'color', 'out', 'color'))
  assert(alone.passes[1].resolution === 0.5, `fixture assumption broken: blur sub-pass 0 is ${alone.passes[1].resolution}, expected 0.5`)
  const p = plans(new G().node('stk', 'stack', { layers: [L('a'), L('b', 'screen')] }).node('out', 'fragment_output')
    .node('gr', 'gradient').node('cb', 'checkerboard').node('bl', 'blur', { radius: 16 })
    .wire('gr', 'color', 'stk', 'layer_a').wire('cb', 'color', 'bl', 'source').wire('bl', 'color', 'stk', 'layer_b').wire('stk', 'color', 'out', 'color'))
  // Blur sub-pass 0 shares depth 1 with Stack's bottom composite; the group's
  // primary (reading both sources) is the blur's first pass, at full size.
  const shared = p.passes.findIndex((x) => JSON.stringify(x.reads) === '[0,1]')
  assert(shared >= 0, `fixture changed shape: no depth-1 pass reads both sources: ${JSON.stringify(p.passes)}`)
  // TRIPWIRE — asserts the BROKEN behaviour. When this goes red, the pin is
  // fixed for this shape: flip it to assert 0.5. Never delete it to go green.
  assert(p.passes[shared].resolution === undefined,
    'blur sub-pass 0 beside a Stack composite now keeps its half size — the anyFullRes pin appears FIXED; flip this test to assert 0.5')
})

test('full-res pin (KNOWN, spec §10): a Stack beside a pyramid blur pins the pyramid\'s first downsample', () => {
  // The pyramid alone: its first sub-pass renders at half size.
  const alone = plans(new G().node('cb', 'checkerboard').node('py', 'pyramid_blur', { radius: 64 }).node('out', 'fragment_output')
    .wire('cb', 'color', 'py', 'source').wire('py', 'color', 'out', 'color'))
  assert(alone.passes[1].resolution === 0.5, `fixture assumption broken: the pyramid's first sub-pass is ${alone.passes[1].resolution}, expected 0.5`)
  // The same pyramid as a Stack layer beside a gradient layer. Stack's bottom
  // composite (reads only the gradient) sits at the pyramid's first depth, so
  // both land in one depth group, and the composite — which declares no
  // resolution — pins the group to full size.
  const g = new G().node('stk', 'stack', { layers: [L('a'), L('b', 'screen')] }).node('out', 'fragment_output')
    .node('gr', 'gradient').node('cb', 'checkerboard').node('py', 'pyramid_blur', { radius: 64 })
    .wire('gr', 'color', 'stk', 'layer_a').wire('cb', 'color', 'py', 'source').wire('py', 'color', 'stk', 'layer_b').wire('stk', 'color', 'out', 'color')
  const p = plans(g)
  const downsample = p.passes.findIndex((x) => x.reads.length === 2 && x.resolution === undefined && p.passes.some((y) => y.resolution === 0.25 && y.reads.includes(p.passes.indexOf(x))))
  // TRIPWIRE. This asserts the BROKEN behaviour so that fixing it is noticed:
  // when the pyramid's first downsample keeps its 0.5 here, this goes red —
  // flip it to assert 0.5 and drop the pin. Never delete it to go green.
  assert(downsample >= 0,
    'the pyramid\'s first downsample is no longer pinned to full resolution beside a Stack — the anyFullRes pin appears FIXED for this shape; '
    + `flip this test to assert its 0.5. Plan: ${JSON.stringify(p.passes)}`)
  assert(!p.passes.some((x) => x.resolution === 0.5 && x.reads.length === 1 && x.reads[0] === 1),
    'fixture changed shape: a half-size downsample exists after all')
})

await run('stack-convergence')
