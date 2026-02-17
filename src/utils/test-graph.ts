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
 * Create animated noise test graph:
 * UV → Simplex Noise (coords), Time → Simplex Noise (z) → Fragment Output
 * Demonstrates 3D animated noise via the z input
 */
export function createNoiseTestGraph(): {
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
} {
  const uvNode: Node<NodeData> = {
    id: 'noise-uv',
    type: 'shaderNode',
    position: { x: 50, y: 80 },
    data: {
      type: 'uv_coords',
      params: {},
    },
  }

  const timeNode: Node<NodeData> = {
    id: 'noise-time',
    type: 'shaderNode',
    position: { x: 50, y: 220 },
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
      type: 'simplex_noise',
      params: {
        scale: 5.0,
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
      id: 'edge-uv-noise',
      source: 'noise-uv',
      target: 'noise-simplex',
      sourceHandle: 'uv',
      targetHandle: 'coords',
      type: 'typed',
      data: { sourcePort: 'uv', targetPort: 'coords', sourcePortType: 'vec2' },
    },
    {
      id: 'edge-time-noise',
      source: 'noise-time',
      target: 'noise-simplex',
      sourceHandle: 'time',
      targetHandle: 'z',
      type: 'typed',
      data: { sourcePort: 'time', targetPort: 'z', sourcePortType: 'float' },
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
    nodes: [uvNode, timeNode, noiseNode, outputNode],
    edges,
  }
}
