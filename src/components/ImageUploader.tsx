/**
 * ImageUploader — Custom component for the Image node.
 * File upload + a plain, static image thumbnail.
 *
 * SRT manipulation lives on the node's Scale/Rotate/Offset sliders and the
 * on-preview gizmo (SrtGizmoOverlay), NOT here. The thumbnail is deliberately a
 * fixed, non-interactive preview at the IMAGE's own aspect (stable — it does not
 * resize with the canvas). The interactive in-node crop gizmo was removed on the
 * SRT track: it was hard to keep true to the shader and not worth the upkeep;
 * git history on feat/srt-api has the Model-B viewport version if it is ever
 * wanted back (blocked on the viewport resizing with the canvas).
 */

import { useRef, useState, useCallback } from 'react'
import { useGraphStore } from '@/stores/graphStore'
import { ds } from '@/generated/ds'
import { processImageFile } from '@/utils/process-image'

const ACCEPTED_TYPES = 'image/png,image/jpeg,image/webp,image/gif'

export function ImageUploader({ nodeId, data }: {
  nodeId: string; data: Record<string, unknown>
}) {
  const updateNodeData = useGraphStore((s) => s.updateNodeData)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [processing, setProcessing] = useState(false)

  const imageData = data.imageData as string | undefined
  const imageName = data.imageName as string | undefined
  const imageAspect = (data.imageAspect as number) || 1

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      setProcessing(true)
      try {
        // Downscale + re-encode at import (Figma-style) so we store only a small
        // image, not the multi-MB original — see processImageFile.
        const { dataUrl, width, height, aspect } = await processImageFile(file)
        updateNodeData(nodeId, {
          params: {
            ...data, imageData: dataUrl, imageName: file.name,
            imageAspect: aspect, imageWidth: width, imageHeight: height,
          },
        })
      } catch (err) {
        console.error('[ImageUploader] failed to process image', err)
      } finally {
        setProcessing(false)
      }
    },
    [nodeId, data, updateNodeData],
  )

  const handleClick = useCallback(() => { fileInputRef.current?.click() }, [])

  const handleClear = useCallback(() => {
    updateNodeData(nodeId, {
      params: { ...data, imageData: '', imageName: '', imageAspect: 1, imageWidth: 0, imageHeight: 0 },
    })
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [nodeId, data, updateNodeData])

  return (
    <div className="flex flex-col gap-y-md nodrag nowheel min-w-0 max-w-full overflow-hidden">
      <input ref={fileInputRef} type="file" accept={ACCEPTED_TYPES} onChange={handleFileChange} className="hidden" />

      {imageData ? (
        <>
          {/* Plain thumbnail — fixed at the image's own aspect (stable across
              canvas resizes), non-interactive. */}
          <div
            className={ds.imageViewportOverlay.root}
            style={{ aspectRatio: imageAspect, width: '100%', maxWidth: '100%', overflow: 'hidden' }}
          >
            <img
              src={imageData}
              alt={imageName || 'Uploaded image'}
              draggable={false}
              className="absolute inset-0 w-full h-full object-contain select-none pointer-events-none"
            />
          </div>

          <div className="flex flex-row items-center gap-sm min-w-0">
            <span className="text-body text-fg-dim truncate flex-1 min-w-0" title={imageName}>
              {imageName || 'Image'}
            </span>
            <button
              onClick={handleClear}
              className="text-body text-fg-muted hover:text-fg transition-colors cursor-pointer shrink-0"
            >
              Clear
            </button>
          </div>
        </>
      ) : (
        <button
          onClick={handleClick}
          disabled={processing}
          className="flex items-center justify-center w-full py-md rounded-sm bg-surface-raised border border-edge-subtle text-body text-fg-dim hover:bg-hover hover:text-fg transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
        >
          {processing ? 'Processing…' : 'Upload Image'}
        </button>
      )}
    </div>
  )
}
