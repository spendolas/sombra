/**
 * Preview store — manages per-node preview ImageBitmaps.
 * Ephemeral (not persisted to localStorage).
 */

import { create } from 'zustand'

interface PreviewState {
  /** nodeId → ImageBitmap */
  previews: Record<string, ImageBitmap>
  /**
   * Main canvas physical pixel size — the live u_resolution. Written by App's
   * ResizeObserver on the (single, reparented) main canvas; read by components
   * needing resolution-dependent math (e.g. ImageUploader's SRT overlay).
   * Never `document.querySelector('canvas')` instead — an 80×80 node thumbnail
   * canvas can match first and every mounted instance gets a different answer.
   */
  mainCanvasSize: [number, number]
  setMainCanvasSize: (w: number, h: number) => void
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
  mainCanvasSize: [1920, 1080] as [number, number],
  setMainCanvasSize: (w, h) =>
    set((s) =>
      s.mainCanvasSize[0] === w && s.mainCanvasSize[1] === h
        ? s
        : { mainCanvasSize: [w, h] as [number, number] },
    ),
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
