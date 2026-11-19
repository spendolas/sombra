/**
 * The `site-base` conformance fixture (feature request §6.1) and the pre-change
 * "compat" recipe, built programmatically — node by node, wire by wire — so the
 * graph is reviewable as code and every wire is checked by the same
 * isConnectionValid() rule the canvas applies to a drag.
 *
 * Browser-safe (no node:* imports): the offline gate (verify-embed-site.ts)
 * imports it under tsx, and the GPU gate (verify-embed-site-gpu.ts) imports it
 * through the Vite dev server, so both build the identical graph.
 *
 * Call initializeNodeLibrary() before building.
 *
 * SR-6 (Dither `mask` output) is P1 and not built. Per the spec's fallback the
 * fixture takes the mask from Dither·Result → Remap(0..0.5 → 0..1): Dither's
 * unwired colour is grey 0.5, so Result.x = 0.5 × mask and the Remap returns the
 * mask exactly (0 or 1). The manifest keys are the same as with a mask output.
 */
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData, PortType } from '../../src/nodes/types'
import { nodeRegistry } from '../../src/nodes/registry'
import { defaultParams } from '../../src/nodes/default-params'
import { isConnectionValid } from '../../src/nodes/connection-validity'

export type Graph = { nodes: Node<NodeData>[]; edges: Edge<EdgeData>[] }
export type Rgba = [number, number, number, number]

/** '#rrggbb' → straight RGBA in 0..1 (alpha 1). Every channel is an exact k/255. */
export const hex = (h: string): Rgba => [
  parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, 1,
]

/** The authored palette: stop 0 = "off" cells, stops 1–3 = "on" cells. */
export const SITE_STOP_HEX = ['#160709', '#ff4f5e', '#3ddc97', '#4d9fff'] as const
export const SITE_STOP_POSITIONS = [0, 0.25, 0.5, 0.75] as const

/**
 * The keys §6.1 requires, exactly. The unlabelled nodes' knobs come on top
 * (pixelate-pixel-size, fbm-octaves, …) and are listed by the gate, not pinned
 * here: they are the type-label names, and §6.1 only fixes the author-named ones.
 */
export const REQUIRED_SITE_KEYS = [
  'site-clock-speed', 'site-seed-value', 'site-balance-value', 'site-dots-pixel-size',
  'site-palette-stop-0', 'site-palette-stop-1', 'site-palette-stop-2', 'site-palette-stop-3',
  'fragment-output-alpha',
] as const

/** Builder that validates every wire like the canvas does. */
export function graphBuilder() {
  const nodes: Node<NodeData>[] = []
  const edges: Edge<EdgeData>[] = []
  const add = (id: string, type: string, col: number, row: number, params: Record<string, unknown> = {}, label?: string) => {
    const def = nodeRegistry.get(type)
    if (!def) throw new Error(`fixture: unknown node type "${type}"`)
    nodes.push({
      id, type: 'shaderNode', position: { x: col * 260, y: row * 200 },
      data: { type, params: { ...defaultParams(def), ...params }, ...(label ? { label } : {}) },
    })
  }
  const wire = (source: string, sourcePort: string, target: string, targetPort: string) => {
    const c = { source, target, sourceHandle: sourcePort, targetHandle: targetPort }
    if (!isConnectionValid(c, nodes, edges, (t) => nodeRegistry.get(t))) {
      throw new Error(`fixture: wire ${source}.${sourcePort} → ${target}.${targetPort} is not allowed`)
    }
    const src = nodes.find((n) => n.id === source)!
    const sourcePortType = (nodeRegistry.get(src.data.type)!.outputs.find((p) => p.id === sourcePort)!.type) as PortType
    edges.push({
      id: `e-${source}.${sourcePort}-${target}.${targetPort}`,
      ...c, type: 'typed', data: { sourcePort, targetPort, sourcePortType },
    })
  }
  return { nodes, edges, add, wire }
}

/**
 * §6.1 `site-base`: Value-FBM field → block-quantised (Pixelate 64 UV) →
 * Bayer dither (cells of 8) → Color Ramp (4 RGBA stops, Constant).
 */
export function buildSiteBase(): Graph {
  const g = graphBuilder()
  const stops = SITE_STOP_HEX.map((h, k) => ({ id: `s${k}`, position: SITE_STOP_POSITIONS[k], color: hex(h) }))

  g.add('site-clock', 'time', 0, 0, { speed: 0.05 }, 'site.clock')                       // 1
  g.add('pixelate', 'pixelate', 0, 1, { pixelSize: 64 })                                 // 2
  g.add('site-seed', 'float_constant', 0, 2, { value: 123 }, 'site.seed')                // 3
  g.add('fbm', 'fbm', 1, 0, {                                                            // 4
    noiseType: 'value', fractalMode: 'standard', octaves: 4, lacunarity: 2, gain: 0.5,
  })
  g.add('site-balance', 'float_constant', 1, 1, { value: 0 }, 'site.balance')            // 5
  g.add('add', 'arithmetic', 2, 0, { operation: 'add', inputCount: 2 })                  // 6
  g.add('site-dots', 'dither', 3, 0, {                                                   // 7
    pixelSize: 8, shape: 'square', colorSource: 'live',
  }, 'site.dots')
  g.add('noise', 'noise', 1, 2, { noiseType: 'simplex' })                                // 8
  // Simplex output is snoise3d(p) * 0.5 + 0.5 (noise-functions.ts `snoise3d_01`),
  // i.e. 0..1 → the "on" stops' range 0.30..0.90.
  g.add('remap-selector', 'remap', 2, 2, { inMin: 0, inMax: 1, outMin: 0.3, outMax: 0.9 }) // 9
  // SR-6 fallback: Dither·Result.x = 0.5 × mask → mask (see file header).
  g.add('remap-mask', 'remap', 4, 0, { inMin: 0, inMax: 0.5, outMin: 0, outMax: 1 })
  g.add('multiply', 'arithmetic', 5, 1, { operation: 'multiply', inputCount: 2 })        // 10
  g.add('site-palette', 'color_ramp', 6, 1, { interpolation: 'constant', stops }, 'site.palette') // 11
  g.add('output', 'fragment_output', 7, 1, {                                             // 12
    alpha: 1, alphaOp: 'multiply', quality: 'high', anchor: 'center',
  })

  g.wire('pixelate', 'uv', 'fbm', 'coords')
  g.wire('pixelate', 'uv', 'noise', 'coords')
  g.wire('site-clock', 'time', 'fbm', 'phase')
  g.wire('site-clock', 'time', 'noise', 'phase')
  g.wire('site-seed', 'value', 'fbm', 'seed')
  g.wire('site-seed', 'value', 'noise', 'seed')
  g.wire('fbm', 'value', 'add', 'in_0')
  g.wire('site-balance', 'value', 'add', 'in_1')
  g.wire('add', 'result', 'site-dots', 'threshold')
  g.wire('noise', 'value', 'remap-selector', 'value')
  g.wire('site-dots', 'result', 'remap-mask', 'value')
  g.wire('remap-mask', 'result', 'multiply', 'in_0')
  g.wire('remap-selector', 'result', 'multiply', 'in_1')
  g.wire('multiply', 'result', 'site-palette', 't')
  g.wire('site-palette', 'color', 'output', 'color')
  return { nodes: g.nodes, edges: g.edges }
}

/**
 * The pre-change recipe a host can use today (§6.1 "compat fixture"): the same
 * field and dither, but the palette is four Color nodes and three Mix nodes,
 * and the on/off choice is Dither·Result → Remap → the final Mix's factor.
 * Built only from nodes and params that existed at 5752aa9 (before SR-1..SR-4),
 * so the same graph can be published by that commit for a reference render.
 */
export function buildSiteCompat(): Graph {
  const g = graphBuilder()
  const color = (h: string) => ({ color: hex(h) })

  g.add('time', 'time', 0, 0, { speed: 0.05 })
  g.add('pixelate', 'pixelate', 0, 1, { pixelSize: 64 })
  g.add('seed', 'float_constant', 0, 2, { value: 123 })
  g.add('fbm', 'fbm', 1, 0, { noiseType: 'value', fractalMode: 'standard', octaves: 4, lacunarity: 2, gain: 0.5 })
  g.add('balance', 'float_constant', 1, 1, { value: 0 })
  g.add('add', 'arithmetic', 2, 0, { operation: 'add', inputCount: 2 })
  g.add('dither', 'dither', 3, 0, { pixelSize: 8, shape: 'square', colorSource: 'live' })
  g.add('noise', 'noise', 1, 2, { noiseType: 'simplex' })
  g.add('remap-mask', 'remap', 4, 0, { inMin: 0, inMax: 0.5, outMin: 0, outMax: 1 })
  g.add('c-off', 'color_constant', 4, 1, color(SITE_STOP_HEX[0]))
  g.add('c-on-1', 'color_constant', 4, 2, color(SITE_STOP_HEX[1]))
  g.add('c-on-2', 'color_constant', 4, 3, color(SITE_STOP_HEX[2]))
  g.add('c-on-3', 'color_constant', 4, 4, color(SITE_STOP_HEX[3]))
  g.add('mix-12', 'mix', 5, 2)
  g.add('mix-123', 'mix', 6, 2)
  g.add('mix-final', 'mix', 7, 1)
  g.add('output', 'fragment_output', 8, 1, { alpha: 1, alphaOp: 'multiply', quality: 'high', anchor: 'center' })

  g.wire('pixelate', 'uv', 'fbm', 'coords')
  g.wire('pixelate', 'uv', 'noise', 'coords')
  g.wire('time', 'time', 'fbm', 'phase')
  g.wire('time', 'time', 'noise', 'phase')
  g.wire('seed', 'value', 'fbm', 'seed')
  g.wire('seed', 'value', 'noise', 'seed')
  g.wire('fbm', 'value', 'add', 'in_0')
  g.wire('balance', 'value', 'add', 'in_1')
  g.wire('add', 'result', 'dither', 'threshold')
  g.wire('dither', 'result', 'remap-mask', 'value')
  // Selector: the Noise value blends on-1 → on-2, and FBM blends that → on-3.
  g.wire('c-on-1', 'color', 'mix-12', 'a')
  g.wire('c-on-2', 'color', 'mix-12', 'b')
  g.wire('noise', 'value', 'mix-12', 'factor')
  g.wire('mix-12', 'result', 'mix-123', 'a')
  g.wire('c-on-3', 'color', 'mix-123', 'b')
  g.wire('fbm', 'value', 'mix-123', 'factor')
  // On/off: mask 0 → c-off, mask 1 → the selected "on" colour.
  g.wire('c-off', 'color', 'mix-final', 'a')
  g.wire('mix-123', 'result', 'mix-final', 'b')
  g.wire('remap-mask', 'result', 'mix-final', 'factor')
  g.wire('mix-final', 'result', 'output', 'color')
  return { nodes: g.nodes, edges: g.edges }
}
