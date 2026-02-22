/**
 * Test graph utilities - for development and testing
 */

import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../nodes/types'

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
      type: 'uv_coords',
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
    // Value noise fnref source
    {
      id: 'sp-noise-ref',
      type: 'shaderNode',
      position: { x: 0, y: 0 },
      data: {
        type: 'noise',
        params: { scale: 1.0, noiseType: 'value' },
      },
    },
    {
      id: 'sp-time',
      type: 'shaderNode',
      position: { x: 0, y: 280 },
      data: { type: 'time', params: { speed: 0.5 } },
    },
    // FBM: 1 octave = single noise pass (auto_uv coords)
    {
      id: 'sp-fbm',
      type: 'shaderNode',
      position: { x: 300, y: 0 },
      data: {
        type: 'fbm',
        params: { scale: 1.0, fractalMode: 'standard', octaves: 1, lacunarity: 2.0, gain: 0.5 },
      },
    },
    // Cobalt Drift color ramp
    {
      id: 'sp-ramp',
      type: 'shaderNode',
      position: { x: 600, y: 0 },
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
      position: { x: 900, y: 0 },
      data: {
        type: 'pixel_grid',
        params: { pixelSize: 8, shape: 'square', threshold: 1.0 },
      },
    },
    {
      id: 'sp-output',
      type: 'shaderNode',
      position: { x: 1200, y: 60 },
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

  return { nodes, edges }
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
