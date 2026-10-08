/**
 * Stack — N layers composited bottom-up, each with its own blend mode, opacity
 * and mask. Spec: docs/superpowers/specs/2026-09-11-stack-compositing-node-design.md.
 *
 * STORAGE ORDER: `params.layers` is BOTTOM-FIRST. Index 0 is the bottom layer,
 * composited first (sub-pass 0); the last entry is the top. The layer list UI
 * (StackLayerList) shows and reports layers TOP-FIRST, Photoshop order — so
 * the editor must flip between the two in exactly one place, mapping reorder
 * indices through the same flip. An off-by-one there is a silent wrong image.
 *
 * ALPHA. Stack COMPUTES alpha, and that is correct. The "don't invent alpha"
 * rule (NODE_AUTHORING_GUIDE.md) is for mask/effect primitives that must pass
 * `color.a` through. Stack is a BLEND: its output coverage is the alpha-aware
 * `over` of its layers (spec §3), which is a computed alpha by definition.
 *
 * MATHS (spec §3, straight alpha). Per layer, over the running result (c_b, a_b):
 *   a_s  = src.a · opacity · mask
 *   c_s' = (1 − a_b)·c_s + a_b·B(c_b, c_s)
 *   a_o  = a_s + a_b·(1 − a_s)
 *   c_o  = ((1 − a_s)·a_b·c_b + a_s·c_s') / a_o      (a_o == 0 → 0)
 * Layer colour, opacity and mask are clamped to [0,1] on entry. Values outside
 * [0,1] do not survive a Stack anyway: every layer source and every running
 * result crosses an rgba8 pass boundary. Additive glow is clipped there.
 *
 * BLEND SPACE. 'srgb' blends the stored values. 'linear' runs B AND the over in
 * linear light (Photoshop's "blend RGB colours using gamma 1.0"). The running
 * result is STORED in sRGB between sub-passes either way — each sub-pass
 * re-linearises what it reads and re-encodes what it writes. Linear values in
 * 8 bits band visibly in the darks, and only on a deep Stack.
 *
 * CHAIN (spec §4). `multiPass` with one sub-pass per VISIBLE layer. Sub-pass k
 * composites visible layer k onto the previous sub-pass, read through the
 * `backdrop` port that the expansion wires (never the user). `routeEdge` sends
 * each layer's source, opacity and mask to that layer's sub-pass only — two
 * samplers per pass regardless of layer count. Hidden layers get no sub-pass
 * and their edges reach none: they drop out of codegen entirely. Sub-pass 0
 * has nothing beneath it, so it emits no blend helper at all.
 *
 * ONE SOURCE. `ir()` builds the composite from structured IR; `glsl()` lowers
 * that same IR. The only per-path difference is how the shared colour helpers
 * register: GLSL keys them as one `sombra_color_helpers` block, exactly like
 * the blurs, so a blur and a Stack in one pass dedup instead of redefining.
 */

import type { GLSLContext, NodeDefinition, NodeParameter, PortDefinition } from '../types'
import { addFunction } from '../types'
import type { IRContext, IRExpr, IRNodeOutput, IRStmt, IRFunction } from '../../compiler/ir/types'
import {
  binary, call, construct, declare, fragCoord, literal, swizzle, textureSample, variable,
} from '../../compiler/ir/types'
import { lowerNodeOutputToGLSL } from '../../compiler/ir/glsl-backend'
import { SUB_PASS_PARAM } from '../../compiler/expand-passes'
import { BLEND_MODES, addBlendGLSL, blendFunctionName, blendIRFunctions, isBlendMode, type BlendMode } from '../shared/blend-modes'
import { COLOR_GLSL_HELPERS, COLOR_IR_HELPERS } from '../shared/color-space'

/** One entry of `params.layers`, which is stored bottom-first. */
export interface StackLayer {
  /** Stable, never reused. Ports derive from this — never from the array index. */
  id: string
  /** "Layer N", assigned at creation; travels with the layer when it moves. */
  name: string
  blendMode: BlendMode
  /** false → the layer has no sub-pass and its edges reach none. */
  visible: boolean
}

export type BlendSpace = 'srgb' | 'linear'

/** Bottom-first, like every `layers` array. Ids are only unique per node, so fixed ids are fine here. */
export const DEFAULT_STACK_LAYERS: readonly StackLayer[] = [
  { id: 'l1', name: 'Layer 1', blendMode: 'normal', visible: true },
  { id: 'l2', name: 'Layer 2', blendMode: 'normal', visible: true },
]

export const layerPortId = (id: string) => `layer_${id}`
export const opacityParamId = (id: string) => `opacity_${id}`
export const maskParamId = (id: string) => `mask_${id}`

/** The chain input. Wired by multi-pass expansion, never by the user. */
const BACKDROP = 'backdrop'

/** Layer ids become GLSL/WGSL identifier fragments (uniform names), so stay alnum. */
const ID_RE = /^[A-Za-z0-9]+$/

/**
 * The node's layers, BOTTOM-FIRST: index 0 is the bottom layer and sub-pass 0
 * (see the header — the layer list UI is top-first). A missing or non-array value falls back to
 * the default; malformed entries are dropped, so a hand-edited file or an old
 * share URL cannot crash codegen. An EMPTY array is a real state — the layer
 * list's designed empty state — and stays empty.
 */
export function getLayers(params: Record<string, unknown>): StackLayer[] {
  const raw = params.layers
  if (!Array.isArray(raw)) return DEFAULT_STACK_LAYERS.map((l) => ({ ...l }))
  const out: StackLayer[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const l = item as Record<string, unknown>
    if (typeof l.id !== 'string' || !ID_RE.test(l.id) || seen.has(l.id)) continue
    seen.add(l.id)
    out.push({
      id: l.id,
      name: typeof l.name === 'string' ? l.name : l.id,
      blendMode: isBlendMode(l.blendMode) ? l.blendMode : 'normal',
      visible: l.visible !== false,
    })
  }
  return out
}

export const visibleLayers = (params: Record<string, unknown>) => getLayers(params).filter((l) => l.visible)

const backdropPort: PortDefinition = {
  id: BACKDROP, label: 'Backdrop', type: 'color', textureInput: true, default: [0, 0, 0, 0],
}

function layerInputs(params: Record<string, unknown>): PortDefinition[] {
  return [
    backdropPort,
    // Every layer, hidden or not: a hidden layer keeps its wires, it just
    // doesn't composite. The explicit transparent default is required — an
    // unwired port without one is a hard compile error.
    ...getLayers(params).map((l): PortDefinition => ({
      id: layerPortId(l.id), label: l.name, type: 'color', textureInput: true, default: [0, 0, 0, 0],
    })),
  ]
}

const STATIC_PARAMS: NodeParameter[] = [
  {
    id: 'layers', label: 'Layers', type: 'float',
    default: DEFAULT_STACK_LAYERS as unknown as ReadonlyArray<Readonly<Record<string, unknown>>>,
    hidden: true, updateMode: 'recompile',
  },
  // Never decreases, so a new layer is named one higher than any ever made.
  { id: 'nextLayerNumber', label: 'Next Layer Number', type: 'float', default: 3, hidden: true, updateMode: 'recompile' },
  {
    // Drawn by the generic parameter section, at the very bottom of the node
    // under its divider (Figma 983:5896, column B).
    id: 'blendSpace', label: 'Blend space', type: 'enum', default: 'srgb', control: 'segmented',
    options: [{ value: 'srgb', label: 'sRGB' }, { value: 'linear', label: 'Linear' }],
    updateMode: 'recompile',
  },
]

function layerParams(params: Record<string, unknown>): NodeParameter[] {
  return [
    ...STATIC_PARAMS,
    ...getLayers(params).flatMap((l): NodeParameter[] => [
      {
        id: opacityParamId(l.id), label: `${l.name} Opacity`, type: 'float', default: 1,
        min: 0, max: 1, step: 0.01, connectable: true, updateMode: 'uniform',
      },
      {
        id: maskParamId(l.id), label: `${l.name} Mask`, type: 'float', default: 1,
        min: 0, max: 1, step: 0.01, connectable: true, updateMode: 'uniform',
      },
    ]),
  ]
}

/** Which layer handle (source / opacity / mask) an incoming edge targets, if any. */
function layerOfHandle(handle: string): string | null {
  const m = /^(?:layer|opacity|mask)_([A-Za-z0-9]+)$/.exec(handle)
  return m ? m[1] : null
}

// ---------------------------------------------------------------------------
// Codegen — one IR source for both paths
// ---------------------------------------------------------------------------

interface Built {
  output: IRNodeOutput
  /** Blend helpers this sub-pass needs (empty for the bottom layer). */
  blend: BlendMode | null
  linear: boolean
}

function build(ctx: IRContext): Built {
  const { outputs, inputs, params } = ctx
  const id = ctx.nodeId.replace(/-/g, '_')
  const k = Number(params[SUB_PASS_PARAM] ?? 0)
  const layer = visibleLayers(params)[k]
  const out = outputs.color
  const standardUniforms = new Set<string>()

  // No visible layer: an explicit transparent constant. Assigning nothing would
  // leave downstream reading an undeclared variable — a shader that passes the
  // compiler's error check and fails at GPU link.
  if (!layer) {
    return {
      output: { statements: [declare(out, 'vec4', literal('vec4', [0, 0, 0, 0]))], uniforms: [], standardUniforms },
      blend: null, linear: false,
    }
  }

  const linear = params.blendSpace === 'linear'
  const v = (name: string, type: Parameters<typeof variable>[1] = 'float') => variable(name, type)
  const f = (x: number) => literal('float', x)
  const v3 = (x: number) => construct('vec3', [f(x)])
  const n = (s: string) => `stk_${s}_${id}`
  const stmts: IRStmt[] = []

  // Pass-target UV for sampling the backdrop and the layer source: both are
  // full-canvas intermediates, read at this fragment's own texel.
  const samplers = ctx.textureSamplers ?? {}
  let uvDeclared = false
  const sample = (port: string): IRExpr | null => {
    const s = samplers[port]
    if (!s) return null
    if (!uvDeclared) {
      standardUniforms.add('u_viewport')
      stmts.push(declare(n('uv'), 'vec2', binary('/', fragCoord('native'), v('u_viewport', 'vec2'), 'vec2')))
      uvDeclared = true
    }
    // Explicit LOD 0: intermediates have no mips, and it stays legal under
    // non-uniform control flow on WGSL.
    return textureSample(s, v(n('uv'), 'vec2'), 'vec4', f(0))
  }

  const clamp01 = (e: IRExpr, t: 'float' | 'vec4') =>
    call('clamp', [e, t === 'float' ? f(0) : literal('vec4', [0, 0, 0, 0]), t === 'float' ? f(1) : literal('vec4', [1, 1, 1, 1])], t)

  // Backdrop: the previous sub-pass, or transparent for the bottom layer.
  const backdrop = sample(BACKDROP)
  // Layer source: its pass texture when wired, else the port's input value
  // (the transparent default).
  const srcPort = layerPortId(layer.id)
  const src = sample(srcPort) ?? v(inputs[srcPort], 'vec4')
  stmts.push(declare(n('src'), 'vec4', clamp01(src, 'vec4')))

  const enc = (e: IRExpr) => (linear ? call('sombra_toLin', [e], 'vec3') : e)
  stmts.push(declare(n('cs'), 'vec3', enc(swizzle(v(n('src'), 'vec4'), 'rgb', 'vec3'))))
  stmts.push(declare(n('as'), 'float', binary('*',
    binary('*', swizzle(v(n('src'), 'vec4'), 'a', 'float'), clamp01(v(inputs[opacityParamId(layer.id)]), 'float'), 'float'),
    clamp01(v(inputs[maskParamId(layer.id)]), 'float'), 'float')))

  let blend: BlendMode | null = null
  let color: IRExpr
  let alpha: IRExpr
  if (!backdrop) {
    // Bottom of the chain: nothing beneath, so B never applies and the over
    // collapses to the layer itself (c_o = c_s, a_o = a_s).
    color = v(n('cs'), 'vec3')
    alpha = v(n('as'))
  } else {
    blend = layer.blendMode
    stmts.push(declare(n('bd'), 'vec4', backdrop))
    stmts.push(declare(n('cb'), 'vec3', enc(swizzle(v(n('bd'), 'vec4'), 'rgb', 'vec3'))))
    stmts.push(declare(n('ab'), 'float', swizzle(v(n('bd'), 'vec4'), 'a', 'float')))
    const ab = v(n('ab')), as = v(n('as')), cb = v(n('cb'), 'vec3'), cs = v(n('cs'), 'vec3')
    // c_s' = (1 − a_b)·c_s + a_b·B(c_b, c_s)
    stmts.push(declare(n('cs2'), 'vec3', binary('+',
      binary('*', binary('-', f(1), ab, 'float'), cs, 'vec3'),
      binary('*', ab, call(blendFunctionName(blend), [cb, cs], 'vec3'), 'vec3'), 'vec3')))
    // a_o = a_s + a_b·(1 − a_s)
    stmts.push(declare(n('ao'), 'float', binary('+', as, binary('*', ab, binary('-', f(1), as, 'float'), 'float'), 'float')))
    // c_o = ((1 − a_s)·a_b·c_b + a_s·c_s') / a_o — guarded: when a_o is 0 the
    // numerator is 0 too, so dividing by the floor yields 0.
    stmts.push(declare(n('co'), 'vec3', binary('/',
      binary('+',
        binary('*', binary('*', binary('-', f(1), as, 'float'), ab, 'float'), cb, 'vec3'),
        binary('*', as, v(n('cs2'), 'vec3'), 'vec3'), 'vec3'),
      call('max', [v(n('ao')), f(0.000001)], 'float'), 'vec3')))
    color = v(n('co'), 'vec3')
    alpha = v(n('ao'))
  }
  // Store sRGB: re-encode what this sub-pass writes (see header).
  const rgb = linear ? call('sombra_toSrgb', [call('max', [color, v3(0)], 'vec3')], 'vec3') : color
  stmts.push(declare(out, 'vec4', construct('vec4', [rgb, alpha])))

  return { output: { statements: stmts, uniforms: [], standardUniforms }, blend, linear }
}

export const stackNode: NodeDefinition = {
  type: 'stack',
  label: 'Stack',
  category: 'Color',
  description: 'Composite layers bottom-up, each with its own blend mode, opacity and mask',
  hidePreview: false,
  // The layer list draws every input handle (src/components/StackNodeBody.tsx).
  portsRenderedByComponent: true,

  inputs: layerInputs({}),
  dynamicInputs: layerInputs,
  outputs: [{ id: 'color', label: 'Color', type: 'color' }],
  params: layerParams({}),
  dynamicParams: layerParams,

  multiPass: {
    // One sub-pass per VISIBLE layer; 0 visible still yields one (transparent) pass.
    count: (params) => Math.max(1, visibleLayers(params).length),
    from: 'color',
    to: BACKDROP,
    requiresWiredSource: false,
    routeEdge: (handle, passIndex, params) => {
      const lid = layerOfHandle(handle)
      // Not a per-layer handle (or not one of this node's layers): reach every
      // sub-pass. A whitelist here would silently delete global inputs.
      if (lid === null) return true
      const all = getLayers(params)
      if (!all.some((l) => l.id === lid)) return true
      return visibleLayers(params).findIndex((l) => l.id === lid) === passIndex
    },
  },

  ir: (ctx: IRContext): IRNodeOutput => {
    const { output, blend, linear } = build(ctx)
    const functions: IRFunction[] = [
      ...(linear ? COLOR_IR_HELPERS : []),
      ...(blend ? blendIRFunctions(blend) : []),
    ]
    return functions.length ? { ...output, functions } : output
  },

  glsl: (ctx: GLSLContext): string => {
    const { output, blend, linear } = build(ctx)
    for (const u of output.standardUniforms) ctx.uniforms.add(u)
    // Same key as the blurs (see header): one block, deduped across nodes.
    if (linear) addFunction(ctx, 'sombra_color_helpers', COLOR_GLSL_HELPERS)
    if (blend) addBlendGLSL(ctx, blend)
    return lowerNodeOutputToGLSL(output).join('\n  ')
  },
}

/** Labels for the layer list's blend menu. */
export const STACK_BLEND_OPTIONS = BLEND_MODES.map((m) => ({ value: m.id, label: m.label }))
