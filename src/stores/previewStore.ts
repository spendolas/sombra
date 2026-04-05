/**
 * Preview store — manages per-node preview ImageBitmaps.
 * Ephemeral (not persisted to localStorage).
 */

import { create } from 'zustand'

interface PreviewState {
  /** nodeId → ImageBitmap */
  previews: Record<string, ImageBitmap>
  /** Set a preview ImageBitmap for a node */
  setPreview: (nodeId: string, bitmap: ImageBitmap) => void
  /** Set multiple preview ImageBitmaps in one store update (one React re-render). */
  setBatchPreviews: (updates: Map<string, ImageBitmap>) => void
  /** Remove previews for deleted nodes */
  clearNodes: (nodeIds: string[]) => void
  /** Remove all previews */
  clearAll: () => void
}

export const usePreviewStore = create<PreviewState>((set) => ({
  previews: {},
  setPreview: (nodeId, bitmap) =>
    set((s) => {
      // Close the old bitmap to free GPU memory
      const old = s.previews[nodeId]
      if (old) old.close()
      return { previews: { ...s.previews, [nodeId]: bitmap } }
    }),
  setBatchPreviews: (updates) =>
    set((s) => {
      const next = { ...s.previews }
      for (const [nodeId, bitmap] of updates) {
        const old = next[nodeId]
        if (old) old.close()
        next[nodeId] = bitmap
      }
      return { previews: next }
    }),
  clearNodes: (nodeIds) =>
    set((s) => {
      const next = { ...s.previews }
      for (const id of nodeIds) {
        if (next[id]) next[id].close()
        delete next[id]
      }
      return { previews: next }
    }),
  clearAll: () =>
    set((s) => {
      // Close all bitmaps to free GPU memory
      for (const bitmap of Object.values(s.previews)) bitmap.close()
      return { previews: {} }
    }),
}))
