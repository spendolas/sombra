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

// Message protocol — mirror of src/export/opfs-writer.worker.ts (imported
// type-only so it erases; no runtime dependency on the worker module here).
import type { OpfsReq, OpfsRes } from './opfs-writer.worker'

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

// --- Minimal ambient typing for OPFS (main-thread surface) -----------------
// We reach OPFS via `navigator.storage.getDirectory()` and read back the temp
// file the worker wrote. Declare only the narrow surface we use, cast through
// `unknown` (rather than augmenting globals) so this never conflicts with
// whatever the ambient DOM lib does or does not ship. The worker owns the
// SyncAccessHandle write side; here we only reopen/list/remove.

interface OpfsFileHandle {
  getFile(): Promise<File>
}

interface OpfsDirectoryHandle {
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<OpfsFileHandle>
  removeEntry(name: string): Promise<void>
  keys(): AsyncIterableIterator<string>
}

function getStorageDirectory(): (() => Promise<OpfsDirectoryHandle>) | undefined {
  const nav = (globalThis as { navigator?: { storage?: { getDirectory?: unknown } } }).navigator
  const storage = nav?.storage
  const fn = storage?.getDirectory
  return typeof fn === 'function'
    ? () => (fn as () => Promise<unknown>).call(storage) as Promise<OpfsDirectoryHandle>
    : undefined
}

/** True when the Origin-Private File System is available (Safari/Firefox/Chrome). */
export function supportsOpfs(): boolean {
  return getStorageDirectory() !== undefined
}

const OPFS_TEMP_PREFIX = 'sombra-export-'

/** Best-effort removal of temp files leaked by a crash mid-export. */
async function sweepStaleOpfsTemps(root: OpfsDirectoryHandle): Promise<void> {
  try {
    for await (const key of root.keys()) {
      if (key.startsWith(OPFS_TEMP_PREFIX)) {
        await root.removeEntry(key).catch(() => {})
      }
    }
  } catch {
    // Listing/removal is best-effort; never block an export on cleanup.
  }
}

/**
 * Reclaim any OPFS export temp left behind by a PRIOR completed export.
 *
 * Post-finalize the temp deliberately lingers (so an in-flight download isn't
 * truncated) and is normally swept when the NEXT OPFS export is created. But a
 * user who exports once (potentially multi-GB) and never exports again would
 * keep that temp on disk indefinitely — it even survives a reload. Call this on
 * export-modal OPEN (the mount/open transition), when NO export is in flight:
 * any lingering `sombra-export-*` temp is then from a completed export and safe
 * to reclaim. Never call it mid-export (it would delete the in-flight temp).
 *
 * Feature-detected (no-op when OPFS is absent) and best-effort (never throws).
 */
export async function sweepOpfsExportTemps(): Promise<void> {
  const getDirectory = getStorageDirectory()
  if (!getDirectory) return
  try {
    const root = await getDirectory()
    await sweepStaleOpfsTemps(root)
  } catch {
    // Best-effort; never surface a cleanup failure to the caller.
  }
}

/**
 * OPFS streaming tier: chunks flow to a temp file on disk via a worker holding a
 * SyncAccessHandle, keeping heap flat. Returns null (falls through to in-memory)
 * when the worker cannot open a SyncAccessHandle on this browser.
 */
async function createOpfsDestination(opts: {
  filename: string
  ext: string
}): Promise<ExportDestination | null> {
  const { filename, ext } = opts
  const getDirectory = getStorageDirectory()
  if (!getDirectory) return null

  const name = `${OPFS_TEMP_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`

  let root: OpfsDirectoryHandle
  try {
    root = await getDirectory()
  } catch {
    return null
  }
  await sweepStaleOpfsTemps(root)

  const worker = new Worker(new URL('./opfs-writer.worker.ts', import.meta.url), { type: 'module' })

  // WritableStream serialises writes, so at most one message is ever in flight:
  // a single pending resolver is enough to ack each round-trip (backpressure).
  let pending: { resolve: (msg: OpfsRes) => void; reject: (err: unknown) => void } | null = null
  worker.onmessage = (event: MessageEvent<OpfsRes>) => {
    const msg = event.data
    const p = pending
    pending = null
    if (!p) return
    if (msg.type === 'error') p.reject(new Error(msg.error))
    else p.resolve(msg)
  }
  worker.onerror = (event) => {
    const p = pending
    pending = null
    p?.reject(new Error(event.message || 'opfs worker error'))
  }

  function postAndAwait(req: OpfsReq): Promise<OpfsRes> {
    return new Promise<OpfsRes>((resolve, reject) => {
      pending = { resolve, reject }
      worker.postMessage(req)
    })
  }

  // init round-trip. If the worker cannot create a SyncAccessHandle (e.g. very
  // old Safari), tear down and fall through to the in-memory fallback.
  try {
    await postAndAwait({ type: 'init', name })
  } catch {
    worker.terminate()
    await root.removeEntry(name).catch(() => {})
    return null
  }

  let torndown = false
  let finalized = false
  async function teardown(): Promise<void> {
    if (torndown) return
    torndown = true

    // FINALIZED path: finalize() already closed the handle during its own
    // `close`, and it handed the temp out as the download File/objectURL —
    // deleting it now could truncate a still-streaming download (unverified
    // snapshot semantics on Safari/Firefox, this path's whole audience). Just
    // terminate; the next OPFS export's stale-sweep reclaims the temp (at most
    // one sandboxed temp ever lingers).
    if (finalized) {
      worker.terminate()
      return
    }

    // ABORT/CANCEL/FAILURE path: reclaim the temp PROMPTLY. `worker.terminate()`
    // releases the worker's SyncAccessHandle only asynchronously, so deleting
    // right after terminate() loses a race (the file is still locked) and the
    // temp survives until the next sweep — for a cancelled multi-GB export that
    // is exactly what we must avoid. Close the handle explicitly and await the
    // ack (WritableStream serialises sink calls, so no write is in flight here),
    // THEN removeEntry, THEN terminate. Best-effort throughout.
    try {
      await postAndAwait({ type: 'close' })
    } catch {
      // Worker gone or close failed — still attempt removal below.
    }
    await root.removeEntry(name).catch(() => {})
    worker.terminate()
  }

  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      // Pass the chunk directly (no transfer): structured clone during
      // postMessage synchronously deep-copies it, which already satisfies "the
      // producer may reuse its buffer" — an extra `.slice()` here would just be
      // a second per-chunk copy. Awaiting the worker's ack keeps exactly one
      // chunk in flight (flat mem).
      await postAndAwait({ type: 'write', chunk })
    },
    async abort() {
      await teardown()
    },
  })

  return {
    writable,
    async finalize() {
      // Flip `finalized` FIRST — before any terminate/await — so a teardown()
      // racing in during this method (e.g. modal unmount mid-finalize) takes the
      // finalized branch (terminate-only, no removeEntry) instead of the abort
      // branch: the latter would `postAndAwait({type:'close'})` to a worker this
      // method is about to terminate (a message that never acks → hang) and send
      // the temp to the sweep path instead of the finalized-linger path. Setting
      // it here also still guards a LATER cleanup() from deleting the temp out
      // from under an in-flight download (the flag's original purpose).
      finalized = true
      await postAndAwait({ type: 'close' })
      worker.terminate()
      const fh = await root.getFileHandle(name)
      const file = await fh.getFile()
      // Disk-backed File IS a Blob; the modal downloads it via object URL with
      // flat memory. savedToDisk:false → the modal still triggers the download
      // (unlike the FSA path, where the user already chose the destination).
      return { blob: file, savedToDisk: false, filename }
    },
    async cleanup() {
      await teardown()
    },
  }
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
  /**
   * OPFS tier only. Call on cancel/failure to discard the temp immediately, OR
   * after a successful export (on modal close) — post-finalize it only
   * terminates the worker and leaves the temp for the next-export sweep, so an
   * in-flight download is never truncated. Idempotent and safe to double-call.
   * Absent on the FSA and in-memory paths (nothing to clean up).
   */
  cleanup?(): Promise<void>
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

  // --- OPFS streaming tier: stream chunks to a disk temp via a worker ----
  // Engages whenever FSA was absent/declined and OPFS is available — it's
  // strictly better than the in-memory fallback (flat heap on huge exports).
  // A worker that can't open a SyncAccessHandle returns null → fall through.
  if (supportsOpfs()) {
    const opfsDest = await createOpfsDestination({ filename, ext })
    if (opfsDest) return opfsDest
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
