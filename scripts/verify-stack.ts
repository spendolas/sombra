/**
 * The Stack node's contract, checked without a GPU (verify:ci).
 * The GPU half — pixels, hidden layers rendering, banding — is
 * verify-stack-gpu.ts.
 *
 *   data model   two default layers, Layer 1 / Layer 2, nextLayerNumber 3, and
 *                a new node's list is its own copy, not the registry's.
 *   ports        derived from the array, by stable id, for EVERY layer —
 *                hidden ones keep their ports (and wires).
 *   routing      routeEdge returns true for any handle it does not recognise,
 *                at every sub-pass. A per-layer handle reaches exactly its
 *                visible layer's sub-pass; a hidden layer's reaches none.
 *   expansion    the real expander, on a graph with a hidden layer and a
 *                dangling handle: sub-pass count and every edge's destination.
 *   codegen      all 24 modes × both blend spaces, both codegen paths: the
 *                top composite defines exactly its mode's helper, the bottom
 *                defines none; zero visible layers emits a transparent constant.
 *   dedup        a linear Stack composite sharing a pass with a blur defines
 *                the colour helpers ONCE on both paths.
 *   robustness   malformed / duplicate / non-identifier layer ids are dropped.
 *
 * Run: npm run verify:stack
 */
import { initializeNodeLibrary } from '../src/nodes'
import { nodeRegistry } from '../src/nodes/registry'
import { defaultParams } from '../src/nodes/default-params'
import { resolveParams } from '../src/nodes/resolve-dynamic'
import { expandMultiPassNodes } from '../src/compiler/expand-passes'
import { compileGraph } from '../src/compiler/glsl-generator'
import { compileGraphIR, toPlanWgsl } from '../src/compiler/ir-compiler'
import { getLayers, type StackLayer } from '../src/nodes/color/stack'
import { BLEND_MODES } from '../src/nodes/shared/blend-modes'
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import type { Node, Edge } from '@xyflow/react'

initializeNodeLibrary()
const def = nodeRegistry.get('stack')!

const L = (id: string, blendMode = 'normal', visible = true): StackLayer =>
  ({ id, name: `Layer ${id}`, blendMode, visible } as StackLayer)
const n = (id: string, type: string, params: Record<string, unknown> = {}) =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params } }) as unknown as Node
const e = (id: string, s: string, sh: string, t: string, th: string) =>
  ({ id, source: s, sourceHandle: sh, target: t, targetHandle: th }) as unknown as Edge

test('registered, one color output, a multiPass chain on `backdrop` that needs no wired source', () => {
  assert(def !== undefined, 'stack is not registered')
  assert(def.outputs.length === 1 && def.outputs[0].id === 'color' && def.outputs[0].type === 'color', 'expected exactly one color output')
  assert(def.multiPass?.to === 'backdrop' && def.multiPass.from === 'color', 'chain must run color → backdrop')
  assert(def.multiPass?.requiresWiredSource === false, 'the chain input is wired by the expansion — requiresWiredSource must be false')
  assert(!!def.ir, 'stack has no ir() — WebGPU would not see it')
})

test('defaults: two layers, Layer 1 / Layer 2, nextLayerNumber 3 — and each node owns its copy', () => {
  const p = defaultParams(def)
  const layers = p.layers as StackLayer[]
  assert(Array.isArray(layers) && layers.length === 2, `expected 2 default layers, got ${JSON.stringify(layers)}`)
  assert(layers[0].name === 'Layer 1' && layers[1].name === 'Layer 2', `names ${layers.map((l) => l.name)}`)
  assert(layers.every((l) => l.visible && l.blendMode === 'normal'), 'default layers must be visible, normal')
  assert(p.nextLayerNumber === 3, `nextLayerNumber ${p.nextLayerNumber}`)
  const reg = def.params!.find((q) => q.id === 'layers')!.default
  assert(layers !== reg && layers[0] !== (reg as unknown[])[0], 'the new node aliases the registry default layer list')
})

test('ports and params derive from the array, for every layer including hidden ones', () => {
  const params = { layers: [L('aa'), L('bb', 'screen', false), L('cc', 'multiply')] }
  const inputs = def.dynamicInputs!(params)
  assert(inputs[0].id === 'backdrop' && inputs[0].textureInput === true, 'backdrop must be the first (chain) port')
  for (const id of ['aa', 'bb', 'cc']) {
    const port = inputs.find((i) => i.id === `layer_${id}`)
    assert(!!port, `no port for layer ${id}${id === 'bb' ? ' (hidden layers keep their port)' : ''}`)
    assert(port!.textureInput === true && port!.type === 'color', `layer_${id} must be a color textureInput`)
    assert(JSON.stringify(port!.default) === '[0,0,0,0]', `layer_${id} default ${JSON.stringify(port!.default)} — must be explicit transparent`)
    const ps = resolveParams(def, params)
    for (const pid of [`opacity_${id}`, `mask_${id}`]) {
      const q = ps.find((x) => x.id === pid)
      assert(!!q && q.connectable === true && q.updateMode === 'uniform' && q.default === 1, `${pid}: ${JSON.stringify(q)}`)
    }
  }
  // The static list is only the fallback for the DEFAULT layers (types.ts:
  // sites that run before an instance exists read it). This instance's layer
  // params must come from dynamicParams, or a fixture-only id would be absent.
  assert(!(def.params ?? []).some((q) => q.id === 'opacity_aa'), 'opacity_aa is in the STATIC params — this test would not exercise dynamicParams')
})

test('routeEdge: unrecognised handles reach EVERY sub-pass; layer handles reach exactly their own', () => {
  const route = def.multiPass!.routeEdge!
  const params = { layers: [L('aa'), L('bb', 'screen', false), L('cc', 'multiply'), L('dd')] }
  const count = def.multiPass!.count(params)
  assert(count === 3, `count ${count}, expected 3 visible`)
  for (let k = 0; k < count; k++) {
    for (const h of ['gain', 'blendSpace', 'layer_zz', 'opacity_zz', 'not-a-handle']) {
      assert(route(h, k, params) === true, `routeEdge('${h}', ${k}) is false — an unrecognised handle would be silently deleted`)
    }
  }
  const visibleIndex: Record<string, number> = { aa: 0, cc: 1, dd: 2 }
  for (const id of ['aa', 'bb', 'cc', 'dd']) {
    for (const kind of ['layer', 'opacity', 'mask']) {
      const reached = [0, 1, 2].filter((k) => route(`${kind}_${id}`, k, params))
      const want = id in visibleIndex ? [visibleIndex[id]] : []
      assert(JSON.stringify(reached) === JSON.stringify(want), `${kind}_${id} reaches sub-passes ${JSON.stringify(reached)}, expected ${JSON.stringify(want)}`)
    }
  }
})

test('expansion: one sub-pass per visible layer, each edge where routing says', () => {
  const params = { layers: [L('aa'), L('bb', 'screen', false), L('cc', 'multiply')] }
  const nodes = [n('s1', 'checkerboard'), n('s2', 'gradient'), n('s3', 'checkerboard'), n('m', 'float_constant'), n('stk', 'stack', params), n('out', 'fragment_output')]
  const edges = [
    e('e1', 's1', 'color', 'stk', 'layer_aa'),
    e('e2', 's2', 'color', 'stk', 'layer_bb'),
    e('e3', 's3', 'color', 'stk', 'layer_cc'),
    e('e4', 'm', 'value', 'stk', 'mask_cc'),
    e('e5', 'm', 'value', 'stk', 'opacity_bb'),
    e('e6', 'stk', 'color', 'out', 'color'),
  ]
  const out = expandMultiPassNodes(nodes as never, edges as never)
  const chain = (out.nodes as Node[]).filter((x) => (x.data as { type: string }).type === 'stack')
  assert(chain.length === 2, `expected 2 sub-passes (2 visible), got ${chain.length}`)
  const into = (id: string) => (out.edges as Edge[]).filter((x) => x.target === id).map((x) => x.targetHandle).sort()
  assert(JSON.stringify(into(chain[0].id)) === '["layer_aa"]', `sub-pass 0 receives ${JSON.stringify(into(chain[0].id))}`)
  assert(JSON.stringify(into(chain[1].id)) === '["backdrop","layer_cc","mask_cc"]', `sub-pass 1 receives ${JSON.stringify(into(chain[1].id))}`)
  assert(!(out.edges as Edge[]).some((x) => x.targetHandle === 'layer_bb' || x.targetHandle === 'opacity_bb'), 'a hidden layer\'s edges survived expansion')
  assert((out.edges as Edge[]).some((x) => x.source === chain[1].id && x.target === 'out'), 'downstream does not read the last sub-pass')
})

const compileBoth = (nodes: Node[], edges: Edge[]) => {
  const plan = compileGraph(nodes as never, edges as never)
  assert(plan.success, `GLSL compile failed: ${JSON.stringify(plan.errors)}`)
  const ir = compileGraphIR(nodes as never, edges as never)
  assert(ir !== null, 'IR compile returned null')
  const wgsl = toPlanWgsl(ir!)
  assert(wgsl.passes.length === plan.passes.length, `pass count GLSL ${plan.passes.length} vs WGSL ${wgsl.passes.length}`)
  return { glsl: plan.passes.map((p) => p.fragmentShader), wgsl: wgsl.passes.map((p) => p.shaderCode) }
}
const defs = (text: string, re: RegExp) => [...text.matchAll(re)].map((m) => m[1])
const GLSL_BLEND = /\b(?:vec3|float)\s+(sombra_blend_\w+)\s*\(/g
const WGSL_BLEND = /\bfn\s+(sombra_blend_\w+)\s*\(/g

for (const space of ['srgb', 'linear']) {
  test(`codegen [${space}]: every mode compiles on both paths and emits only its own helper`, () => {
    for (const m of BLEND_MODES) {
      const params = { layers: [L('aa'), L('bb', m.id)], blendSpace: space }
      const nodes = [n('s1', 'checkerboard'), n('s2', 'gradient'), n('stk', 'stack', params), n('out', 'fragment_output')]
      const edges = [e('e1', 's1', 'color', 'stk', 'layer_aa'), e('e2', 's2', 'color', 'stk', 'layer_bb'), e('e3', 'stk', 'color', 'out', 'color')]
      const { glsl, wgsl } = compileBoth(nodes, edges)
      assert(glsl.length === 4, `${m.id}: ${glsl.length} passes, expected 2 sources + 2 composites`)
      for (const [side, texts, re] of [['GLSL', glsl, GLSL_BLEND], ['WGSL', wgsl, WGSL_BLEND]] as const) {
        assert(defs(texts[2], re).length === 0, `${m.id} ${side}: the bottom composite defines ${JSON.stringify(defs(texts[2], re))}`)
        const top = defs(texts[3], re)
        assert(top.includes(`sombra_blend_${m.id}`), `${m.id} ${side}: the top composite does not define its helper`)
        const foreign = top.filter((d) => BLEND_MODES.some((o) => o.id !== m.id && d === `sombra_blend_${o.id}`)
          && !(m.id === 'vividLight' && (d === 'sombra_blend_colorBurn' || d === 'sombra_blend_colorDodge')))
        assert(foreign.length === 0, `${m.id} ${side}: defines other modes ${JSON.stringify(foreign)}`)
        const lin = /sombra_toLin\s*\(/.test(texts[3])
        assert(lin === (space === 'linear'), `${m.id} ${side}: colour-space helpers ${lin ? 'present' : 'absent'} in ${space}`)
      }
    }
  })
}

test('zero visible layers: an explicit transparent constant on both paths', () => {
  zeroVisible({ layers: [L('aa', 'normal', false)] }, true) // one hidden, wired
  zeroVisible({ layers: [] }, false) // the designed empty state
})

function zeroVisible(params: Record<string, unknown>, wired: boolean) {
  const nodes = [n('s1', 'checkerboard'), n('stk', 'stack', params), n('out', 'fragment_output')]
  const edges = [...(wired ? [e('e1', 's1', 'color', 'stk', 'layer_aa')] : []), e('e3', 'stk', 'color', 'out', 'color')]
  const { glsl, wgsl } = compileBoth(nodes, edges)
  assert(glsl.length === 1, `expected 1 pass, got ${glsl.length}`)
  assert(/vec4 node_stk_color = vec4\(0\.0, 0\.0, 0\.0, 0\.0\)/.test(glsl[0]), 'GLSL: no explicit transparent constant for the Stack output')
  assert(/var node_stk_color: vec4f = vec4f\(0\.0, 0\.0, 0\.0, 0\.0\)/.test(wgsl[0]), 'WGSL: no explicit transparent constant for the Stack output')
}

test('a linear Stack composite beside a blur in ONE pass defines the colour helpers once', () => {
  // The mask is a plain (non-texture) port, so the blur feeding it compiles
  // into the composite's own pass — the shape where two registration keys for
  // the same functions would collide.
  const params = { layers: [L('aa'), L('bb', 'screen')], blendSpace: 'linear' }
  const nodes = [n('s1', 'checkerboard'), n('s2', 'gradient'), n('bsrc', 'checkerboard'), n('bl', 'blur', { radius: 8 }),
    n('stk', 'stack', params), n('out', 'fragment_output')]
  const edges = [
    e('e1', 's1', 'color', 'stk', 'layer_aa'), e('e2', 's2', 'color', 'stk', 'layer_bb'),
    e('e3', 'bsrc', 'color', 'bl', 'source'), e('e4', 'bl', 'color', 'stk', 'mask_bb'),
    e('e5', 'stk', 'color', 'out', 'color'),
  ]
  const { glsl, wgsl } = compileBoth(nodes, edges)
  const last = glsl.length - 1
  assert(/textureLod\(u_pass\d+_tex/.test(glsl[last]) && /stk_cs2_/.test(glsl[last]) && /bl_|blur/i.test(glsl[last]),
    'fixture broken: the blur did not land in the top composite\'s pass')
  for (const [side, text, re] of [['GLSL', glsl[last], /\bvec3\s+sombra_toLin\s*\(/g], ['WGSL', wgsl[last], /\bfn\s+sombra_toLin\s*\(/g]] as const) {
    const count = (text.match(re) ?? []).length
    assert(count === 1, `${side}: sombra_toLin defined ${count} times in one pass`)
  }
})

test('getLayers drops malformed, duplicate and non-identifier ids; missing falls back, empty stays empty', () => {
  const got = getLayers({ layers: [L('ok1'), { id: 'bad-id', name: 'x' }, L('ok1'), null, { id: 7 }, L('ok2', 'nonsense')] })
  assert(JSON.stringify(got.map((l) => l.id)) === '["ok1","ok2"]', `kept ${JSON.stringify(got.map((l) => l.id))}`)
  assert(got[1].blendMode === 'normal', 'an unknown blend mode should fall back to normal')
  assert(getLayers({}).length === 2 && getLayers({ layers: 'junk' }).length === 2, 'missing / non-array layers should fall back to the two defaults')
  // The layer list's designed empty state: no layers is a real value, not a
  // reason to resurrect the defaults.
  assert(getLayers({ layers: [] }).length === 0, 'an empty layer list was replaced by the defaults')
})

await run('stack')
