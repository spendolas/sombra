/**
 * Live CSS size of the main preview canvas, kept up to date by App (the only
 * component that owns the canvas ref). Read by graphStore's `setOutputAnchor`
 * to compute the pinned-gradient compensation atomically with the anchor change
 * (a store action can't hold a React ref, and the compensation must land in the
 * same commit to avoid a one-frame jump).
 */
export const previewCanvasSize = { width: 0, height: 0 }

export function setPreviewCanvasSize(width: number, height: number): void {
  previewCanvasSize.width = width
  previewCanvasSize.height = height
}
