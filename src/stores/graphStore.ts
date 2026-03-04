/**
 * Graph store - manages nodes and edges for the shader graph
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Node, Edge, OnNodesChange, OnEdgesChange } from '@xyflow/react'
import { applyNodeChanges, applyEdgeChanges } from '@xyflow/react'
import type { NodeData, EdgeData } from '../nodes/types'

/** Schema version — bump when persisted shape changes */
const GRAPH_SCHEMA_VERSION = 1

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

  // Utility
  getNode: (nodeId: string) => Node<NodeData> | undefined
  getEdge: (edgeId: string) => Edge<EdgeData> | undefined
  clear: () => void
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

      setNodes: (nodes) => set({ nodes }),
      setEdges: (edges) => set({ edges }),

      onNodesChange: (changes) => {
        set({
          nodes: applyNodeChanges(changes, get().nodes),
        })
      },

      onEdgesChange: (changes) => {
        set({
          edges: applyEdgeChanges(changes, get().edges),
        })
      },

      addNode: (node) => {
        set((state) => ({
          nodes: [...state.nodes, node],
        }))
      },

      removeNode: (nodeId) => {
        set((state) => ({
          nodes: state.nodes.filter((n) => n.id !== nodeId),
          edges: state.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
          selectedNodeIds: state.selectedNodeIds.filter((id) => id !== nodeId),
        }))
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
        set((state) => ({
          edges: [...state.edges, edge],
        }))
      },

      removeEdge: (edgeId) => {
        set((state) => ({
          edges: state.edges.filter((e) => e.id !== edgeId),
          selectedEdgeIds: state.selectedEdgeIds.filter((id) => id !== edgeId),
        }))
      },

      setSelectedNodes: (nodeIds) => set({ selectedNodeIds: nodeIds }),
      setSelectedEdges: (edgeIds) => set({ selectedEdgeIds: edgeIds }),
      clearSelection: () => set({ selectedNodeIds: [], selectedEdgeIds: [] }),

      getNode: (nodeId) => get().nodes.find((n) => n.id === nodeId),
      getEdge: (edgeId) => get().edges.find((e) => e.id === edgeId),

      clear: () => set({ nodes: [], edges: [], selectedNodeIds: [], selectedEdgeIds: [] }),
    }),
    {
      name: 'sombra-graph',
      version: GRAPH_SCHEMA_VERSION,
      partialize: (state) => ({
        nodes: state.nodes,
        edges: state.edges,
      }),
    }
  )
)
