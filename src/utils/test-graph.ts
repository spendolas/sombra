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
 * UV → Add (with Time for animation) → Simplex Noise → Fragment Output
 * This demonstrates live animated noise
 */
export function createNoiseTestGraph(): {
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
} {
  const uvNode: Node<NodeData> = {
    id: 'noise-uv',
    type: 'shaderNode',
    position: { x: 50, y: 100 },
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

  const addNode: Node<NodeData> = {
    id: 'noise-add',
    type: 'shaderNode',
    position: { x: 250, y: 160 },
    data: {
      type: 'add',
      params: {},
    },
  }

  const noiseNode: Node<NodeData> = {
    id: 'noise-simplex',
    type: 'shaderNode',
    position: { x: 450, y: 160 },
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
    position: { x: 650, y: 160 },
    data: {
      type: 'fragment_output',
      params: {},
    },
  }

  const edges: Edge<EdgeData>[] = [
    {
      id: 'edge-uv-add',
      source: 'noise-uv',
      target: 'noise-add',
      sourceHandle: 'uv',
      targetHandle: 'a',
      data: { sourcePort: 'uv', targetPort: 'a' },
    },
    {
      id: 'edge-time-add',
      source: 'noise-time',
      target: 'noise-add',
      sourceHandle: 'time',
      targetHandle: 'b',
      data: { sourcePort: 'time', targetPort: 'b' },
    },
    {
      id: 'edge-add-noise',
      source: 'noise-add',
      target: 'noise-simplex',
      sourceHandle: 'result',
      targetHandle: 'coords',
      data: { sourcePort: 'result', targetPort: 'coords' },
    },
    {
      id: 'edge-noise-output',
      source: 'noise-simplex',
      target: 'noise-output',
      sourceHandle: 'value',
      targetHandle: 'color',
      data: { sourcePort: 'value', targetPort: 'color' },
    },
  ]

  return {
    nodes: [uvNode, timeNode, addNode, noiseNode, outputNode],
    edges,
  }
}
