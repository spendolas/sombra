/**
 * Dev bridge — exposes Sombra internals on window.__sombra
 * so the Claude Chrome extension (or any browser console) can
 * programmatically create, wire, and manipulate nodes.
 *
 * Loaded once in main.tsx after the node library initialises.
 */

import { useGraphStore } from './stores/graphStore'
import { useCompilerStore } from './stores/compilerStore'
import { useSettingsStore } from './stores/settingsStore'
import { nodeRegistry } from './nodes/registry'
import { compileGraph } from './compiler/glsl-generator'
import type { NodeData, EdgeData, PortType } from './nodes/types'
import type { Node, Edge } from '@xyflow/react'

/* ------------------------------------------------------------------ */
/*  Helper: unique ID generator                                       */
/* ------------------------------------------------------------------ */

let _counter = 0
function uid(prefix = 'n'): string {
  return `${prefix}_${Date.now().toString(36)}_${(++_counter).toString(36)}`
}

/* ------------------------------------------------------------------ */
/*  High-level helpers that wrap the raw store calls                   */
/* ------------------------------------------------------------------ */

/**
 * Create a node and add it to the graph.
 * Returns the new node's ID.
 *
 * @example
 *   sombra.createNode('noise', { x: 200, y: 100 }, { scale: 8 })
 */
function createNode(
  type: string,
  position: { x: number; y: number } = { x: 0, y: 0 },
  paramOverrides: Record<string, unknown> = {},
): string {
  const def = nodeRegistry.get(type)
  if (!def) throw new Error(`Unknown node type: "${type}". Use sombra.listNodeTypes() to see available types.`)

  // Build default params from definition
  const params: Record<string, unknown> = {}
  for (const p of def.params ?? []) {
    params[p.id] = p.default
  }
  Object.assign(params, paramOverrides)

  const id = uid('n')
  const node: Node<NodeData> = {
    id,
    type: 'shaderNode',
    position,
    data: { type, params },
  }
  useGraphStore.getState().addNode(node)
  return id
}

/**
 * Connect two nodes.
 * Returns the new edge ID.
 *
 * sourcePort / targetPort default to the first output / first input
 * of the respective node definitions when omitted.
 *
 * @example
 *   sombra.connect(noiseId, outputId)                     // first output → first input
 *   sombra.connect(noiseId, mixId, 'value', 'a')          // explicit ports
 */
function connect(
  sourceId: string,
  targetId: string,
  sourcePort?: string,
  targetPort?: string,
): string {
  const graph = useGraphStore.getState()
  const sourceNode = graph.getNode(sourceId)
  const targetNode = graph.getNode(targetId)
  if (!sourceNode) throw new Error(`Source node "${sourceId}" not found`)
  if (!targetNode) throw new Error(`Target node "${targetId}" not found`)

  const srcDef = nodeRegistry.get(sourceNode.data.type as string)
  const tgtDef = nodeRegistry.get(targetNode.data.type as string)
  if (!srcDef) throw new Error(`No definition for source type "${sourceNode.data.type}"`)
  if (!tgtDef) throw new Error(`No definition for target type "${targetNode.data.type}"`)

  // Resolve ports
  const srcPort = sourcePort ?? srcDef.outputs[0]?.id
  const tgtPort = targetPort ?? (tgtDef.dynamicInputs
    ? tgtDef.dynamicInputs(targetNode.data.params as Record<string, unknown>)[0]?.id
    : tgtDef.inputs[0]?.id)

  if (!srcPort) throw new Error(`Source node "${srcDef.type}" has no outputs`)
  if (!tgtPort) throw new Error(`Target node "${tgtDef.type}" has no inputs`)

  // Look up source port type for edge coloring
  const srcPortDef = srcDef.outputs.find(p => p.id === srcPort)
  const srcPortType: PortType = (srcPortDef?.type ?? 'float') as PortType

  // Remove any existing edge into this target handle (single-wire-per-input)
  const existing = graph.edges.find(
    e => e.target === targetId && e.targetHandle === tgtPort
  )
  if (existing) graph.removeEdge(existing.id)

  const id = uid('e')
  const edge: Edge<EdgeData> = {
    id,
    source: sourceId,
    target: targetId,
    sourceHandle: srcPort,
    targetHandle: tgtPort,
    type: 'typed',
    data: {
      sourcePort: srcPort,
      targetPort: tgtPort,
      sourcePortType: srcPortType,
    },
  }
  graph.addEdge(edge)
  return id
}

/**
 * Update params on an existing node.
 *
 * @example
 *   sombra.setParams(noiseId, { scale: 12, noiseType: 'worley' })
 */
function setParams(nodeId: string, params: Record<string, unknown>): void {
  const node = useGraphStore.getState().getNode(nodeId)
  if (!node) throw new Error(`Node "${nodeId}" not found`)
  useGraphStore.getState().updateNodeData(nodeId, {
    params: { ...(node.data.params as Record<string, unknown>), ...params },
  })
}

/**
 * Move a node to a new position.
 */
function moveNode(nodeId: string, x: number, y: number): void {
  const state = useGraphStore.getState()
  state.setNodes(
    state.nodes.map(n => n.id === nodeId ? { ...n, position: { x, y } } : n)
  )
}

/**
 * Remove a node and all its edges.
 */
function removeNode(nodeId: string): void {
  useGraphStore.getState().removeNode(nodeId)
}

/**
 * Remove an edge by ID.
 */
function removeEdge(edgeId: string): void {
  useGraphStore.getState().removeEdge(edgeId)
}

/**
 * Clear the entire graph.
 */
function clearGraph(): void {
  useGraphStore.getState().clear()
}

/**
 * Manually trigger shader compilation and push results to the compiler store.
 * Returns the CompilationResult.
 */
function compile(): ReturnType<typeof compileGraph> {
  const { nodes, edges } = useGraphStore.getState()
  const result = compileGraph(nodes, edges)
  const cs = useCompilerStore.getState()
  if (result.success) {
    cs.setShaders(result.vertexShader, result.fragmentShader)
    cs.markCompileSuccess()
  } else {
    cs.setErrors(result.errors.map(e => ({
      message: e.message,
      nodeId: e.nodeId,
      severity: 'error' as const,
    })))
  }
  return result
}

/**
 * Snapshot current graph as a plain JSON object (nodes + edges).
 */
function exportGraph(): { nodes: Node<NodeData>[]; edges: Edge<EdgeData>[] } {
  const { nodes, edges } = useGraphStore.getState()
  return { nodes, edges }
}

/**
 * Load a graph from a snapshot (replaces current graph).
 */
function importGraph(graph: { nodes: Node<NodeData>[]; edges: Edge<EdgeData>[] }): void {
  const gs = useGraphStore.getState()
  gs.setNodes(graph.nodes)
  gs.setEdges(graph.edges)
}

/**
 * List all available node type IDs with their labels and categories.
 */
function listNodeTypes(): Array<{ type: string; label: string; category: string }> {
  return nodeRegistry.getAll().map(d => ({
    type: d.type,
    label: d.label,
    category: d.category,
  }))
}

/**
 * Get full definition of a node type (inputs, outputs, params).
 */
function describeNode(type: string) {
  const def = nodeRegistry.get(type)
  if (!def) throw new Error(`Unknown node type: "${type}"`)
  return {
    type: def.type,
    label: def.label,
    category: def.category,
    description: def.description,
    inputs: def.inputs.map(p => ({ id: p.id, label: p.label, type: p.type, default: p.default })),
    outputs: def.outputs.map(p => ({ id: p.id, label: p.label, type: p.type })),
    params: (def.params ?? []).map(p => ({
      id: p.id,
      label: p.label,
      type: p.type,
      default: p.default,
      min: p.min,
      max: p.max,
      step: p.step,
      options: p.options,
      connectable: p.connectable,
      showWhen: p.showWhen,
    })),
    hasDynamicInputs: !!def.dynamicInputs,
    hasFunctionKey: !!def.functionKey,
  }
}

/**
 * Describe the current graph: nodes with their types/params, edges with ports.
 */
function describeGraph() {
  const { nodes, edges } = useGraphStore.getState()
  return {
    nodes: nodes.map(n => ({
      id: n.id,
      type: (n.data as NodeData).type,
      position: n.position,
      params: (n.data as NodeData).params,
    })),
    edges: edges.map(e => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
    })),
  }
}

/**
 * Get the compiled fragment shader source (or null if not compiled yet).
 */
function getFragmentShader(): string | null {
  return useCompilerStore.getState().fragmentShader
}

/* ------------------------------------------------------------------ */
/*  Mount on window                                                   */
/* ------------------------------------------------------------------ */

export function installDevBridge(): void {
  const api = {
    // High-level helpers
    createNode,
    connect,
    setParams,
    moveNode,
    removeNode,
    removeEdge,
    clearGraph,
    compile,
    exportGraph,
    importGraph,
    listNodeTypes,
    describeNode,
    describeGraph,
    getFragmentShader,

    // Raw store access (for advanced use)
    stores: {
      graph: useGraphStore,
      compiler: useCompilerStore,
      settings: useSettingsStore,
    },

    // Registry
    registry: nodeRegistry,

    // Low-level compiler
    compileGraph,
  }

  ;(window as unknown as Record<string, unknown>).__sombra = api
  console.log('[Sombra] Dev bridge installed → window.__sombra')
}
