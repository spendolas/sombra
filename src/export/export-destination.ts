/**
 * Streaming export destination.
 *
 * Large exports OOM when the whole file/zip is assembled in memory. This module
 * provides a destination abstraction so bytes flow straight to disk (via the
 * File System Access API) when the browser supports it, or fall back to a
 * chunked Blob that accumulates COPIES of each chunk (never concatenating into
 * one growing buffer, which would reintroduce the OOM).
 *
 * This is editor-side export code — NOT shipped in the embed player — so DOM
 * APIs are fine. Do NOT import compiler/nodes/renderers here.
 */

// --- Minimal ambient typing for the File System Access API ---------------
// The TS DOM lib may not declare `showSaveFilePicker` / `FileSystemWritableFileStream`.
// We declare only the narrow surface we use, keeping the public API type-safe
// (no blanket `any` leaks). We intentionally avoid pulling a dependency.

interface SaveFilePickerType {
  description?: string
  accept: Record<string, string[]>
}

interface SaveFilePickerOptions {
  suggestedName?: string
  types?: SaveFilePickerType[]
}

/** The subset of FileSystemWritableFileStream we rely on: it IS a WritableStream<Uint8Array>. */
type WritableFileStream = WritableStream<Uint8Array>

interface SaveFileHandle {
  readonly name: string
  createWritable(): Promise<WritableFileStream>
}

type ShowSaveFilePicker = (options?: SaveFilePickerOptions) => Promise<SaveFileHandle>

function getShowSaveFilePicker(): ShowSaveFilePicker | undefined {
  const fn = (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker
  return typeof fn === 'function' ? (fn as ShowSaveFilePicker) : undefined
}

// --- Public API -----------------------------------------------------------

export interface ExportDestination {
  /** Append-only, ordered chunks. */
  writable: WritableStream<Uint8Array>
  /**
   * Resolves after `writable.close()`: the Blob in fallback mode, or null when
   * streamed to disk. Just reports the outcome — it does NOT close the stream
   * (the sink closes it in its finish; double-closing would throw).
   */
  finalize(): Promise<{ blob: Blob | null; savedToDisk: boolean; filename: string }>
  /**
   * TEST/INTROSPECTION ONLY (fallback path only; undefined on the disk path).
   * Returns the number of retained Blob parts — one per accepted chunk. This is
   * the observable that DISTINGUISHES "kept as separate parts" (streaming-safe)
   * from "concatenated into one growing buffer" (the O(n²)/OOM anti-pattern this
   * whole abstraction exists to prevent). The concat regression is byte-correct,
   * so only a parts-count read — not size/order — can catch it. Not part of the
   * production contract; do not depend on it outside verification.
   */
  readonly _partsCount?: () => number
}

/** Thrown when the user cancels the save dialog. */
export class ExportCancelled extends Error {
  constructor(message = 'save cancelled') {
    super(message)
    this.name = 'ExportCancelled'
  }
}

/** True when the File System Access save picker is available. */
export function supportsFileSystemAccess(): boolean {
  return typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function'
}

export async function createExportDestination(opts: {
  filename: string
  mimeType: string
  ext: string
  preferDisk: boolean
}): Promise<ExportDestination> {
  const { filename, mimeType, ext, preferDisk } = opts

  // --- Disk path: stream straight to a file the user picks ---------------
  const showSaveFilePicker = getShowSaveFilePicker()
  if (preferDisk && showSaveFilePicker) {
    let handle: SaveFileHandle
    try {
      handle = await showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: ext.toUpperCase(), accept: { [mimeType]: ['.' + ext] } }],
      })
    } catch (err) {
      // User dismissed the picker → AbortError. Surface a typed cancel so the
      // engine aborts cleanly instead of treating it as a real failure.
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new ExportCancelled('save cancelled')
      }
      throw err
    }

    const writable = await handle.createWritable()
    return {
      writable,
      // The stream is closed by whoever writes to it (the sink's finish calls
      // writable.close()); do NOT double-close here. finalize() only reports.
      async finalize() {
        return { blob: null, savedToDisk: true, filename: handle.name }
      },
    }
  }

  // --- Fallback path: accumulate chunk COPIES into a Blob ----------------
  // Push a COPY of each chunk; NEVER concatenate into one growing array (that
  // reintroduces the OOM this whole abstraction exists to avoid).
  const parts: BlobPart[] = []
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      parts.push(chunk.slice())
    },
  })

  return {
    writable,
    // Must be called AFTER the writable is closed; assembles from accumulated parts.
    async finalize() {
      return { blob: new Blob(parts, { type: mimeType }), savedToDisk: false, filename }
    },
    // Observed from the impl (parts.length), NOT the caller's loop count — so a
    // regression to a growing-buffer concat (one part) makes this diverge from N.
    _partsCount: () => parts.length,
  }
}
