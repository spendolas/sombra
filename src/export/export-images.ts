/**
 * Decode a graph's image nodes into GPU-ready ImageBitmaps, keyed by the sampler
 * name the shader samples (`u_<nodeId>_image`, via `imageSamplerName`). Flipped
 * with `imageOrientation: 'flipY'` to match the MAIN renderer's upload
 * (renderer.ts `uploadImageTexture`), so exported frames share its orientation.
 *
 * Device-agnostic: the export renderer turns these bitmaps into textures on its
 * own GPUDevice. Editor-side only (imports a node module) — never the embed
 * player bundle.
 */
import { imageSamplerName } from '../nodes/input/image'

interface ImageNodeLike {
  id: string
  data?: { type?: string; params?: { imageData?: unknown } }
}

/**
 * Returns samplerName → ImageBitmap for every image node that carries data.
 * An undecodable image is skipped (its sampler falls back to a transparent
 * dummy in the renderer), never throwing the whole export.
 */
export async function decodeGraphImages(nodes: ImageNodeLike[]): Promise<Map<string, ImageBitmap>> {
  const out = new Map<string, ImageBitmap>()
  await Promise.all(
    nodes
      .filter(
        (n): n is ImageNodeLike & { data: { params: { imageData: string } } } =>
          n.data?.type === 'image' &&
          typeof n.data.params?.imageData === 'string' &&
          n.data.params.imageData.length > 0,
      )
      .map(async (n) => {
        try {
          const img = new Image()
          img.src = n.data.params.imageData
          await img.decode()
          out.set(imageSamplerName(n.id), await createImageBitmap(img, { imageOrientation: 'flipY' }))
        } catch {
          // Undecodable → skip; the sampler binds the dummy fallback instead.
        }
      }),
  )
  return out
}
