/**
 * Import-time image processing (Figma-style). A user drops in — or opens a
 * `.sombra` that embeds — a photo that may be tens of MB; we cap its longest
 * edge, downscale with a high-quality resample, and re-encode by content —
 * WebP (lossy ~0.85) for opaque images, PNG only when there's real alpha. The
 * graph then stores just this small data URL (a 67 MB PNG becomes ~tens of KB),
 * so `.sombra` files, share URLs, localStorage, and the GPU upload all shrink.
 */

/**
 * Longest-edge cap on import. Sized to cover Sombra's largest export preset
 * (4K = 3840 px) without softening it — NOT a blind constant. A build without
 * 4K export could safely halve this to 2048.
 */
export const MAX_IMPORT_EDGE = 4096

/**
 * A data URL below this is left untouched on load — small enough not to matter,
 * and re-encoding would only risk quality for no real size win.
 */
const LARGE_DATA_URL_CHARS = 300_000

export interface ProcessedImage {
  /** Re-encoded, downscaled image as a data URL (webp for opaque, png for alpha). */
  dataUrl: string
  width: number
  height: number
  /** width / height of the DOWNSCALED image (equals the source aspect). */
  aspect: number
}

/** Decode a File and process it (upload path). Throws if it can't be decoded. */
export async function processImageFile(file: File): Promise<ProcessedImage> {
  return processBitmap(await createImageBitmap(file))
}

/**
 * Process an existing data-URL image (`.sombra` load path) — but only when it's
 * worth it: skip small images, and skip images that are already within the edge
 * cap AND already WebP (re-encoding those would just degrade quality). Returns
 * null when no change is needed.
 */
export async function normalizeImageDataUrl(dataUrl: string): Promise<ProcessedImage | null> {
  if (dataUrl.length <= LARGE_DATA_URL_CHARS) return null
  const alreadyWebp = dataUrl.startsWith('data:image/webp')
  const src = await createImageBitmap(await (await fetch(dataUrl)).blob())
  if (Math.max(src.width, src.height) <= MAX_IMPORT_EDGE && alreadyWebp) {
    src.close()
    return null
  }
  return processBitmap(src)
}

interface ImageParamsNode {
  data?: { params?: Record<string, unknown> }
}

/**
 * Normalise every image node in a loaded graph — downscale/re-encode any large
 * embedded image (e.g. a `.sombra` that carries a 67 MB source), leaving small
 * or already-optimised ones untouched. Returns a new node array; failures leave
 * the offending node unchanged.
 */
export async function normalizeGraphImages<N extends ImageParamsNode>(nodes: N[]): Promise<N[]> {
  return Promise.all(
    nodes.map(async (n): Promise<N> => {
      const imageData = n.data?.params?.imageData
      if (typeof imageData !== 'string' || imageData.length === 0) return n
      try {
        const processed = await normalizeImageDataUrl(imageData)
        if (!processed) return n
        return {
          ...n,
          data: {
            ...n.data,
            params: {
              ...n.data?.params,
              imageData: processed.dataUrl,
              imageWidth: processed.width,
              imageHeight: processed.height,
              imageAspect: processed.aspect,
            },
          },
        } as N
      } catch {
        return n
      }
    }),
  )
}

/**
 * Shared core: cap the longest edge, high-quality resample, and re-encode by
 * content. Closes `src`.
 */
async function processBitmap(src: ImageBitmap): Promise<ProcessedImage> {
  const { width: sw, height: sh } = src

  // Only ever shrink; small images pass through untouched (still re-encoded).
  const scale = Math.min(1, MAX_IMPORT_EDGE / Math.max(sw, sh))
  const width = Math.max(1, Math.round(sw * scale))
  const height = Math.max(1, Math.round(sh * scale))

  // High-quality resample straight from the decoded bitmap (the browser's
  // resizer — a real multi-tap filter, not nearest — avoids downscale aliasing).
  const bmp =
    scale < 1
      ? await createImageBitmap(src, {
          resizeWidth: width,
          resizeHeight: height,
          resizeQuality: 'high',
        })
      : src

  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { alpha: true })
  if (!ctx) throw new Error('[image] OffscreenCanvas 2D context unavailable')
  ctx.drawImage(bmp, 0, 0)

  // Real alpha anywhere → keep PNG (lossless); otherwise WebP is far smaller.
  const pixels = ctx.getImageData(0, 0, width, height).data
  let hasAlpha = false
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] < 255) {
      hasAlpha = true
      break
    }
  }

  // convertToBlob falls back to image/png for any unsupported type, so a browser
  // without WebP encoding still produces a valid (larger) image rather than fail.
  const blob = await canvas.convertToBlob(
    hasAlpha ? { type: 'image/png' } : { type: 'image/webp', quality: 0.85 },
  )
  const dataUrl = await blobToDataUrl(blob)

  src.close()
  if (bmp !== src) bmp.close()

  return { dataUrl, width, height, aspect: width / height }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('[image] blob read failed'))
    reader.readAsDataURL(blob)
  })
}
