import type { Edge, Node } from '@xyflow/react'
import type { EdgeData, NodeData } from '@/nodes/types'
import { nodeRegistry } from '@/nodes/registry'
import { makeNodeId } from '@/utils/node-id'
import { processImageFile, type ProcessedImage } from '@/utils/process-image'
import { extractSombraThumbnail, type SombraThumbnail } from '@/utils/sombra-file'

export interface NamedDropFile {
  name: string
}

export interface DropPosition {
  x: number
  y: number
}

export interface ImageImportFailure<FileType extends NamedDropFile = NamedDropFile> {
  file: FileType
  error: unknown
}

interface DroppedProjectGraph {
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
}

export interface DroppedProjectImportDependencies<FileType extends NamedDropFile> {
  confirmReplacement: (preview: { filename: string; thumbnail: SombraThumbnail | null }) => boolean | Promise<boolean>
  readFile: (file: FileType) => Promise<unknown>
  validate: (payload: unknown) => DroppedProjectGraph
  normalizeImages: (nodes: Node<NodeData>[]) => Promise<Node<NodeData>[]>
  loadGraph: (nodes: Node<NodeData>[], edges: Edge<EdgeData>[]) => void
}

function imageDefaultParams(): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (const param of nodeRegistry.get('image')?.params ?? []) {
    if (param.default !== undefined) params[param.id] = param.default
  }
  return params
}

/**
 * Process dropped images sequentially and turn every successful result into an
 * Image node. The processor is injectable so verification can prove that the
 * real downscaling boundary is engaged without requiring browser canvas APIs.
 */
export async function buildDroppedImageNodes<FileType extends NamedDropFile>(
  files: readonly FileType[],
  origin: DropPosition,
  processImage: (file: FileType) => Promise<ProcessedImage>,
): Promise<{
  nodes: Node<NodeData>[]
  failures: Array<ImageImportFailure<FileType>>
}> {
  const nodes: Node<NodeData>[] = []
  const failures: Array<ImageImportFailure<FileType>> = []
  const columns = Math.max(1, Math.ceil(Math.sqrt(files.length)))

  for (let index = 0; index < files.length; index++) {
    const file = files[index]
    try {
      const processed = await processImage(file)
      nodes.push({
        id: makeNodeId('image'),
        type: 'shaderNode',
        position: {
          x: origin.x + (index % columns) * 240,
          y: origin.y + Math.floor(index / columns) * 320,
        },
        data: {
          type: 'image',
          params: {
            ...imageDefaultParams(),
            imageData: processed.dataUrl,
            imageName: file.name,
            imageAspect: processed.aspect,
            imageWidth: processed.width,
            imageHeight: processed.height,
          },
        },
      })
    } catch (error) {
      failures.push({ file, error })
    }
  }

  return { nodes, failures }
}

/** Production boundary: always runs dropped files through the shared downscaler. */
export function importDroppedImageNodes(files: readonly File[], origin: DropPosition) {
  return buildDroppedImageNodes(files, origin, processImageFile)
}

export function projectReplacementPrompt(filename: string): { title: string; detail: string } {
  return {
    title: `Open “${filename}”?`,
    detail: 'This will close the current project and replace the canvas. You can undo afterward.',
  }
}

/**
 * Read, decode, validate, then confirm replacement before normalizing and
 * replacing the current graph. The confirmation dependency may be an in-app
 * asynchronous dialog.
 */
export async function importDroppedProject<FileType extends NamedDropFile>(
  file: FileType,
  dependencies: DroppedProjectImportDependencies<FileType>,
): Promise<boolean> {
  const payload = await dependencies.readFile(file)
  const imported = dependencies.validate(payload)
  const thumbnail = extractSombraThumbnail(payload)
  if (!await dependencies.confirmReplacement({ filename: file.name, thumbnail })) return false
  const normalized = await dependencies.normalizeImages(imported.nodes)
  dependencies.loadGraph(normalized, imported.edges)
  return true
}
