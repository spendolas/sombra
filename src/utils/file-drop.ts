import {
  SUPPORTED_IMAGE_EXTENSIONS,
  SUPPORTED_IMAGE_MIME_TYPES,
} from './process-image'
import { SOMBRA_FILE_EXTENSION, SOMBRA_FILE_MIME_TYPE } from './file-type-constants'

export interface DropFileDescriptor {
  name: string
  type: string
}

export interface DropFormatDefinition<Id extends string = string> {
  id: Id
  operation: 'append' | 'replace'
  multiple: boolean
  extensions: readonly string[]
  mimeTypes: readonly string[]
  overlay: {
    icon: 'paintBucket' | 'folderOpen'
    tone: 'indigo' | 'warning'
    title: (count: number) => string
    busyTitle: (count: number) => string
    detail: string
  }
}

/**
 * Supported canvas file formats. Add future formats here, then add the matching
 * exhaustive handler in FlowCanvas. Classification and overlay copy are derived
 * from this descriptor rather than duplicated in drag event code.
 */
export const FILE_DROP_FORMATS = [
  {
    id: 'image',
    operation: 'append',
    multiple: true,
    extensions: SUPPORTED_IMAGE_EXTENSIONS,
    mimeTypes: SUPPORTED_IMAGE_MIME_TYPES,
    overlay: {
      icon: 'paintBucket',
      tone: 'indigo',
      title: (count: number) => count === 1 ? 'Create an Image node' : `Create ${count} Image nodes`,
      busyTitle: (count: number) => count === 1 ? 'Optimizing image…' : `Optimizing ${count} images…`,
      detail: 'Images are optimized before they are added.',
    },
  },
  {
    id: 'sombra-project',
    operation: 'replace',
    multiple: false,
    extensions: [SOMBRA_FILE_EXTENSION],
    mimeTypes: [SOMBRA_FILE_MIME_TYPE],
    overlay: {
      icon: 'folderOpen',
      tone: 'warning',
      title: () => 'Open Sombra project',
      busyTitle: () => 'Opening Sombra project…',
      detail: 'This replaces the current project after confirmation.',
    },
  },
] as const satisfies readonly DropFormatDefinition[]

export type FileDropFormat = (typeof FILE_DROP_FORMATS)[number]
export type FileDropFormatId = FileDropFormat['id']

export type DropClassification<Format extends DropFormatDefinition = FileDropFormat> =
  | { status: 'accepted'; format: Format; fileCount: number }
  | { status: 'unsupported'; fileCount: number; reason: string }
  | { status: 'mixed'; fileCount: number; reason: string }
  | { status: 'unresolved'; fileCount: number; reason: string }

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index).toLowerCase() : ''
}

export function matchesDropFormat(
  file: DropFileDescriptor,
  format: DropFormatDefinition,
): boolean {
  const mime = file.type.toLowerCase()
  const extension = extensionOf(file.name)
  return (mime.length > 0 && format.mimeTypes.includes(mime))
    || (extension.length > 0 && format.extensions.includes(extension))
}

export function classifyDropFiles(
  files: readonly DropFileDescriptor[],
): DropClassification<FileDropFormat>
export function classifyDropFiles<Format extends DropFormatDefinition>(
  files: readonly DropFileDescriptor[],
  formats: readonly Format[],
): DropClassification<Format>
export function classifyDropFiles<Format extends DropFormatDefinition>(
  files: readonly DropFileDescriptor[],
  formats: readonly Format[] = FILE_DROP_FORMATS as unknown as readonly Format[],
): DropClassification<Format> {
  if (files.length === 0) {
    return { status: 'unresolved', fileCount: 0, reason: 'Release to inspect files.' }
  }

  const matches = files.map((file) => formats.find((format) => matchesDropFormat(file, format)))
  const unresolved = matches.some((match, index) => !match && files[index].name.length === 0)
  if (unresolved) {
    return {
      status: 'unresolved',
      fileCount: files.length,
      reason: 'The browser is hiding one or more filenames until drop.',
    }
  }

  if (matches.some((match) => !match)) {
    return {
      status: 'unsupported',
      fileCount: files.length,
      reason: files.length === 1 ? 'This file type is not supported.' : 'One or more file types are not supported.',
    }
  }

  const resolved = matches as Format[]
  const formatIds = new Set(resolved.map((format) => format.id))
  if (formatIds.size !== 1) {
    return {
      status: 'mixed',
      fileCount: files.length,
      reason: 'Drop images together, or one Sombra project by itself.',
    }
  }

  const format = resolved[0]
  if (!format.multiple && files.length > 1) {
    return {
      status: 'unsupported',
      fileCount: files.length,
      reason: `Drop one ${format.id === 'sombra-project' ? 'Sombra project' : 'file'} at a time.`,
    }
  }

  return { status: 'accepted', format, fileCount: files.length }
}

/** Stable comparison key so dragover does not trigger React renders at pointer frequency. */
export function dropClassificationKey(classification: DropClassification): string {
  if (classification.status === 'accepted') {
    return `${classification.status}:${classification.format.id}:${classification.fileCount}`
  }
  return `${classification.status}:${classification.fileCount}:${classification.reason}`
}

/** Unknown filenames must remain droppable so they can be classified at release. */
export function dropEffectForClassification(
  classification: DropClassification,
): 'copy' | 'none' {
  return classification.status === 'accepted' || classification.status === 'unresolved'
    ? 'copy'
    : 'none'
}
