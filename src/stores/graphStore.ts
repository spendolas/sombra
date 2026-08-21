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
import { dedupeNodeIds } from '../utils/node-id'
import { migrateOffsetSpace } from '../utils/srt-migration'
import { anchorToVec2 } from '../nodes/output/fragment-output'
import { REFERENCE_SIZE } from '../renderer/constants'
import { previewCanvasSize } from '../utils/preview-canvas-size'

/** Schema version — bump when persisted shape changes.
 *  v4: one-time dedupe of duplicate node ids left by the old
 *  `${type}-${Date.now()}` mint scheme (see src/utils/node-id.ts). */
const GRAPH_SCHEMA_VERSION = 4

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
  /** Coalescing: last history-pushing action key (e.g. "param:<nodeId>") + time */
  _lastActionKey: string | null
  _lastActionTime: number
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
  /** Add a batch as one undoable operation (used by multi-image file drops). */
  addNodes: (nodes: Node<NodeData>[]) => void
  removeNode: (nodeId: string) => void
  /** Atomic multi-element delete (node + connected edges = ONE history entry). */
  removeElements: (nodeIds: string[], edgeIds: string[]) => void
  updateNodeData: (nodeId: string, data: Partial<NodeData>) => void
  /** Set the Fragment Output anchor AND compensate pinned gradients' p0/p1 in a
   *  SINGLE commit, so they hold their on-screen position (no jump) while still
   *  pinning to the anchor on resize. Atomic = one render = no intermediate jump. */
  setOutputAnchor: (nodeId: string, anchor: string) => void

  addEdge: (edge: Edge<EdgeData>) => void
  removeEdge: (edgeId: string) => void
  replaceEdge: (oldEdgeId: string, newEdge: Edge<EdgeData>) => void

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

/** React Flow owns this DOM measurement. Restoring it makes a freshly mounted
 * graph look initialized before its node elements have actually been measured. */
function withoutPersistedMeasurement(node: Node<NodeData>): Node<NodeData> {
  const { measured: _measured, ...rest } = node
  return rest
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
      _lastActionKey: null,
      _lastActionTime: 0,
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
          _lastActionKey: null,
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
          _lastActionKey: null,
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
          _lastActionKey: null,
          canUndo: true,
          canRedo: false,
        })
      },

      addNodes: (nodes) => {
        if (nodes.length === 0) return
        const state = get()
        const past = pushHistory(state._past, snapshot(state))
        set({
          nodes: [...state.nodes, ...nodes],
          _past: past,
          _future: [],
          _lastActionKey: null,
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
          _lastActionKey: null,
          canUndo: true,
          canRedo: false,
        })
      },

      removeElements: (nodeIds, edgeIds) => {
        // Atomic delete: React Flow's default deletion emits node removes and
        // connected-edge removes as SEPARATE change events → two history
        // entries → one undo restored the node without its edges. FlowCanvas
        // routes deletion here instead (one snapshot).
        if (nodeIds.length === 0 && edgeIds.length === 0) return
        const state = get()
        const past = pushHistory(state._past, snapshot(state))
        const removedNodes = new Set(nodeIds)
        const removedEdges = new Set(edgeIds)
        set({
          nodes: state.nodes.filter((n) => !removedNodes.has(n.id)),
          edges: state.edges.filter(
            (e) =>
              !removedEdges.has(e.id) &&
              !removedNodes.has(e.source) &&
              !removedNodes.has(e.target)
          ),
          selectedNodeIds: state.selectedNodeIds.filter((id) => !removedNodes.has(id)),
          selectedEdgeIds: state.selectedEdgeIds.filter((id) => !removedEdges.has(id)),
          _past: past,
          _future: [],
          _lastActionKey: null,
          canUndo: true,
          canRedo: false,
        })
      },

      updateNodeData: (nodeId, data) => {
        // Undoable, with coalescing: a slider drag emits a burst of updates —
        // consecutive edits to the same node within the window share the
        // pre-edit snapshot, so one undo reverts the whole drag.
        const state = get()
        const key = `param:${nodeId}`
        const now = Date.now()
        const coalesce =
          state._lastActionKey === key && now - state._lastActionTime < 800
        set({
          nodes: state.nodes.map((node) =>
            node.id === nodeId
              ? { ...node, data: { ...node.data, ...data } }
              : node
          ),
          ...(coalesce
            ? {}
            : {
                _past: pushHistory(state._past, snapshot(state)),
                _future: [],
                canUndo: true,
                canRedo: false,
              }),
          _lastActionKey: key,
          _lastActionTime: now,
        })
      },

      setOutputAnchor: (nodeId, anchor) => {
        const state = get()
        const target = state.nodes.find((n) => n.id === nodeId)
        const prevA = anchorToVec2((target?.data.params?.anchor as string) ?? 'center')
        const curA = anchorToVec2(anchor)
        const { width, height } = previewCanvasSize
        // Inverse of the gizmo's pxOriginFrac: hold the on-screen centre while the
        // shader re-pins to the new anchor. Measured vs the live canvas so it
        // holds at any size. p0y/p1y are Y-up, hence the flipped sign on dpy.
        const compensate =
          (prevA[0] !== curA[0] || prevA[1] !== curA[1]) && width > 0 && height > 0
        const dpx = compensate ? (prevA[0] - curA[0]) * (width - REFERENCE_SIZE) : 0
        const dpy = compensate ? (curA[1] - prevA[1]) * (height - REFERENCE_SIZE) : 0
        set({
          nodes: state.nodes.map((node) => {
            if (node.id === nodeId) {
              return { ...node, data: { ...node.data, params: { ...node.data.params, anchor } } }
            }
            if (compensate && node.data.type === 'gradient' && node.data.params?.drawMode === 'pinned') {
              const p = node.data.params as Record<string, number>
              return {
                ...node,
                data: {
                  ...node.data,
                  params: {
                    ...node.data.params,
                    p0x: (p.p0x ?? 0) + dpx, p1x: (p.p1x ?? 150) + dpx,
                    p0y: (p.p0y ?? 0) + dpy, p1y: (p.p1y ?? 0) + dpy,
                  },
                },
              }
            }
            return node
          }),
          _past: pushHistory(state._past, snapshot(state)),
          _future: [],
          canUndo: true,
          canRedo: false,
          _lastActionKey: `anchor:${nodeId}`,
          _lastActionTime: Date.now(),
        })
      },

      addEdge: (edge) => {
        const state = get()
        const past = pushHistory(state._past, snapshot(state))
        set({
          edges: [...state.edges, edge],
          _past: past,
          _future: [],
          _lastActionKey: null,
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
          _lastActionKey: null,
          canUndo: true,
          canRedo: false,
        })
      },

      replaceEdge: (oldEdgeId, newEdge) => {
        // Atomic reconnect: drop the old edge AND any edge already occupying
        // the new target handle (single-wire-per-input rule), then add the new
        // one — a single history entry, so one undo restores pre-reconnect
        // wiring exactly.
        const state = get()
        const past = pushHistory(state._past, snapshot(state))
        set({
          edges: [
            ...state.edges.filter(
              (e) =>
                e.id !== oldEdgeId &&
                !(e.target === newEdge.target && e.targetHandle === newEdge.targetHandle),
            ),
            newEdge,
          ],
          selectedEdgeIds: [],
          _past: past,
          _future: [],
          _lastActionKey: null,
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
        // A loaded graph (.sombra file, share URL, import) may predate the uuid
        // id scheme and carry duplicate node ids — repair them before they
        // collapse in the compiler / preview store.
        const repaired = dedupeNodeIds(nodes, edges)
        if (repaired.repaired > 0) {
          console.warn(`[graph] loadGraph: reassigned ${repaired.repaired} duplicate node id(s)`)
        }
        // One-storage Offset Space: convert pre-one-storage offsets to the
        // world frame so old saves render identically (srt-migration.ts).
        const spaceMigrated = migrateOffsetSpace(repaired.nodes, 'convert')
        if (spaceMigrated.migrated > 0) {
          console.warn(`[graph] loadGraph: migrated Offset Space storage on ${spaceMigrated.migrated} node(s)`)
        }
        set({
          nodes: spaceMigrated.nodes,
          edges: repaired.edges,
          selectedNodeIds: [],
          selectedEdgeIds: [],
          _past: past,
          _future: [],
          _lastActionKey: null,
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
          _lastActionKey: null,
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
        // Repair duplicate node ids left by the old `${type}-${Date.now()}`
        // mint scheme (v4). Idempotent: a no-op once ids are unique.
        if (state.nodes) {
          const repaired = dedupeNodeIds(state.nodes, state.edges ?? [])
          if (repaired.repaired > 0) {
            console.warn(`[graph] migrate: reassigned ${repaired.repaired} duplicate node id(s)`)
          }
          state.nodes = repaired.nodes
          state.edges = repaired.edges
          // One-storage Offset Space: stamp-only for localStorage — the working
          // graph has rendered under world semantics on this branch already, so
          // values are kept and only the view marker is stamped.
          const spaceMigrated = migrateOffsetSpace(state.nodes, 'stamp-only')
          if (spaceMigrated.migrated > 0) {
            console.warn(`[graph] migrate: migrated Offset Space storage on ${spaceMigrated.migrated} node(s)`)
          }
          state.nodes = spaceMigrated.nodes
        }
        return state
      },
      partialize: (state) => {
        // Persist image nodes' data so loaded images survive a reload — feasible
        // now that images are downsized + re-encoded at import (ImageUploader →
        // processImageFile, typically tens of KB). A budget still caps the total
        // so a rare large image (e.g. an alpha PNG) can't overflow the ~5MB
        // localStorage quota (which would throw and drop the whole save); any
        // image past the budget is stripped, dropped on reload as before.
        const IMAGE_PERSIST_BUDGET = 2_000_000 // data-URL chars (~4MB UTF-16)
        let used = 0
        const nodes = state.nodes.map((persistedNode) => {
          const n = withoutPersistedMeasurement(persistedNode)
          const imageData = n.data.params?.imageData
          if (typeof imageData !== 'string' || imageData.length === 0) return n
          if (used + imageData.length <= IMAGE_PERSIST_BUDGET) {
            used += imageData.length
            return n
          }
          const { imageData: _, ...restParams } = n.data.params as Record<string, unknown>
          return { ...n, data: { ...n.data, params: restParams } }
        })
        return { nodes, edges: state.edges }
      },
      // Existing localStorage entries already contain React Flow's `measured`
      // field. Strip it during hydration as well as from all future writes so
      // useNodesInitialized reflects the current DOM, not a previous session.
      merge: (persisted, current) => {
        const saved = persisted as Partial<GraphState>
        return {
          ...current,
          ...saved,
          nodes: (saved.nodes ?? current.nodes).map(withoutPersistedMeasurement),
        }
      },
    }
  )
)
