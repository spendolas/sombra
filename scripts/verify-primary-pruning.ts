/**
 * Do PRIMARY passes carry only the code their own output needs?
 *
 * partitionPasses groups nodes by depth. When several outputs share a depth,
 * the compiler emits one primary pass plus one relay per extra output. Relays
 * were already pruned to the nodes feeding their own output
 * (verify-relay-pruning.ts); primaries used to emit the WHOLE depth group and
 * keep only their own fragColor — correct output, wasted fragment work.
 *
 * The motivating case (Stack, 2026-10-07): a multi-pass blur used as a Stack
 * layer shares a depth with the Stack's bottom composite, so the blur's
 * half-size primary also ran the bottom composite and threw it away. The
 * commonest corpus case is smaller: a Time or constant node sits at depth 0
 * beside a texture source but only feeds a LATER pass (where it is re-emitted
 * anyway), so the depth-0 primary computed it for nothing.
 *
 * Mechanism-engaged on purpose: each case asserts the OTHER output's code is
 * absent from the primary's shader text AND still present in the pass that
 * needs it — absence alone passes if the code is deleted everywhere. Pixel
 * identity is not asserted here (no GPU); the resource checks below assert the
 * declarations track the pruned body, the failure mode that made relay pruning
 * render silent black on WebGPU (e5a7613).
 *
 * Run: npm run verify:primary-pruning
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Node, Edge } from '@xyflow/react'
import { initializeNodeLibrary } from '../src/nodes'
import { compileGraph, type RenderPlan } from '../src/compiler/glsl-generator'
import { compileGraphIR, type WGSLMultiPassOutput } from '../src/compiler/ir-compiler'
import { decodeSombraPackage, importFromFile } from '../src/utils/sombra-file'
import { test, run, assert } from './blur-bakeoff/lib/test-util'

initializeNodeLibrary()

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const n = (id: string, t: string, p: Record<string, unknown> = {}) =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: t, params: p } }) as unknown as Node
const e = (id: string, s: string, sh: string, tg: string, th: string) =>
  ({ id, source: s, sourceHandle: sh, target: tg, targetHandle: th }) as unknown as Edge

interface Graph { nodes: Node[]; edges: Edge[] }

/**
 * A 2-layer Stack whose top layer is a multi-pass blur. Depth 0: the two
 * sources. Depth 1: the blur's first sub-pass AND the Stack's bottom composite
 * (which reads only the checkerboard) — the shared depth that made the blur's
 * half-size primary run the composite.
 */
const stackBlur = (): Graph => ({
  nodes: [
    n('stk', 'stack', { layers: [
      { id: 'l0', name: 'Layer 1', blendMode: 'normal', visible: true },
      { id: 'l1', name: 'Layer 2', blendMode: 'screen', visible: true },
    ] }),
    n('chk', 'checkerboard'), n('grd', 'gradient'), n('blr', 'blur'), n('out', 'fragment_output'),
  ],
  edges: [
    e('e0', 'chk', 'color', 'stk', 'layer_l0'),
    e('e1', 'grd', 'color', 'blr', 'source'),
    e('e2', 'blr', 'color', 'stk', 'layer_l1'),
    e('e3', 'stk', 'color', 'out', 'color'),
  ],
})

/**
 * gradient → pixelate.source (a texture boundary), and time → pixelate's
 * pixel size (a plain wire). Time has no inputs, so it sits at depth 0 beside
 * the gradient, but it only feeds pass 1, where it is re-emitted.
 */
const deadNeighbour = (): Graph => ({
  nodes: [n('grd', 'gradient'), n('tim', 'time'), n('px', 'pixelate'), n('out', 'fragment_output')],
  edges: [
    e('e0', 'grd', 'color', 'px', 'source'),
    e('e1', 'tim', 'time', 'px', 'pixelSize'),
    e('e2', 'px', 'color', 'out', 'color'),
  ],
})

// The two backends name the shader text differently (RenderPass.fragmentShader
// vs WGSLPassOutput.shaderCode) — one accessor each, named for the backend.
type GlslPass = RenderPlan['passes'][number]
type WgslPass = WGSLMultiPassOutput['passes'][number]
const glslBody = (p: GlslPass) => p.fragmentShader.slice(p.fragmentShader.indexOf('void main'))
const wgslBody = (p: WgslPass) => p.shaderCode.slice(p.shaderCode.indexOf('@fragment fn fs_main'))
const glslInputs = (p: GlslPass) => Object.keys(p.inputTextures).length
const wgslInputs = (p: WgslPass) => p.inputTextures.length

/**
 * Does this shader body carry node `id`'s code? Per-node outputs are
 * `node_<id>_<port>`; a multi-pass node's later sub-passes are virtual nodes
 * `<id>_sp<k>`, which must not count as `id` itself.
 */
const carries = (body: string, id: string) => new RegExp(`\\bnode_${id}_(?!sp\\d)`).test(body)

function compileBoth(g: Graph, label: string) {
  const plan = compileGraph(g.nodes as never, g.edges as never)
  assert(plan.success, `${label}: GLSL compile failed: ${JSON.stringify(plan.errors)}`)
  const ir = compileGraphIR(g.nodes as never, g.edges as never)
  assert(ir !== null, `${label}: IR compile returned null`)
  assert(ir!.passes.length === plan.passes.length,
    `${label}: backends disagree on pass count (${plan.passes.length} vs ${ir!.passes.length})`)
  return {
    glsl: plan.passes.map((p) => ({ body: glslBody(p), inputs: glslInputs(p), resolution: p.resolution })),
    wgsl: ir!.passes.map((p) => ({ body: wgslBody(p), inputs: wgslInputs(p), resolution: p.resolution })),
  }
}

for (const backend of ['glsl', 'wgsl'] as const) {
  test(`${backend}: a blurred Stack layer's half-size pass does not run the bottom composite`, () => {
    const passes = compileBoth(stackBlur(), 'stack-blur')[backend]
    // The blur's FIRST sub-pass is `blr`; its second is the virtual `blr_sp1`.
    const blurPass = passes.filter((p) => carries(p.body, 'blr'))
    assert(blurPass.length === 1, `expected one pass carrying the blur's first sub-pass, got ${blurPass.length}`)
    const [bp] = blurPass
    assert(bp.resolution === 0.5,
      `the blur's first sub-pass renders at ${bp.resolution}, expected its declared 0.5 — the fixture no longer has the motivating shape`)
    assert(!carries(bp.body, 'stk'),
      'the blur\'s half-size primary still contains the Stack bottom composite\'s code — primaries are not pruned')
    assert(bp.inputs === 1,
      `the blur's primary binds ${bp.inputs} textures; it reads only its source, so it must bind 1 — its declarations did not follow the pruned body`)
    // Mechanism: the composite was moved out, not lost.
    const compositePasses = passes.filter((p) => carries(p.body, 'stk'))
    assert(compositePasses.length === 1,
      `the bottom composite should live in exactly one pass, found ${compositePasses.length}`)
    // The depth-0 pair: the checkerboard's pass must not carry the gradient, and vice versa.
    for (const [mine, other] of [['chk', 'grd'], ['grd', 'chk']]) {
      const own = passes.filter((p) => carries(p.body, mine) && !carries(p.body, 'blr'))
      assert(own.length >= 1, `no pass carries ${mine}`)
      for (const p of own) assert(!carries(p.body, other), `the ${mine} pass also carries ${other}'s code`)
    }
  })

  test(`${backend}: a depth-0 primary does not compute a neighbour that only feeds a later pass`, () => {
    const passes = compileBoth(deadNeighbour(), 'dead-neighbour')[backend]
    assert(passes.length === 2, `expected 2 passes, got ${passes.length} — the fixture no longer has a texture boundary`)
    const [first, last] = passes
    assert(carries(first.body, 'grd'), 'the first pass no longer computes the gradient — the fixture shape moved')
    assert(!carries(first.body, 'tim'),
      'the depth-0 primary still computes Time, whose only reader is in the next pass — primaries are not pruned')
    // Mechanism: Time is still computed where it is read.
    assert(carries(last.body, 'tim'), 'Time vanished from the pass that reads it — pruned too far')
  })
}

// ---------------------------------------------------------------------------
// Declarations track the pruned body — fixtures AND the real corpus
// ---------------------------------------------------------------------------

function corpus(): Array<{ label: string; g: Graph }> {
  const dir = path.join(ROOT, 'shaders')
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.sombra') || f.endsWith('.json')).sort()
    : []
  if (files.length === 0) {
    // shaders/ is gitignored and never reaches a worktree or CI.
    console.warn('  WARN: shaders/ is empty or absent — the corpus checks ran on fixtures only. ' +
      'Copy it from the main checkout to run them.')
  }
  return files.map((f) => {
    const payload = decodeSombraPackage(new Uint8Array(fs.readFileSync(path.join(dir, f))))
    const { nodes, edges } = importFromFile(payload)
    return { label: `corpus:${f}`, g: { nodes: nodes as unknown as Node[], edges: edges as unknown as Edge[] } }
  })
}

const graphs = [
  { label: 'stack-blur', g: stackBlur() },
  { label: 'dead-neighbour', g: deadNeighbour() },
  ...corpus(),
]

test('GLSL: every pass declares exactly the samplers it uses, and every node_ it reads', () => {
  const declRe = /uniform sampler2D (\w+);/g
  // With or without an initializer: reeded_glass declares `vec4 node_x;` and
  // assigns it in branches.
  const nodeDeclRe = /\b(?:vec2|vec3|vec4|float|int|bool|mat2|mat3|mat4)\s+(node_\w+)\s*[=;]/g
  for (const { label, g } of graphs) {
    const plan = compileGraph(g.nodes as never, g.edges as never)
    assert(plan.success, `${label}: compile failed`)
    for (const p of plan.passes) {
      const src = p.fragmentShader
      const declared = [...src.matchAll(declRe)].map((m) => m[1])
      for (const name of declared) {
        const uses = (src.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length
        assert(uses > 1, `${label} pass ${p.index}: declares sampler '${name}' but never uses it`)
      }
      // Boundary samplers the pass binds must be the ones it declares.
      for (const name of Object.keys(p.inputTextures)) {
        assert(declared.includes(name), `${label} pass ${p.index}: binds '${name}' but does not declare it`)
      }
      const nodeDecl = new Set([...src.matchAll(nodeDeclRe)].map((m) => m[1]))
      const undeclared = [...new Set([...src.matchAll(/\bnode_\w+\b/g)].map((m) => m[0]))].filter((id) => !nodeDecl.has(id))
      assert(undeclared.length === 0, `${label} pass ${p.index}: reads undeclared ${undeclared.join(', ')}`)
    }
  }
})

test('WGSL: every pass declares exactly the textures it uses, and every node_ it reads', () => {
  const declRe = /var (\w+)_tex: texture_2d<f32>;/g
  const nodeDeclRe = /\b(?:var|let)\s+(node_\w+)\s*:\s*[\w<>]+\s*[=;]/g
  for (const { label, g } of graphs) {
    const ir = compileGraphIR(g.nodes as never, g.edges as never)
    assert(ir !== null, `${label}: IR compile returned null`)
    ir!.passes.forEach((p, i) => {
      const src = p.shaderCode
      const declared = [...src.matchAll(declRe)].map((m) => m[1])
      for (const name of declared) {
        const uses = (src.match(new RegExp(`\\b${name}_tex\\b`, 'g')) ?? []).length
        assert(uses > 1, `${label} pass ${i}: declares texture '${name}_tex' but never uses it`)
      }
      for (const t of p.inputTextures) {
        assert(declared.includes(t.samplerName), `${label} pass ${i}: binds '${t.samplerName}' but does not declare it`)
      }
      const nodeDecl = new Set([...src.matchAll(nodeDeclRe)].map((m) => m[1]))
      const undeclared = [...new Set([...src.matchAll(/\bnode_\w+\b/g)].map((m) => m[0]))].filter((id) => !nodeDecl.has(id))
      assert(undeclared.length === 0, `${label} pass ${i}: reads undeclared ${undeclared.join(', ')}`)
    })
  }
})

run('primary-pruning')
