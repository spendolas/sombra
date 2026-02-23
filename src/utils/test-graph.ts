/**
 * Test graph utilities - for development and testing
 */

import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../nodes/types'
import { layoutGraph } from './layout'

/**
 * Default startup graph: Time → Noise → Color Ramp → Output
 * Animated simplex noise with Cobalt Drift palette — simple but visually appealing
 */
export function createDefaultGraph(): {
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
} {
  const nodes: Node<NodeData>[] = [
    {
      id: 'def-time',
      type: 'shaderNode',
      position: { x: 0, y: 0 },
      data: { type: 'time', params: { speed: 0.3 } },
    },
    {
      id: 'def-noise',
      type: 'shaderNode',
      position: { x: 0, y: 0 },
      data: { type: 'noise', params: { scale: 3.0, noiseType: 'simplex' } },
    },
    {
      id: 'def-ramp',
      type: 'shaderNode',
      position: { x: 0, y: 0 },
      data: {
        type: 'color_ramp',
        params: {
          interpolation: 'smooth',
          stops: [
            { position: 0.0, color: [0.020, 0.027, 0.051] },
            { position: 0.25, color: [0.137, 0.231, 0.416] },
            { position: 0.5, color: [0.235, 0.435, 1.000] },
            { position: 0.75, color: [0.549, 0.776, 1.000] },
            { position: 1.0, color: [0.663, 0.729, 0.839] },
          ],
        },
      },
    },
    {
      id: 'def-output',
      type: 'shaderNode',
      position: { x: 0, y: 0 },
      data: { type: 'fragment_output', params: {} },
    },
  ]

  const edges: Edge<EdgeData>[] = [
    {
      id: 'def-e1', source: 'def-time', target: 'def-noise',
      sourceHandle: 'time', targetHandle: 'phase', type: 'typed',
      data: { sourcePort: 'time', targetPort: 'phase', sourcePortType: 'float' },
    },
    {
      id: 'def-e2', source: 'def-noise', target: 'def-ramp',
      sourceHandle: 'value', targetHandle: 't', type: 'typed',
      data: { sourcePort: 'value', targetPort: 't', sourcePortType: 'float' },
    },
    {
      id: 'def-e3', source: 'def-ramp', target: 'def-output',
      sourceHandle: 'color', targetHandle: 'color', type: 'typed',
      data: { sourcePort: 'color', targetPort: 'color', sourcePortType: 'vec3' },
    },
  ]

  return { nodes: layoutGraph(nodes, edges), edges }
}

/**
 * Create a simple test graph: Color → Fragment Output
 * This tests the minimal viable pipeline
 */
export function createSimpleTestGraph(): {
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
} {
  const colorNode: Node<NodeData> = {
    id: 'test-color',
    type: 'shaderNode',
    position: { x: 100, y: 100 },
    data: {
      type: 'color_constant',
      params: {
        color: [1.0, 0.0, 1.0], // Magenta
      },
    },
  }

  const outputNode: Node<NodeData> = {
    id: 'test-output',
    type: 'shaderNode',
    position: { x: 400, y: 100 },
    data: {
      type: 'fragment_output',
      params: {},
    },
  }

  const edge: Edge<EdgeData> = {
    id: 'test-edge-1',
    source: 'test-color',
    target: 'test-output',
    sourceHandle: 'color',
    targetHandle: 'color',
    data: {
      sourcePort: 'color',
      targetPort: 'color',
    },
  }

  return {
    nodes: [colorNode, outputNode],
    edges: [edge],
  }
}

/**
 * Create UV test graph: UV → Fragment Output
 * Shows UV coordinates as RGB (xy → RG, B = 0)
 */
export function createUVTestGraph(): {
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
} {
  const uvNode: Node<NodeData> = {
    id: 'test-uv',
    type: 'shaderNode',
    position: { x: 100, y: 100 },
    data: {
      type: 'uv_transform',
      params: {},
    },
  }

  const outputNode: Node<NodeData> = {
    id: 'test-output',
    type: 'shaderNode',
    position: { x: 400, y: 100 },
    data: {
      type: 'fragment_output',
      params: {},
    },
  }

  const edge: Edge<EdgeData> = {
    id: 'test-edge-uv',
    source: 'test-uv',
    target: 'test-output',
    sourceHandle: 'uv',
    targetHandle: 'color',
    data: {
      sourcePort: 'uv',
      targetPort: 'color',
    },
  }

  return {
    nodes: [uvNode, outputNode],
    edges: [edge],
  }
}

/**
 * Spectra preset: Value FBM
 * Pipeline: Noise(value).fn → FBM → Color Ramp → Pixel Grid → Output
 * - Value noise via FBM (1 octave = single pass), auto_uv coords
 * - Time drives FBM phase for animation
 * - Binary Bayer threshold per visible pixel
 */
export function createSpectraValueFBM(): {
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
} {
  const nodes: Node<NodeData>[] = [
    // Time feeds FBM.phase (2nd input) — above Noise to match handle order
    {
      id: 'sp-time',
      type: 'shaderNode',
      position: { x: 0, y: 0 },
      data: { type: 'time', params: { speed: 0.5 } },
    },
    // Value noise fnref source → FBM.noiseFn (3rd input) — below Time
    {
      id: 'sp-noise-ref',
      type: 'shaderNode',
      position: { x: 0, y: 160 },
      data: {
        type: 'noise',
        params: { scale: 1.0, noiseType: 'value' },
      },
    },
    // FBM: 1 octave = single noise pass (auto_uv coords)
    {
      id: 'sp-fbm',
      type: 'shaderNode',
      position: { x: 280, y: 40 },
      data: {
        type: 'fbm',
        params: { scale: 1.0, fractalMode: 'standard', octaves: 1, lacunarity: 2.0, gain: 0.5 },
      },
    },
    // Cobalt Drift color ramp
    {
      id: 'sp-ramp',
      type: 'shaderNode',
      position: { x: 560, y: 40 },
      data: {
        type: 'color_ramp',
        params: {
          interpolation: 'smooth',
          stops: [
            { position: 0.0, color: [0.020, 0.027, 0.051] },
            { position: 0.25, color: [0.137, 0.231, 0.416] },
            { position: 0.5, color: [0.235, 0.435, 1.000] },
            { position: 0.75, color: [0.549, 0.776, 1.000] },
            { position: 1.0, color: [0.663, 0.729, 0.839] },
          ],
        },
      },
    },
    // Pixel Grid: 8px visible pixels, square, binary threshold
    {
      id: 'sp-pixel',
      type: 'shaderNode',
      position: { x: 840, y: 40 },
      data: {
        type: 'pixel_grid',
        params: { pixelSize: 8, shape: 'square', threshold: 1.0 },
      },
    },
    {
      id: 'sp-output',
      type: 'shaderNode',
      position: { x: 1100, y: 40 },
      data: { type: 'fragment_output', params: {} },
    },
  ]

  const edges: Edge<EdgeData>[] = [
    // Noise(value).fn → FBM.noiseFn (fnref)
    {
      id: 'sp-e1', source: 'sp-noise-ref', target: 'sp-fbm',
      sourceHandle: 'fn', targetHandle: 'noiseFn', type: 'typed',
      data: { sourcePort: 'fn', targetPort: 'noiseFn', sourcePortType: 'fnref' },
    },
    // Time → FBM.phase
    {
      id: 'sp-e2', source: 'sp-time', target: 'sp-fbm',
      sourceHandle: 'time', targetHandle: 'phase', type: 'typed',
      data: { sourcePort: 'time', targetPort: 'phase', sourcePortType: 'float' },
    },
    // FBM.value → Color Ramp.t
    {
      id: 'sp-e3', source: 'sp-fbm', target: 'sp-ramp',
      sourceHandle: 'value', targetHandle: 't', type: 'typed',
      data: { sourcePort: 'value', targetPort: 't', sourcePortType: 'float' },
    },
    // FBM.value → Pixel Grid.threshold
    {
      id: 'sp-e4', source: 'sp-fbm', target: 'sp-pixel',
      sourceHandle: 'value', targetHandle: 'threshold', type: 'typed',
      data: { sourcePort: 'value', targetPort: 'threshold', sourcePortType: 'float' },
    },
    // Color Ramp → Pixel Grid.color
    {
      id: 'sp-e5', source: 'sp-ramp', target: 'sp-pixel',
      sourceHandle: 'color', targetHandle: 'color', type: 'typed',
      data: { sourcePort: 'color', targetPort: 'color', sourcePortType: 'vec3' },
    },
    // Pixel Grid → Fragment Output
    {
      id: 'sp-e6', source: 'sp-pixel', target: 'sp-output',
      sourceHandle: 'result', targetHandle: 'color', type: 'typed',
      data: { sourcePort: 'result', targetPort: 'color', sourcePortType: 'vec3' },
    },
  ]

  return { nodes: layoutGraph(nodes, edges), edges }
}

/**
 * Spectra preset: Simplex FBM
 * Pipeline: Quantize UV(344) → FBM(simplex) → Color Ramp → Pixel Grid(43) → Output
 * - Simplex noise via FBM (1 octave), quantized to 344px cells (8×8 dots per cell)
 * - Large 43px visible pixels, square shape, Bayer dithered
 * - Cobalt Drift palette
 */
export function createSpectraSimplexFBM(): {
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
} {
  const nodes: Node<NodeData>[] = [
    // Quantize UV → FBM.coords (1st input) — top of column 0
    {
      id: 'sp2-quv',
      type: 'shaderNode',
      position: { x: 0, y: 0 },
      data: {
        type: 'quantize_uv',
        params: { pixelSize: 344 },
      },
    },
    // Time → FBM.phase (2nd input) — middle of column 0
    {
      id: 'sp2-time',
      type: 'shaderNode',
      position: { x: 0, y: 140 },
      data: { type: 'time', params: { speed: 0.25 } },
    },
    // Simplex noise fnref → FBM.noiseFn (3rd input) — bottom of column 0
    {
      id: 'sp2-noise-ref',
      type: 'shaderNode',
      position: { x: 0, y: 280 },
      data: {
        type: 'noise',
        params: { scale: 1.0, noiseType: 'simplex' },
      },
    },
    // FBM: 1 octave = single noise pass (coords from Quantize UV)
    {
      id: 'sp2-fbm',
      type: 'shaderNode',
      position: { x: 280, y: 40 },
      data: {
        type: 'fbm',
        params: { scale: 1.0, fractalMode: 'standard', octaves: 1, lacunarity: 2.0, gain: 0.5 },
      },
    },
    // Muted Cobalt Drift ramp — spectra uses only dark-to-mid blue range
    {
      id: 'sp2-ramp',
      type: 'shaderNode',
      position: { x: 560, y: 40 },
      data: {
        type: 'color_ramp',
        params: {
          interpolation: 'smooth',
          stops: [
            { position: 0.0, color: [0.137, 0.231, 0.416] },
            { position: 0.5, color: [0.186, 0.333, 0.710] },
            { position: 1.0, color: [0.300, 0.500, 1.000] },
          ],
        },
      },
    },
    // Pixel Grid: 43px visible pixels, square, binary threshold
    {
      id: 'sp2-pixel',
      type: 'shaderNode',
      position: { x: 840, y: 40 },
      data: {
        type: 'pixel_grid',
        params: { pixelSize: 43, shape: 'square', threshold: 1.0 },
      },
    },
    {
      id: 'sp2-output',
      type: 'shaderNode',
      position: { x: 1100, y: 40 },
      data: { type: 'fragment_output', params: {} },
    },
  ]

  const edges: Edge<EdgeData>[] = [
    // Quantize UV → FBM coords (344px noise cells)
    {
      id: 'sp2-e0', source: 'sp2-quv', target: 'sp2-fbm',
      sourceHandle: 'uv', targetHandle: 'coords', type: 'typed',
      data: { sourcePort: 'uv', targetPort: 'coords', sourcePortType: 'vec2' },
    },
    // Noise(simplex).fn → FBM.noiseFn (fnref)
    {
      id: 'sp2-e1', source: 'sp2-noise-ref', target: 'sp2-fbm',
      sourceHandle: 'fn', targetHandle: 'noiseFn', type: 'typed',
      data: { sourcePort: 'fn', targetPort: 'noiseFn', sourcePortType: 'fnref' },
    },
    // Time → FBM.phase
    {
      id: 'sp2-e2', source: 'sp2-time', target: 'sp2-fbm',
      sourceHandle: 'time', targetHandle: 'phase', type: 'typed',
      data: { sourcePort: 'time', targetPort: 'phase', sourcePortType: 'float' },
    },
    // FBM.value → Color Ramp.t
    {
      id: 'sp2-e3', source: 'sp2-fbm', target: 'sp2-ramp',
      sourceHandle: 'value', targetHandle: 't', type: 'typed',
      data: { sourcePort: 'value', targetPort: 't', sourcePortType: 'float' },
    },
    // FBM.value → Pixel Grid.threshold
    {
      id: 'sp2-e4', source: 'sp2-fbm', target: 'sp2-pixel',
      sourceHandle: 'value', targetHandle: 'threshold', type: 'typed',
      data: { sourcePort: 'value', targetPort: 'threshold', sourcePortType: 'float' },
    },
    // Color Ramp → Pixel Grid.color
    {
      id: 'sp2-e5', source: 'sp2-ramp', target: 'sp2-pixel',
      sourceHandle: 'color', targetHandle: 'color', type: 'typed',
      data: { sourcePort: 'color', targetPort: 'color', sourcePortType: 'vec3' },
    },
    // Pixel Grid → Fragment Output
    {
      id: 'sp2-e6', source: 'sp2-pixel', target: 'sp2-output',
      sourceHandle: 'result', targetHandle: 'color', type: 'typed',
      data: { sourcePort: 'result', targetPort: 'color', sourcePortType: 'vec3' },
    },
  ]

  return { nodes: layoutGraph(nodes, edges), edges }
}

/**
 * Spectra preset: Worley Ridged
 * Pipeline: Quantize UV(28) → UV Transform(scale=0.1, offset=seed) → Domain Warp(0.2) →
 *           FBM(worley, ridged, 1.0) → Smoothstep(0.2,0.8) → Color Ramp + Pixel Grid(3.5) → Output
 *
 * Spectra params matched exactly:
 * - foldScale=0.1 → UV Transform scale
 * - seed=[95.7, 79.98] → UV Transform offset
 * - warpStrength=0.2 → Domain Warp strength
 * - octaves=1, gain=0, lacunarity=2 → FBM params
 * - min=0.2, max=0.8 → Smoothstep range compression
 * - speed=0.00001 → Time node (near-static)
 * - 28px noise cells (cellPixelSize = 8 × 3.5), 3.5px visible pixels
 */
export function createSpectraWorleyRidged(): {
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
} {
  const nodes: Node<NodeData>[] = [
    // === Main chain — cascading Y for horizontal output→input wires ===
    // Traced backward from Fragment Output: each node's output aligns with target's input
    {
      id: 'sp3-quv',
      type: 'shaderNode',
      position: { x: 0, y: 234 },
      data: {
        type: 'quantize_uv',
        params: { pixelSize: 28 },
      },
    },
    {
      id: 'sp3-uvt',
      type: 'shaderNode',
      position: { x: 260, y: 206 },
      data: {
        type: 'uv_transform',
        params: { scaleX: 0.1, scaleY: 0.1, offsetX: 95.7, offsetY: 79.98 },
      },
    },
    {
      id: 'sp3-warp',
      type: 'shaderNode',
      position: { x: 520, y: 156 },
      data: {
        type: 'domain_warp',
        params: { strength: 0.2, frequency: 1.0 },
      },
    },
    {
      id: 'sp3-fbm',
      type: 'shaderNode',
      position: { x: 780, y: 128 },
      data: {
        type: 'fbm',
        params: { scale: 1.0, fractalMode: 'ridged', octaves: 1, lacunarity: 2.0, gain: 0.1 },
      },
    },
    {
      id: 'sp3-smooth',
      type: 'shaderNode',
      position: { x: 1040, y: 56 },
      data: { type: 'smoothstep', params: {} },
    },
    {
      id: 'sp3-ramp',
      type: 'shaderNode',
      position: { x: 1300, y: 28 },
      data: {
        type: 'color_ramp',
        params: {
          interpolation: 'smooth',
          stops: [
            { position: 0.0, color: [0.137, 0.231, 0.416] },
            { position: 0.5, color: [0.186, 0.333, 0.710] },
            { position: 1.0, color: [0.300, 0.500, 1.000] },
          ],
        },
      },
    },
    {
      id: 'sp3-pixel',
      type: 'shaderNode',
      position: { x: 1560, y: 0 },
      data: {
        type: 'pixel_grid',
        params: { pixelSize: 3.5, shape: 'square', threshold: 1.0 },
      },
    },
    {
      id: 'sp3-output',
      type: 'shaderNode',
      position: { x: 1800, y: 0 },
      data: { type: 'fragment_output', params: {} },
    },

    // === Aux: above main chain (feed upper inputs on target) ===
    // Number(0.2) → Smoothstep.edge0 (1st input) — sub-column between FBM and SS
    {
      id: 'sp3-edge0',
      type: 'shaderNode',
      position: { x: 900, y: -20 },
      data: { type: 'float_constant', params: { value: 0.2 } },
    },
    // Number(0.8) → Smoothstep.edge1 (2nd input) — below 0.2, still above SS.x level
    {
      id: 'sp3-edge1',
      type: 'shaderNode',
      position: { x: 900, y: 56 },
      data: { type: 'float_constant', params: { value: 0.8 } },
    },

    // === Aux: below main chain (feed lower inputs on target) ===
    // Time → Domain Warp.phase (2nd input, below coords)
    {
      id: 'sp3-time',
      type: 'shaderNode',
      position: { x: 520, y: 490 },
      data: { type: 'time', params: { speed: 0.0001 } },
    },
    // Worley noise → FBM.noiseFn (3rd input, below coords/phase)
    {
      id: 'sp3-noise-ref',
      type: 'shaderNode',
      position: { x: 780, y: 530 },
      data: {
        type: 'noise',
        params: { scale: 1.0, noiseType: 'worley2d' },
      },
    },
  ]

  const edges: Edge<EdgeData>[] = [
    // Quantize UV → UV Transform.coords
    {
      id: 'sp3-e0a', source: 'sp3-quv', target: 'sp3-uvt',
      sourceHandle: 'uv', targetHandle: 'coords', type: 'typed',
      data: { sourcePort: 'uv', targetPort: 'coords', sourcePortType: 'vec2' },
    },
    // UV Transform → Domain Warp.coords (scaled + seeded)
    {
      id: 'sp3-e0b', source: 'sp3-uvt', target: 'sp3-warp',
      sourceHandle: 'uv', targetHandle: 'coords', type: 'typed',
      data: { sourcePort: 'uv', targetPort: 'coords', sourcePortType: 'vec2' },
    },
    // Domain Warp.warped → FBM.coords
    {
      id: 'sp3-ew', source: 'sp3-warp', target: 'sp3-fbm',
      sourceHandle: 'warped', targetHandle: 'coords', type: 'typed',
      data: { sourcePort: 'warped', targetPort: 'coords', sourcePortType: 'vec2' },
    },
    // Noise(worley).fn → FBM.noiseFn (fnref)
    {
      id: 'sp3-e1', source: 'sp3-noise-ref', target: 'sp3-fbm',
      sourceHandle: 'fn', targetHandle: 'noiseFn', type: 'typed',
      data: { sourcePort: 'fn', targetPort: 'noiseFn', sourcePortType: 'fnref' },
    },
    // Time → Domain Warp.phase (3D warp displaces phase too)
    {
      id: 'sp3-et', source: 'sp3-time', target: 'sp3-warp',
      sourceHandle: 'time', targetHandle: 'phase', type: 'typed',
      data: { sourcePort: 'time', targetPort: 'phase', sourcePortType: 'float' },
    },
    // Domain Warp.warpedPhase → FBM.phase (spatially-varying phase from 3D warp)
    {
      id: 'sp3-e2', source: 'sp3-warp', target: 'sp3-fbm',
      sourceHandle: 'warpedPhase', targetHandle: 'phase', type: 'typed',
      data: { sourcePort: 'warpedPhase', targetPort: 'phase', sourcePortType: 'float' },
    },
    // Number(0.2) → Smoothstep.edge0
    {
      id: 'sp3-es0', source: 'sp3-edge0', target: 'sp3-smooth',
      sourceHandle: 'value', targetHandle: 'edge0', type: 'typed',
      data: { sourcePort: 'value', targetPort: 'edge0', sourcePortType: 'float' },
    },
    // Number(0.8) → Smoothstep.edge1
    {
      id: 'sp3-es1', source: 'sp3-edge1', target: 'sp3-smooth',
      sourceHandle: 'value', targetHandle: 'edge1', type: 'typed',
      data: { sourcePort: 'value', targetPort: 'edge1', sourcePortType: 'float' },
    },
    // FBM.value → Smoothstep.x
    {
      id: 'sp3-e3a', source: 'sp3-fbm', target: 'sp3-smooth',
      sourceHandle: 'value', targetHandle: 'x', type: 'typed',
      data: { sourcePort: 'value', targetPort: 'x', sourcePortType: 'float' },
    },
    // Smoothstep.result → Color Ramp.t
    {
      id: 'sp3-e3', source: 'sp3-smooth', target: 'sp3-ramp',
      sourceHandle: 'result', targetHandle: 't', type: 'typed',
      data: { sourcePort: 'result', targetPort: 't', sourcePortType: 'float' },
    },
    // Smoothstep.result → Pixel Grid.threshold
    {
      id: 'sp3-e4', source: 'sp3-smooth', target: 'sp3-pixel',
      sourceHandle: 'result', targetHandle: 'threshold', type: 'typed',
      data: { sourcePort: 'result', targetPort: 'threshold', sourcePortType: 'float' },
    },
    // Color Ramp → Pixel Grid.color
    {
      id: 'sp3-e5', source: 'sp3-ramp', target: 'sp3-pixel',
      sourceHandle: 'color', targetHandle: 'color', type: 'typed',
      data: { sourcePort: 'color', targetPort: 'color', sourcePortType: 'vec3' },
    },
    // Pixel Grid → Fragment Output
    {
      id: 'sp3-e6', source: 'sp3-pixel', target: 'sp3-output',
      sourceHandle: 'result', targetHandle: 'color', type: 'typed',
      data: { sourcePort: 'result', targetPort: 'color', sourcePortType: 'vec3' },
    },
  ]

  return { nodes: layoutGraph(nodes, edges), edges }
}

/**
 * Spectra preset: Box None
 * Pipeline: Quantize UV(104) → UV Transform(scale=0.5, offset=seed) → Domain Warp(strength=5) →
 *           Noise(box, boxFreq=201) → Smoothstep(0.2,0.8) → Color Ramp + Pixel Grid(13) → Output
 *
 * Spectra params:
 * - foldScale=0.5 → UV Transform scale
 * - seed=[42.3, 167.5] → UV Transform offset
 * - foldIntensity=2 → pixelSize = 3.0 + 2×5.0 = 13, cellPixelSize = 8×13 = 104
 * - noiseType=box, fractalType=none → raw box noise, no FBM
 * - boxFreq=201 → extremely fine hash grid
 * - warpStrength=5 → heavy domain warp
 * - speed=5 → fast animation
 * - min=0.2, max=0.8 → Smoothstep range compression
 * - colors=Cobalt Drift (default)
 */
export function createSpectraBoxNone(): {
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
} {
  const nodes: Node<NodeData>[] = [
    // Quantize UV: 104px cells (8×13) — pixelSize only
    {
      id: 'sp4-quv',
      type: 'shaderNode',
      position: { x: 0, y: 0 },
      data: {
        type: 'quantize_uv',
        params: { pixelSize: 104 },
      },
    },
    // UV Transform: scale=0.5 (spectra foldScale), offset=seed
    {
      id: 'sp4-uvt',
      type: 'shaderNode',
      position: { x: 150, y: 0 },
      data: {
        type: 'uv_transform',
        params: { scaleX: 0.5, scaleY: 0.5, offsetX: 42.3, offsetY: 167.5 },
      },
    },
    // Domain Warp: heavy distortion (spectra warpStrength=5)
    {
      id: 'sp4-warp',
      type: 'shaderNode',
      position: { x: 300, y: 0 },
      data: {
        type: 'domain_warp',
        params: { strength: 5.0, frequency: 1.0 },
      },
    },
    {
      id: 'sp4-time',
      type: 'shaderNode',
      position: { x: 0, y: 220 },
      data: { type: 'time', params: { speed: 5.0 } },
    },
    // Box noise: raw (no FBM), boxFreq=201
    {
      id: 'sp4-noise',
      type: 'shaderNode',
      position: { x: 600, y: 0 },
      data: {
        type: 'noise',
        params: { scale: 1.0, noiseType: 'box', boxFreq: 201 },
      },
    },
    // Smoothstep range compression: smoothstep(0.2, 0.8, noise)
    {
      id: 'sp4-edge0',
      type: 'shaderNode',
      position: { x: 600, y: 220 },
      data: { type: 'float_constant', params: { value: 0.2 } },
    },
    {
      id: 'sp4-edge1',
      type: 'shaderNode',
      position: { x: 600, y: 340 },
      data: { type: 'float_constant', params: { value: 0.8 } },
    },
    {
      id: 'sp4-smooth',
      type: 'shaderNode',
      position: { x: 900, y: 0 },
      data: { type: 'smoothstep', params: {} },
    },
    // Cobalt Drift ramp
    {
      id: 'sp4-ramp',
      type: 'shaderNode',
      position: { x: 1200, y: 0 },
      data: {
        type: 'color_ramp',
        params: {
          interpolation: 'smooth',
          stops: [
            { position: 0.0, color: [0.137, 0.231, 0.416] },
            { position: 0.5, color: [0.186, 0.333, 0.710] },
            { position: 1.0, color: [0.300, 0.500, 1.000] },
          ],
        },
      },
    },
    // Pixel Grid: 13px visible pixels, square
    {
      id: 'sp4-pixel',
      type: 'shaderNode',
      position: { x: 1500, y: 0 },
      data: {
        type: 'pixel_grid',
        params: { pixelSize: 13, shape: 'square', threshold: 1.0 },
      },
    },
    {
      id: 'sp4-output',
      type: 'shaderNode',
      position: { x: 1800, y: 60 },
      data: { type: 'fragment_output', params: {} },
    },
  ]

  const edges: Edge<EdgeData>[] = [
    // Quantize UV → UV Transform.coords
    {
      id: 'sp4-e0a', source: 'sp4-quv', target: 'sp4-uvt',
      sourceHandle: 'uv', targetHandle: 'coords', type: 'typed',
      data: { sourcePort: 'uv', targetPort: 'coords', sourcePortType: 'vec2' },
    },
    // UV Transform → Domain Warp.coords (scaled + seeded)
    {
      id: 'sp4-e0b', source: 'sp4-uvt', target: 'sp4-warp',
      sourceHandle: 'uv', targetHandle: 'coords', type: 'typed',
      data: { sourcePort: 'uv', targetPort: 'coords', sourcePortType: 'vec2' },
    },
    // Time → Domain Warp.phase
    {
      id: 'sp4-et1', source: 'sp4-time', target: 'sp4-warp',
      sourceHandle: 'time', targetHandle: 'phase', type: 'typed',
      data: { sourcePort: 'time', targetPort: 'phase', sourcePortType: 'float' },
    },
    // Domain Warp.warped → Noise.coords
    {
      id: 'sp4-ew', source: 'sp4-warp', target: 'sp4-noise',
      sourceHandle: 'warped', targetHandle: 'coords', type: 'typed',
      data: { sourcePort: 'warped', targetPort: 'coords', sourcePortType: 'vec2' },
    },
    // Time → Noise.phase
    {
      id: 'sp4-et2', source: 'sp4-time', target: 'sp4-noise',
      sourceHandle: 'time', targetHandle: 'phase', type: 'typed',
      data: { sourcePort: 'time', targetPort: 'phase', sourcePortType: 'float' },
    },
    // Number(0.2) → Smoothstep.edge0
    {
      id: 'sp4-es0', source: 'sp4-edge0', target: 'sp4-smooth',
      sourceHandle: 'value', targetHandle: 'edge0', type: 'typed',
      data: { sourcePort: 'value', targetPort: 'edge0', sourcePortType: 'float' },
    },
    // Number(0.8) → Smoothstep.edge1
    {
      id: 'sp4-es1', source: 'sp4-edge1', target: 'sp4-smooth',
      sourceHandle: 'value', targetHandle: 'edge1', type: 'typed',
      data: { sourcePort: 'value', targetPort: 'edge1', sourcePortType: 'float' },
    },
    // Noise.value → Smoothstep.x
    {
      id: 'sp4-e3a', source: 'sp4-noise', target: 'sp4-smooth',
      sourceHandle: 'value', targetHandle: 'x', type: 'typed',
      data: { sourcePort: 'value', targetPort: 'x', sourcePortType: 'float' },
    },
    // Smoothstep.result → Color Ramp.t
    {
      id: 'sp4-e3', source: 'sp4-smooth', target: 'sp4-ramp',
      sourceHandle: 'result', targetHandle: 't', type: 'typed',
      data: { sourcePort: 'result', targetPort: 't', sourcePortType: 'float' },
    },
    // Smoothstep.result → Pixel Grid.threshold
    {
      id: 'sp4-e4', source: 'sp4-smooth', target: 'sp4-pixel',
      sourceHandle: 'result', targetHandle: 'threshold', type: 'typed',
      data: { sourcePort: 'result', targetPort: 'threshold', sourcePortType: 'float' },
    },
    // Color Ramp → Pixel Grid.color
    {
      id: 'sp4-e5', source: 'sp4-ramp', target: 'sp4-pixel',
      sourceHandle: 'color', targetHandle: 'color', type: 'typed',
      data: { sourcePort: 'color', targetPort: 'color', sourcePortType: 'vec3' },
    },
    // Pixel Grid → Fragment Output
    {
      id: 'sp4-e6', source: 'sp4-pixel', target: 'sp4-output',
      sourceHandle: 'result', targetHandle: 'color', type: 'typed',
      data: { sourcePort: 'result', targetPort: 'color', sourcePortType: 'vec3' },
    },
  ]

  return { nodes: layoutGraph(nodes, edges), edges }
}

/**
 * Create animated noise test graph:
 * Time → Simplex Noise (phase) → Fragment Output
 * Noise uses auto_uv for coordinates when unconnected.
 */
export function createNoiseTestGraph(): {
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
} {
  const timeNode: Node<NodeData> = {
    id: 'noise-time',
    type: 'shaderNode',
    position: { x: 50, y: 150 },
    data: {
      type: 'time',
      params: {},
    },
  }

  const noiseNode: Node<NodeData> = {
    id: 'noise-simplex',
    type: 'shaderNode',
    position: { x: 300, y: 120 },
    data: {
      type: 'noise',
      params: {
        scale: 5.0,
        noiseType: 'simplex',
      },
    },
  }

  const outputNode: Node<NodeData> = {
    id: 'noise-output',
    type: 'shaderNode',
    position: { x: 550, y: 120 },
    data: {
      type: 'fragment_output',
      params: {},
    },
  }

  const edges: Edge<EdgeData>[] = [
    {
      id: 'edge-time-noise',
      source: 'noise-time',
      target: 'noise-simplex',
      sourceHandle: 'time',
      targetHandle: 'phase',
      type: 'typed',
      data: { sourcePort: 'time', targetPort: 'phase', sourcePortType: 'float' },
    },
    {
      id: 'edge-noise-output',
      source: 'noise-simplex',
      target: 'noise-output',
      sourceHandle: 'value',
      targetHandle: 'color',
      type: 'typed',
      data: { sourcePort: 'value', targetPort: 'color', sourcePortType: 'float' },
    },
  ]

  return {
    nodes: [timeNode, noiseNode, outputNode],
    edges,
  }
}
