/**
 * Preview store — manages per-node preview data URLs.
 * Ephemeral (not persisted to localStorage).
 */

import { create } from 'zustand'

interface PreviewState {
  /** nodeId → data URL */
  previews: Record<string, string>
  /** Set a preview data URL for a node */
  setPreview: (nodeId: string, dataUrl: string) => void
  /** Remove previews for deleted nodes */
  clearNodes: (nodeIds: string[]) => void
  /** Remove all previews */
  clearAll: () => void
}

export const usePreviewStore = create<PreviewState>((set) => ({
  previews: {},
  setPreview: (nodeId, dataUrl) =>
    set((s) => ({ previews: { ...s.previews, [nodeId]: dataUrl } })),
  clearNodes: (nodeIds) =>
    set((s) => {
      const next = { ...s.previews }
      for (const id of nodeIds) delete next[id]
      return { previews: next }
    }),
  clearAll: () => set({ previews: {} }),
}))
