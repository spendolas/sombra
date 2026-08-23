/**
 * Append-only bridge from mediabunny's `StreamTarget` to an
 * `ExportDestination`'s `WritableStream<Uint8Array>`.
 *
 * mediabunny's `StreamTarget` writes `StreamTargetChunk` objects
 * (`{ type:'write'; data: Uint8Array; position: number }`) — it can, in
 * principle, seek and rewrite earlier regions. Our destination writable is
 * append-only (`Uint8Array` chunks, no position). We only ever configure the
 * outputs for append-only emission (`Mp4OutputFormat({ fastStart:'fragmented' })`
 * and `WebMOutputFormat({ appendOnly:true })`), so positions are strictly
 * monotonic and equal to the running byte offset.
 *
 * This adapter ASSERTS that invariant: if a chunk ever arrives at a position
 * other than the current offset, it THROWS instead of silently corrupting the
 * output. The throw is the guard in case a future format/config change breaks
 * the append-only assumption.
 */

import { StreamTarget, type StreamTargetChunk } from 'mediabunny'

export interface AppendOnlyStreamTargetBridge {
  /** Hand this to `new Output({ target })`. */
  target: StreamTarget
  /** Close the underlying destination writable (call after `out.finalize()`). */
  close(): Promise<void>
  /**
   * Cancel teardown: release the writer lock, then abort the destination
   * writable. On the File System Access path this discards the swap file; on the
   * Blob fallback it just stops accepting chunks. Best-effort — swallows
   * "already closed/errored".
   */
  abort(): Promise<void>
}

/**
 * Build a `StreamTarget` whose writes are forwarded, append-only, to `writable`.
 * Backpressure propagates: each `write` awaits the destination writer.
 */
export function createAppendOnlyStreamTarget(
  writable: WritableStream<Uint8Array>,
): AppendOnlyStreamTargetBridge {
  const writer = writable.getWriter()
  let offset = 0

  const adapter = new WritableStream<StreamTargetChunk>({
    async write(chunk) {
      if (chunk.position !== offset) {
        throw new Error(
          '[export] non-append write at pos ' +
            chunk.position +
            ' expected ' +
            offset +
            ' — fragmented output assumption violated',
        )
      }
      // Forward the raw bytes; await for backpressure.
      await writer.write(chunk.data)
      offset += chunk.data.byteLength
    },
  })

  return {
    target: new StreamTarget(adapter),
    close: () => writer.close(),
    abort: async () => {
      // Release the writer lock FIRST (writer.abort() alone would abort the
      // stream but leave the lock held), then abort the now-unlocked destination
      // writable. After this no lock dangles and the writable is aborted.
      try {
        writer.releaseLock()
      } catch {
        /* already released — best-effort */
      }
      try {
        await writable.abort()
      } catch {
        /* already closed/errored — best-effort */
      }
    },
  }
}
