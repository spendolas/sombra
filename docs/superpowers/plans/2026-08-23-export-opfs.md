# Export OPFS Streaming (Safari large-export fix) Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Let browsers WITHOUT the File System Access API (Safari, Firefox) export arbitrarily large files without OOM. Today they fall back to accumulating every chunk in a `BlobPart[]` in RAM → a 4K/3600-frame PNG sequence (tens of GB) kills the tab (observed: Safari died at 2113/3600). Stream those chunks to an OPFS (Origin-Private File System) temp file on disk instead, then hand the user a disk-backed `File` to download, then delete the temp.

**Architecture:** Add an OPFS tier to `createExportDestination`, between the FSA-disk path and the in-memory fallback. The OPFS tier owns a Web Worker holding a `FileSystemSyncAccessHandle` (the OPFS write API supported in workers by Chrome, Safari 15.2+, Firefox 111+). The destination's `WritableStream` posts each chunk to the worker, which writes it at a running offset (synchronous, on-disk) and acks (backpressure). `finalize()` closes the handle, reads the file back via `getFile()` (a disk-backed `File`, NOT loaded into the heap — spike-proven flat memory), and returns it as the download blob. The temp is deleted after download / on next export.

**Tech Stack:** OPFS (`navigator.storage.getDirectory`, `createSyncAccessHandle`), Web Worker (Vite `new Worker(new URL(...), {type:'module'})`), TS strict.

**Spike evidence (already run, in Chrome):**
- Worker + `createSyncAccessHandle`: wrote 200 MB in 1 MB chunks, heap flat 25.5→25.7 MB; `getFile()` disk-backed, size 200 MB. → viable and portable.
- Main-thread `createWritable` also works in Chrome (flat memory) but is NOT reliably in Safari; the worker+SyncAccessHandle path is the portable choice, so use it uniformly for the OPFS tier.

## Global Constraints
- TS strict; `npm run lint` + `tsc -b` clean; existing gates stay green (`verify:export-destination` 3/3, `verify:export-streaming` 6/6, `verify:video-export` 8/8, `verify:export-abort` 7/7).
- Editor-side only. The worker file is editor-side (not in the embed bundle).
- Feature-detect everything; NEVER assume OPFS/SyncAccessHandle exists. Graceful tier order: FSA `showSaveFilePicker` → OPFS worker → in-memory Blob (last resort).
- Backpressure: the destination's `writable.write()` must AWAIT the worker's per-chunk ack, so the engine's frame loop is throttled and chunks don't pile up in the worker's message queue.
- Memory must stay flat — the whole point. The gate proves it.
- Chunk safety: copy each chunk before/at postMessage (structured clone, no transfer) — the producer may reuse buffers; matches the existing fallback's `.slice()` caution. Only one chunk is in flight (backpressure), so memory stays flat.
- Preserve the existing FSA-disk and in-memory paths unchanged. `ExportDestination` public shape stays compatible (the modal's download path consumes `finalize().blob`).

---

## Task 1: OPFS write worker

**Files:**
- Create: `src/export/opfs-writer.worker.ts`

**Interface (Produces) — the message protocol:**
```ts
// main → worker
type OpfsReq =
  | { type: 'init'; name: string }
  | { type: 'write'; chunk: Uint8Array }   // structured-cloned (copied), not transferred
  | { type: 'close' }
// worker → main
type OpfsRes =
  | { type: 'inited' }
  | { type: 'written' }
  | { type: 'closed'; size: number }
  | { type: 'error'; error: string }
```

- [ ] Implement the worker: on `init` → `root = await navigator.storage.getDirectory(); fh = await root.getFileHandle(name,{create:true}); access = await fh.createSyncAccessHandle(); offset = 0`. On `write` → `offset += access.write(chunk, {at: offset})` then post `written`. On `close` → `access.flush(); access.close()` then post `{closed, size: offset}`. Wrap each in try/catch → post `{error}`. (createSyncAccessHandle is worker-only; that's why this is a worker.)
- [ ] Type the protocol (shared types can live in the worker file and be imported by the destination, or duplicated minimally).
- [ ] There is no standalone test here (worker needs a browser); it's exercised by Task 3's gate. Commit with Task 2 (they interlock) OR alone if it compiles.

## Task 2: OPFS tier in `createExportDestination`

**Files:**
- Modify: `src/export/export-destination.ts`

- [ ] Add `supportsOpfs()`: `typeof navigator?.storage?.getDirectory === 'function'` (SyncAccessHandle presence is checked in-worker; if the worker `init` errors, fall through — see below).
- [ ] Insert the OPFS tier AFTER the FSA `showSaveFilePicker` block and BEFORE the in-memory fallback:
  - Spawn the worker: `new Worker(new URL('./opfs-writer.worker.ts', import.meta.url), { type: 'module' })`.
  - Unique temp name: `sombra-export-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}` (Date.now/random are fine here — runtime UI code, NOT a workflow script).
  - `await` an `init` round-trip. If it errors (no SyncAccessHandle, e.g. very old Safari) → terminate the worker and FALL THROUGH to the in-memory fallback (don't throw).
  - `writable = new WritableStream<Uint8Array>({ write(chunk){ return postAndAwait({type:'write', chunk: chunk.slice()}) }, close(){ /* handled in finalize */ } })` — each write awaits the worker ack (backpressure). Use a small promise-per-message helper with a monotonic request id or a strict one-at-a-time queue (WritableStream serialises writes, so one-at-a-time is guaranteed — a single pending resolver is enough).
  - `finalize()`: send `close`, await `{closed}`, then main-thread `root.getFileHandle(name)` → `getFile()` → return `{ blob: file, savedToDisk: false, filename }` (the disk-backed File is a Blob; the modal downloads it via object URL — flat memory).
  - Add `cleanup(): Promise<void>` to the returned `ExportDestination` (make it optional in the interface) that terminates the worker and `root.removeEntry(name)`. Also, on the NEXT `createExportDestination` OPFS call, sweep stale `sombra-export-*` temps (best-effort) so a crash mid-export can't leak forever.
  - On `writable.abort()` (engine cancel): abort → send close/terminate + removeEntry so the temp is discarded. Wire so the engine's `sink.abort()` → `writable.abort()` path tears the OPFS temp down (the sink already aborts the writable; ensure the OPFS writable's `abort()` handler terminates the worker + removes the temp).
- [ ] Extend the `ExportDestination` interface: add `cleanup?(): Promise<void>`.
- [ ] `tsc -b` + `verify:export-destination` (existing fallback test still green — the in-memory path is unchanged). Commit (Tasks 1+2 together).

## Task 3: Cleanup wiring in the modal

**Files:**
- Modify: `src/export/ExportModal.tsx` (and `export-engine.ts` only if it must forward `cleanup`)

- [ ] The modal already downloads `result.blob` via `URL.createObjectURL` + `<a download>` for the `!savedToDisk` path — this now receives the OPFS disk-backed File and works unchanged (flat memory).
- [ ] Call `destination.cleanup?.()` at the right time: AFTER the download has been initiated AND the user is done (on modal close / Close button / unmount), OR after a grace delay following the download click. The OPFS temp + object URL must survive until the browser has read the file for download. Simplest robust rule: keep the temp until the modal closes (or a new export starts), then `cleanup()` + `revokeObjectURL`. Ensure `cleanup()` also runs on unmount.
- [ ] Keep the FSA (`savedToDisk:true`, "Saved to …", no download) and in-memory branches unchanged.
- [ ] Live-check in Chrome (worktree dev server): a moderate PNG export takes the OPFS path (temporarily force `preferDisk:false` OR confirm the tier order), downloads a valid zip, and the OPFS temp is gone afterward. State what you exercised.

## Task 4: Mechanism-engaged OPFS gate

**Files:**
- Create: `scripts/verify-export-opfs.ts` (+ `verify:export-opfs` in package.json)

- [ ] Browser harness (playwright + vite, like `verify-export-streaming.ts`). In-page: build an OPFS `ExportDestination` (force the OPFS tier), write many chunks (e.g. 300 × 1 MB), close, finalize.
- [ ] Assert: (a) `finalize().blob` size == total written; (b) MECHANISM: heap stays flat — measure `performance.memory.usedJSHeapSize` before/after writing the bulk and assert the delta ≪ total bytes (e.g. < 10% of total), proving it did NOT accumulate in RAM; (c) the blob is disk-backed (came from `getFile()`); (d) `cleanup()` removes the OPFS temp (assert `getFileHandle(name)` then rejects). 
- [ ] PROVE IT FAILS: temporarily point the destination at the in-memory `BlobPart[]` fallback and confirm the heap-flat assertion trips (delta ≈ total). Revert; committed gate green.
- [ ] If `performance.memory` is unavailable in the harness browser, use an alternative flat-memory signal (e.g. assert the worker path was taken + file is disk-backed + no `parts[]`), and FAIL loudly if neither signal is available (no silent skip).

## Task 5: Full verify + Safari handoff

- [ ] Run: `lint`, `tsc -b`, `verify:export-destination`, `verify:export-streaming`, `verify:video-export`, `verify:export-abort`, `verify:export-opfs`. All green.
- [ ] Note in the report: **Safari verification is the user's** (this harness drives Chrome; the OPFS worker+SyncAccessHandle path is identical API in Safari, but the actual Safari run — the original failing 4K/3600 case — must be confirmed by the user).
- [ ] Update `EMBED.md`/export docs if they describe the download strategy; add an entry noting the OPFS tier.

## Self-review
- Tier order: FSA → OPFS-worker → in-memory. Each feature-detected; failures fall through, never throw (except ExportCancelled).
- Backpressure: one chunk in flight (WritableStream serialises + per-write ack) → flat memory (the gate proves it).
- Cleanup: temp removed on cleanup()/abort/next-export-sweep; survives until download read.
- The disk-backed File download is the load-bearing Safari behaviour I could NOT automate — user confirms in Safari.
