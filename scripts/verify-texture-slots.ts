/**
 * Does slot assignment reuse textures without ever aliasing a live one?
 *
 * Asserts BOTH properties, because each alone is satisfied by a wrong answer:
 * "no overlap" is satisfied by giving every pass its own slot (today's
 * behaviour, zero saving), and "few slots" is satisfied by reusing immediately
 * (the 21d4477 bug, wrong pixels).
 *
 * Run: npx tsx scripts/verify-texture-slots.ts
 */
import { assignTextureSlots, type PassLiveness } from '../src/compiler/texture-slots'
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import { initializeNodeLibrary } from '../src/nodes'
import { compileGraph } from '../src/compiler/glsl-generator'
import { compileGraphIR } from '../src/compiler/ir-compiler'
import type { Node, Edge } from '@xyflow/react'

initializeNodeLibrary()

const chain = (n: number): PassLiveness[] =>
  Array.from({ length: n }, (_, i) => ({
    index: i, readsPassIndices: i === 0 ? [] : [i - 1], sizeKey: 'full',
  }))

/** Independent branches that all converge on the final pass — the Stack shape. */
const converge = (branches: number): PassLiveness[] => {
  const passes: PassLiveness[] = []
  for (let i = 0; i < branches; i++) passes.push({ index: i, readsPassIndices: [], sizeKey: 'full' })
  passes.push({ index: branches, readsPassIndices: passes.map((p) => p.index), sizeKey: 'full' })
  return passes
}

/** The 21d4477 shape: a late pass reads a NON-ADJACENT earlier one. */
const nonAdjacent = (): PassLiveness[] => [
  { index: 0, readsPassIndices: [], sizeKey: 'full' },
  { index: 1, readsPassIndices: [0], sizeKey: 'full' },
  { index: 2, readsPassIndices: [1], sizeKey: 'full' },
  { index: 3, readsPassIndices: [0, 2], sizeKey: 'full' },  // reaches back to pass 0
]

/** No slot may be overwritten while a later pass still needs its contents. */
function assertNoAliasing(passes: PassLiveness[], slotOfPass: number[]) {
  const lastReader = new Array<number>(passes.length).fill(-1)
  for (const p of passes) for (const s of p.readsPassIndices) {
    lastReader[s] = Math.max(lastReader[s], p.index)
  }
  for (const writer of passes) {
    const slot = slotOfPass[writer.index]
    if (slot === -1) continue
    for (const other of passes) {
      if (other.index >= writer.index) continue
      if (slotOfPass[other.index] !== slot) continue
      assert(lastReader[other.index] < writer.index,
        `pass ${writer.index} overwrites slot ${slot} while pass ${other.index}'s output is still read by pass ${lastReader[other.index]}`)
    }
  }
}

test('a linear chain needs far fewer slots than passes', () => {
  const passes = chain(8)
  const { slotOfPass, slotCount } = assignTextureSlots(passes)
  assertNoAliasing(passes, slotOfPass)
  assert(slotCount <= 2, `a linear chain should need at most 2 slots, got ${slotCount}`)
})

// NOTE: `converge()` models N branches read by ONE pass — the architecture spec §4
// REJECTED. It is kept only to prove the analysis is correct on that shape; it is not the
// Stack. The Stack's real shape is N sources at one depth plus a sequential chain, which
// this plan's companion measures on compiler-produced plans rather than hand-built lists.
test('converging branches keep every source alive until the merge', () => {
  const passes = converge(5)
  const { slotOfPass, slotCount } = assignTextureSlots(passes)
  assertNoAliasing(passes, slotOfPass)
  assert(slotCount === 5, `all 5 branches are read by the final pass, so all 5 must stay alive; got ${slotCount}`)
})

test('a non-adjacent read does not alias — the 21d4477 case', () => {
  const passes = nonAdjacent()
  const { slotOfPass } = assignTextureSlots(passes)
  assertNoAliasing(passes, slotOfPass)
  assert(slotOfPass[0] !== slotOfPass[1],
    'pass 0 is still read by pass 3, so pass 1 must not reuse its slot')
})

// The brief's original 3-pass mixed-size fixture is vacuous: pass 2 is read by
// nothing, so it gets slot -1 and the assertion about it never engages the
// sizeKey check (perturbation 3 confirmed identical output with and without
// the check). A 4th pass is required so a free slot exists at an allocation
// point that IS taken: pass 2 frees the half-size slot 0, and — with the
// sizeKey check removed — slot 0 is the only free slot, so pass 2 (which is
// full-size) would wrongly be handed it. With the check intact, pass 2 must
// open a new full-size slot instead.
test('passes of different sizes never share a slot', () => {
  const passes: PassLiveness[] = [
    { index: 0, readsPassIndices: [], sizeKey: 'half' },
    { index: 1, readsPassIndices: [0], sizeKey: 'full' },
    { index: 2, readsPassIndices: [1], sizeKey: 'full' },
    { index: 3, readsPassIndices: [2], sizeKey: 'full' },
  ]
  const { slotOfPass } = assignTextureSlots(passes)
  assertNoAliasing(passes, slotOfPass)
  const half = slotOfPass[0]
  assert(slotOfPass[2] !== half,
    'pass 2 (full-size) reused the half-size slot freed by pass 0')
})

test('the final pass needs no slot', () => {
  const passes = chain(4)
  const { slotOfPass } = assignTextureSlots(passes)
  assert(slotOfPass[3] === -1, 'the last pass renders to the canvas and should own no intermediate')
})

// --- Step 3: a real compiled plan, not a hand-built PassLiveness list ---
//
// A chain of pixelates is a linear read-the-previous-pass chain (each
// pixelate's textureInput 'source' reads the prior pass), so it exercises the
// same shape as the hand-built `chain()` fixture above, but through the real
// compiler on BOTH backends — proving the plan-assembly wiring (Step 2), not
// just the algorithm (already covered above).
const n = (id: string, t: string, p: Record<string, unknown> = {}) =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: t, params: p } }) as unknown as Node
const e = (id: string, s: string, sh: string, tg: string, th: string) =>
  ({ id, source: s, sourceHandle: sh, target: tg, targetHandle: th }) as unknown as Edge

const PIXELATE_COUNT = 4
const chainNodes = [
  n('src', 'gradient'),
  ...Array.from({ length: PIXELATE_COUNT }, (_, i) => n(`px${i}`, 'pixelate')),
  n('out', 'fragment_output'),
]
const chainEdges = [
  e('e_src', 'src', 'color', 'px0', 'source'),
  ...Array.from({ length: PIXELATE_COUNT - 1 }, (_, i) =>
    e(`e_px${i}`, `px${i}`, 'color', `px${i + 1}`, 'source')),
  e('e_out', `px${PIXELATE_COUNT - 1}`, 'color', 'out', 'color'),
]

// GLSL: RenderPass.inputTextures is Record<samplerName, passIndex> — read via
// Object.values, mirroring the accessor used in glsl-generator.ts itself.
const glslReadsPassIndices = (pass: { inputTextures: Record<string, number> }) =>
  Object.values(pass.inputTextures ?? {})
// IR/WGSL: WGSLPassOutput.inputTextures is Array<{passIndex, samplerName}> —
// read via .map, mirroring the accessor used in ir-compiler.ts itself.
const irReadsPassIndices = (pass: { inputTextures?: Array<{ passIndex: number }> }) =>
  (pass.inputTextures ?? []).map((t) => t.passIndex)

test('GLSL: a real multi-pass plan reuses slots and never aliases', () => {
  const plan = compileGraph(chainNodes, chainEdges)
  assert(plan.success, `compile failed: ${JSON.stringify(plan.errors)}`)
  assert(plan.passes.length > 1, `expected a multi-pass plan, got ${plan.passes.length} pass(es)`)
  assert(typeof plan.slotCount === 'number', 'plan.slotCount was not set by the compiler')

  const liveness: PassLiveness[] = plan.passes.map((p) => ({
    index: p.index,
    readsPassIndices: glslReadsPassIndices(p),
    sizeKey: `${p.resolution ?? 1}`,
  }))
  const slotOfPass = plan.passes.map((p) => p.targetSlot ?? -1)
  assertNoAliasing(liveness, slotOfPass)
  assert(plan.slotCount! < plan.passes.length,
    `a linear chain of ${plan.passes.length} passes should need fewer than ${plan.passes.length} slots, got ${plan.slotCount}`)
})

test('WGSL: a real multi-pass plan reuses slots and never aliases', () => {
  const plan = compileGraphIR(chainNodes, chainEdges)
  assert(plan !== null, 'IR compile returned null (a node lacks ir(), or compilation threw)')
  assert(plan!.passes.length > 1, `expected a multi-pass plan, got ${plan!.passes.length} pass(es)`)
  assert(typeof plan!.slotCount === 'number', 'plan.slotCount was not set by the compiler')

  const liveness: PassLiveness[] = plan!.passes.map((p, index) => ({
    index,
    readsPassIndices: irReadsPassIndices(p),
    sizeKey: `${p.resolution ?? 1}`,
  }))
  const slotOfPass = plan!.passes.map((p) => p.targetSlot ?? -1)
  assertNoAliasing(liveness, slotOfPass)
  assert(plan!.slotCount! < plan!.passes.length,
    `a linear chain of ${plan!.passes.length} passes should need fewer than ${plan!.passes.length} slots, got ${plan!.slotCount}`)
})

run('texture-slots')
