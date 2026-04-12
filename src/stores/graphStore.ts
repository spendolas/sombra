/**
 * Graph store - manages nodes and edges for the shader graph
 * Includes basic undo/redo for add/remove node/edge operations.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Node, Edge, OnNodesChange, OnEdgesChange } from '@xyflow/react'
import { applyNodeChanges, applyEdgeChanges } from '@xyflow/react'
import type { NodeData, EdgeData } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'

/** Schema version — bump when persisted shape changes */
const GRAPH_SCHEMA_VERSION = 3

/** Renamed node types — applied on localStorage load */
const TYPE_RENAMES: Record<string, string> = {
  'warp_uv': 'warp',
  'domain_warp': 'warp',
  'quantize_uv': 'pixelate',
  'quantize': 'pixelate',
}

const MAX_HISTORY = 50

interface HistoryEntry {
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
}

/**
 * Graph state interface
 */
interface GraphState {
  // React Flow nodes and edges
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]

  // Selection
  selectedNodeIds: string[]
  selectedEdgeIds: string[]

  // Undo/redo
  _past: HistoryEntry[]
  _future: HistoryEntry[]
  canUndo: boolean
  canRedo: boolean
  undo: () => void
  redo: () => void

  // Actions
  setNodes: (nodes: Node<NodeData>[]) => void
  setEdges: (edges: Edge<EdgeData>[]) => void
  onNodesChange: OnNodesChange<Node<NodeData>>
  onEdgesChange: OnEdgesChange<Edge<EdgeData>>

  addNode: (node: Node<NodeData>) => void
  removeNode: (nodeId: string) => void
  updateNodeData: (nodeId: string, data: Partial<NodeData>) => void

  addEdge: (edge: Edge<EdgeData>) => void
  removeEdge: (edgeId: string) => void

  setSelectedNodes: (nodeIds: string[]) => void
  setSelectedEdges: (edgeIds: string[]) => void
  clearSelection: () => void

  // Graph loading
  loadGraph: (nodes: Node<NodeData>[], edges: Edge<EdgeData>[]) => void

  // Utility
  getNode: (nodeId: string) => Node<NodeData> | undefined
  getEdge: (edgeId: string) => Edge<EdgeData> | undefined
  clear: () => void
}

/** Snapshot current graph state for undo stack */
function snapshot(state: GraphState): HistoryEntry {
  return { nodes: state.nodes, edges: state.edges }
}

/** Push a snapshot to the past stack, capped at MAX_HISTORY */
function pushHistory(past: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  const next = [...past, entry]
  return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next
}

/**
 * Graph store - manages the shader node graph
 */
export const useGraphStore = create<GraphState>()(
  persist(
    (set, get) => ({
      nodes: [],
      edges: [],
      selectedNodeIds: [],
      selectedEdgeIds: [],

      _past: [],
      _future: [],
      canUndo: false,
      canRedo: false,

      undo: () => {
        const { _past, _future, nodes, edges } = get()
        if (_past.length === 0) return
        const prev = _past[_past.length - 1]
        set({
          nodes: prev.nodes,
          edges: prev.edges,
          _past: _past.slice(0, -1),
          _future: [..._future, { nodes, edges }],
          canUndo: _past.length > 1,
          canRedo: true,
        })
      },

      redo: () => {
        const { _past, _future, nodes, edges } = get()
        if (_future.length === 0) return
        const next = _future[_future.length - 1]
        set({
          nodes: next.nodes,
          edges: next.edges,
          _past: [..._past, { nodes, edges }],
          _future: _future.slice(0, -1),
          canUndo: true,
          canRedo: _future.length > 1,
        })
      },

      setNodes: (nodes) => set({ nodes }),
      setEdges: (edges) => set({ edges }),

      onNodesChange: (changes) => {
        const hasRemoves = changes.some((c) => c.type === 'remove')
        const state = get()
        if (hasRemoves) {
          const past = pushHistory(state._past, snapshot(state))
          set({
            nodes: applyNodeChanges(changes, state.nodes),
            _past: past,
            _future: [],
            canUndo: true,
            canRedo: false,
          })
        } else {
          set({ nodes: applyNodeChanges(changes, state.nodes) })
        }
      },

      onEdgesChange: (changes) => {
        const hasRemoves = changes.some((c) => c.type === 'remove')
        const state = get()
        if (hasRemoves) {
          const past = pushHistory(state._past, snapshot(state))
          set({
            edges: applyEdgeChanges(changes, state.edges),
            _past: past,
            _future: [],
            canUndo: true,
            canRedo: false,
          })
        } else {
          set({ edges: applyEdgeChanges(changes, state.edges) })
        }
      },

      addNode: (node) => {
        const state = get()
        const past = pushHistory(state._past, snapshot(state))
        set({
          nodes: [...state.nodes, node],
          _past: past,
          _future: [],
          canUndo: true,
          canRedo: false,
        })
      },

      removeNode: (nodeId) => {
        const state = get()
        const past = pushHistory(state._past, snapshot(state))
        set({
          nodes: state.nodes.filter((n) => n.id !== nodeId),
          edges: state.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
          selectedNodeIds: state.selectedNodeIds.filter((id) => id !== nodeId),
          _past: past,
          _future: [],
          canUndo: true,
          canRedo: false,
        })
      },

      updateNodeData: (nodeId, data) => {
        set((state) => ({
          nodes: state.nodes.map((node) =>
            node.id === nodeId
              ? { ...node, data: { ...node.data, ...data } }
              : node
          ),
        }))
      },

      addEdge: (edge) => {
        const state = get()
        const past = pushHistory(state._past, snapshot(state))
        set({
          edges: [...state.edges, edge],
          _past: past,
          _future: [],
          canUndo: true,
          canRedo: false,
        })
      },

      removeEdge: (edgeId) => {
        const state = get()
        const past = pushHistory(state._past, snapshot(state))
        set({
          edges: state.edges.filter((e) => e.id !== edgeId),
          selectedEdgeIds: state.selectedEdgeIds.filter((id) => id !== edgeId),
          _past: past,
          _future: [],
          canUndo: true,
          canRedo: false,
        })
      },

      setSelectedNodes: (nodeIds) => set({ selectedNodeIds: nodeIds }),
      setSelectedEdges: (edgeIds) => set({ selectedEdgeIds: edgeIds }),
      clearSelection: () => set({ selectedNodeIds: [], selectedEdgeIds: [] }),

      loadGraph: (nodes, edges) => {
        const state = get()
        const past = pushHistory(state._past, snapshot(state))
        set({
          nodes,
          edges,
          selectedNodeIds: [],
          selectedEdgeIds: [],
          _past: past,
          _future: [],
          canUndo: true,
          canRedo: false,
        })
      },

      getNode: (nodeId) => get().nodes.find((n) => n.id === nodeId),
      getEdge: (edgeId) => get().edges.find((e) => e.id === edgeId),

      clear: () => {
        const state = get()
        const past = pushHistory(state._past, snapshot(state))
        set({
          nodes: [],
          edges: [],
          selectedNodeIds: [],
          selectedEdgeIds: [],
          _past: past,
          _future: [],
          canUndo: true,
          canRedo: false,
        })
      },
    }),
    {
      name: 'sombra-graph',
      version: GRAPH_SCHEMA_VERSION,
      migrate: (persisted: unknown) => {
        const state = persisted as { nodes?: Node<NodeData>[]; edges?: Edge<EdgeData>[] }
        if (state.nodes) {
          for (const node of state.nodes) {
            if (node.data.type in TYPE_RENAMES) {
              node.data.type = TYPE_RENAMES[node.data.type]
            }
          }
        }
        // Strip edges targeting handles that no longer exist on their target node.
        // Handles removed param renames/removals (e.g. boxFreq → removed "frequency").
        if (state.nodes && state.edges) {
          const nodeMap = new Map(state.nodes.map(n => [n.id, n]))
          state.edges = state.edges.filter(edge => {
            const targetNode = nodeMap.get(edge.target)
            if (!targetNode) return true // orphan edge — let React Flow handle it
            const def = nodeRegistry.get(targetNode.data.type)
            if (!def) return true // unknown type — keep edge, node will error separately
            const validHandles = new Set([
              ...def.inputs.map(i => i.id),
              ...def.outputs.map(o => o.id),
              ...(def.params?.filter(p => p.connectable).map(p => p.id) ?? []),
              ...(def.dynamicInputs?.(targetNode.data.params || {}).map(i => i.id) ?? []),
            ])
            if (edge.targetHandle && !validHandles.has(edge.targetHandle)) return false
            if (edge.sourceHandle) {
              const sourceNode = nodeMap.get(edge.source)
              if (sourceNode) {
                const sourceDef = nodeRegistry.get(sourceNode.data.type)
                if (sourceDef) {
                  const sourceHandles = new Set([
                    ...sourceDef.outputs.map(o => o.id),
                    ...sourceDef.inputs.map(i => i.id),
                  ])
                  if (!sourceHandles.has(edge.sourceHandle)) return false
                }
              }
            }
            return true
          })
        }
        return state
      },
      partialize: (state) => ({
        // Strip large binary data (imageData) from persistence to avoid localStorage quota
        nodes: state.nodes.map(n => {
          if (!n.data.params?.imageData) return n
          const { imageData: _, ...restParams } = n.data.params as Record<string, unknown>
          return { ...n, data: { ...n.data, params: restParams } }
        }),
        edges: state.edges,
      }),
    }
  )
)
