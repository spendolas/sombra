/**
 * OPFS write worker.
 *
 * Browsers WITHOUT the File System Access API (Safari, Firefox) previously
 * exported by accumulating every chunk in a `BlobPart[]` in RAM, which OOMs on
 * large exports (a 4K PNG sequence died mid-run). This worker streams those
 * chunks straight to an Origin-Private File System (OPFS) temp file on disk via
 * a `FileSystemSyncAccessHandle` — which is available ONLY inside a worker,
 * hence this file. The main thread hands us chunks; we write them at a running
 * offset, keeping heap flat, then the main thread reopens the file as a
 * disk-backed `File` (a Blob) to download.
 *
 * Editor-side export code — NOT shipped in the embed player.
 */

// --- Message protocol (shared with export-destination.ts) ------------------

/** main → worker */
export type OpfsReq =
  | { type: 'init'; name: string }
  | { type: 'write'; chunk: Uint8Array } // structured-cloned (copied), not transferred
  | { type: 'close' }

/** worker → main */
export type OpfsRes =
  | { type: 'inited' }
  | { type: 'written' }
  | { type: 'closed'; size: number }
  | { type: 'error'; error: string }

// --- Minimal ambient typing for the OPFS SyncAccessHandle ------------------
// The TS DOM lib (this project compiles with DOM, not WebWorker) does not
// declare `createSyncAccessHandle` / `FileSystemSyncAccessHandle`. Declare only
// the narrow surface we use — no blanket `any`, no dependency.

interface FileSystemSyncAccessHandle {
  write(buffer: ArrayBufferView | ArrayBuffer, options?: { at?: number }): number
  flush(): void
  close(): void
}

interface FileHandleWithSync {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>
}

// --- Worker scope ----------------------------------------------------------
// `self` is typed as a Window under the DOM lib; narrow it to the one-arg
// postMessage + onmessage surface a dedicated worker actually exposes.
const ctx = self as unknown as {
  postMessage(message: OpfsRes): void
  onmessage: ((event: MessageEvent<OpfsReq>) => void) | null
}

let access: FileSystemSyncAccessHandle | null = null
let offset = 0

ctx.onmessage = async (event: MessageEvent<OpfsReq>) => {
  const msg = event.data
  try {
    switch (msg.type) {
      case 'init': {
        const root = await navigator.storage.getDirectory()
        const fh = await root.getFileHandle(msg.name, { create: true })
        access = await (fh as unknown as FileHandleWithSync).createSyncAccessHandle()
        offset = 0
        ctx.postMessage({ type: 'inited' })
        break
      }
      case 'write': {
        if (!access) throw new Error('write before init')
        offset += access.write(msg.chunk, { at: offset })
        ctx.postMessage({ type: 'written' })
        break
      }
      case 'close': {
        if (!access) throw new Error('close before init')
        access.flush()
        access.close()
        access = null
        ctx.postMessage({ type: 'closed', size: offset })
        break
      }
    }
  } catch (err) {
    ctx.postMessage({ type: 'error', error: String(err) })
  }
}
