/**
 * Downscale a live shader canvas into a compact image data URL suitable for
 * embedding into a `.sombra` file or showing in a confirmation dialog.
 */

// 512 (not 256): the open dialog shows the thumbnail up to ~224 CSS px, which is
// ~448 device px on a retina display — 256 upscaled into that reads soft/blocky.
// 512 keeps it crisp there while staying a small embed (~15 KB webp).
const DEFAULT_MAX_EDGE = 512
const FALLBACK_MIME_TYPE = 'image/png'

export interface ShaderThumbnail {
  mimeType: string
  dataUrl: string
}

export function captureCanvasThumbnail(
  source: HTMLCanvasElement,
  maxEdge = DEFAULT_MAX_EDGE,
): ShaderThumbnail | null {
  if (source.width === 0 || source.height === 0) return null

  const scale = Math.min(1, maxEdge / Math.max(source.width, source.height))
  const width = Math.max(1, Math.round(source.width * scale))
  const height = Math.max(1, Math.round(source.height * scale))

  const target = document.createElement('canvas')
  target.width = width
  target.height = height

  const ctx = target.getContext('2d')
  if (!ctx) return null

  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  // Shaders in see-through background mode render with alpha < 1; without an
  // opaque backing the thumbnail composites over the dialog's dark ground and
  // reads as near-black. Flatten onto the editor surface colour first.
  ctx.fillStyle = '#0f0f1a'
  ctx.fillRect(0, 0, width, height)
  try {
    ctx.drawImage(source, 0, 0, width, height)
  } catch {
    return null
  }

  try {
    return {
      mimeType: 'image/webp',
      dataUrl: target.toDataURL('image/webp', 0.82),
    }
  } catch {
    try {
      return {
        mimeType: FALLBACK_MIME_TYPE,
        dataUrl: target.toDataURL(FALLBACK_MIME_TYPE),
      }
    } catch {
      return null
    }
  }
}
