/**
 * Param preview store — a value being TRIED, not chosen.
 *
 * While a dropdown is open, the highlighted option is shown in the live
 * viewport without being applied: it lives here, never in graphStore, so it
 * reaches no undo history, no localStorage, no share URL and no thumbnail.
 * Only `useLiveCompiler` reads it, overlaying it on the graph it compiles.
 * Ephemeral (not persisted).
 */

import { useCallback } from 'react'
import { create } from 'zustand'
import type { Node } from '@xyflow/react'
import type { NodeData } from '../nodes/types'

export interface ParamPreview {
  nodeId: string
  /** Params to lay over the node's own, shallowly — the same shape updateNodeData writes. */
  params: Record<string, unknown>
}

interface ParamPreviewState {
  preview: ParamPreview | null
  setPreview: (preview: ParamPreview) => void
  clearPreview: () => void
}

export const useParamPreviewStore = create<ParamPreviewState>((set) => ({
  preview: null,
  setPreview: (preview) => set({ preview }),
  clearPreview: () => set((s) => (s.preview ? { preview: null } : s)),
}))

/** The graph as the viewport should show it: `nodes` with the preview laid over its node. */
export function withParamPreview(nodes: Node<NodeData>[], preview: ParamPreview | null): Node<NodeData>[] {
  if (!preview) return nodes
  return nodes.map((n) => (n.id === preview.nodeId
    ? { ...n, data: { ...n.data, params: { ...n.data.params, ...preview.params } } }
    : n))
}

/** `(paramId, value | null)` for a node's dropdowns: try a value, or stop trying. */
export function useParamPreview(nodeId: string) {
  const setPreview = useParamPreviewStore((state) => state.setPreview)
  const clearPreview = useParamPreviewStore((state) => state.clearPreview)
  return useCallback(
    (paramId: string, value: string | null) => {
      if (value === null) clearPreview()
      else setPreview({ nodeId, params: { [paramId]: value } })
    },
    [nodeId, setPreview, clearPreview],
  )
}
