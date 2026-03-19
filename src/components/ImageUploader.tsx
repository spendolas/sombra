/**
 * ImageUploader — Custom component for the Image node.
 * Provides a file input to upload an image, stores it as base64 in params,
 * and shows a thumbnail preview.
 */

import { useRef, useCallback } from 'react'
import { useGraphStore } from '@/stores/graphStore'

const ACCEPTED_TYPES = 'image/png,image/jpeg,image/webp,image/gif'

export function ImageUploader({
  nodeId,
  data,
}: {
  nodeId: string
  data: Record<string, unknown>
}) {
  const updateNodeData = useGraphStore((s) => s.updateNodeData)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const imageData = data.imageData as string | undefined
  const imageName = data.imageName as string | undefined

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return

      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        // Decode image to get natural dimensions for aspect ratio
        const img = new Image()
        img.onload = () => {
          const aspect = img.naturalWidth / img.naturalHeight
          updateNodeData(nodeId, {
            params: {
              ...data,
              imageData: dataUrl,
              imageName: file.name,
              imageAspect: aspect,
            },
          })
        }
        img.src = dataUrl
      }
      reader.readAsDataURL(file)
    },
    [nodeId, data, updateNodeData],
  )

  const handleClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleClear = useCallback(() => {
    updateNodeData(nodeId, {
      params: {
        ...data,
        imageData: '',
        imageName: '',
        imageAspect: 1,
      },
    })
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }, [nodeId, data, updateNodeData])

  return (
    <div className="flex flex-col gap-y-md nodrag nowheel">
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        onChange={handleFileChange}
        className="hidden"
      />

      {imageData ? (
        <>
          {/* Thumbnail preview */}
          <div className="relative w-full rounded-sm overflow-hidden bg-black">
            <img
              src={imageData}
              alt={imageName || 'Uploaded image'}
              className="w-full h-auto max-h-[96px] object-contain"
            />
          </div>

          {/* File name + clear */}
          <div className="flex flex-row items-center gap-sm">
            <span className="text-caption text-fg-dim truncate flex-1" title={imageName}>
              {imageName || 'Image'}
            </span>
            <button
              onClick={handleClear}
              className="text-caption text-fg-muted hover:text-fg transition-colors cursor-pointer shrink-0"
            >
              Clear
            </button>
          </div>
        </>
      ) : (
        /* Upload button */
        <button
          onClick={handleClick}
          className="flex items-center justify-center w-full py-md rounded-sm bg-surface-raised border border-edge-subtle text-caption text-fg-dim hover:bg-surface-elevated hover:text-fg transition-colors cursor-pointer"
        >
          Upload Image
        </button>
      )}
    </div>
  )
}
