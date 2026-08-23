# Export Streaming + Large-File Reliability Plan (Wave 2 · Group A)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Stop large exports from OOM-crashing (Chrome "ArrayBuffer allocation failed", Safari "WebKitBlob resource error 1") by streaming output to disk instead of building the whole file/zip in memory. Fix wrong size estimates and add a finalize/"zipping" progress phase.

**Architecture:** Introduce a destination `WritableStream` created up front: Chrome/Edge via File System Access `showSaveFilePicker().createWritable()` (writes straight to the user's chosen file, near-zero memory); Safari/Firefox fall back to an append-only `WritableStream` that collects ordered chunks into `BlobPart[]` → `new Blob(parts)` for a normal download. Sinks write incrementally to that stream: video via mediabunny `StreamTarget` with `Mp4OutputFormat({fastStart:'fragmented'})` / WebM (fragmented, append-only — no seeking); PNG via fflate `Zip` + `ZipPassThrough` streamed entries. `FrameSink` changes from `finish(): Promise<Blob>` to writing into the provided stream and returning `{ blob?: Blob }` (blob present only in fallback; on disk it's already saved).

**Tech Stack:** mediabunny 1.53.1 (`StreamTarget`, `Mp4OutputFormat({fastStart:'fragmented'})`, `WebMOutputFormat`), fflate (`Zip`,`ZipPassThrough`), File System Access API, React 19 + TS strict.

**Spec:** ledger `.superpowers/sdd/2026-08-23-frame-scale-export/progress.md` (Wave 2 section) + measured root causes.

## Global Constraints
- TS strict; `npm run lint` + `tsc -b` clean; `npm run verify:video-export` must pass.
- Editor-side only (sinks/engine/modal may import mediabunny/fflate). Don't touch codegen/renderers.
- Feature-detect `showSaveFilePicker`; NEVER assume it exists (Safari/FF lack it).
- Fragmented MP4/WebM = append-only; the fallback writable must preserve chunk order and NOT hold a single giant buffer.
- Both existing behaviours must keep working: opaque matte flatten (video), straight-alpha PNG, HEVC→AVC codec pick, even-dim clamp, CBR bitrate.

---

## Task 1: Destination abstraction (writable + save-picker with fallback)

**Files:**
- Create: `src/export/export-destination.ts`
- Test: extend `scripts/verify-video-export.ts` (or a new `scripts/verify-export-destination.ts`)

**Interfaces (Produces):**
```ts
export interface ExportDestination {
  writable: WritableStream<Uint8Array>   // append-only, ordered
  /** Resolves after writable.close(): the Blob in fallback mode, or null when streamed to disk. */
  finalize(): Promise<{ blob: Blob | null; savedToDisk: boolean; filename: string }>
}
export function supportsFileSystemAccess(): boolean   // typeof showSaveFilePicker === 'function'
export async function createExportDestination(opts: {
  filename: string; mimeType: string; ext: string; preferDisk: boolean
}): Promise<ExportDestination>
```

- [ ] **Step 1 — disk path:** when `preferDisk && supportsFileSystemAccess()`: `const h = await showSaveFilePicker({ suggestedName: filename, types:[{description:ext, accept:{[mimeType]:['.'+ext]}}] }); const w = await h.createWritable();` → `writable = w`; `finalize()` returns `{blob:null, savedToDisk:true, filename}`. Handle user-cancel (`AbortError`) by rethrowing a typed `ExportCancelled` so the engine aborts cleanly.
- [ ] **Step 2 — fallback path:** otherwise build a `WritableStream<Uint8Array>` whose `write(chunk)` pushes a COPY into `parts: BlobPart[]` (never concatenate into one array); `finalize()` returns `{ blob: new Blob(parts,{type:mimeType}), savedToDisk:false, filename }`.
- [ ] **Step 3 — test:** node/tsx (or in-page harness) — fallback writable accepts N chunks and produces a Blob whose size == sum of chunk lengths, order preserved (write bytes [0,1,2] across chunks, assert concatenation). Mechanism check: assert `parts.length === chunksWritten` (proves no premature concatenation). Prove it can fail (concatenate wrongly → assert trips).
- [ ] **Step 4:** lint+tsc. Commit.

## Task 2: FrameSink interface → streaming

**Files:**
- Modify: `src/export/frame-sink.ts`
- Modify: `src/export/registry.ts` (no shape change expected; verify)

**Interfaces (Produces):**
```ts
interface FrameSink {
  // ...unchanged id/label/supportsAlpha/output/tier/fileExt/isSupported...
  begin(o: SinkOpts, writable: WritableStream<Uint8Array>): Promise<void>
  addFrame(frame: VideoFrame, timestampUs: number): Promise<void>
  finish(): Promise<void>   // flush + close the writable; NO Blob return
  readonly mimeType: string // e.g. 'video/mp4' | 'video/webm' | 'application/zip'
}
```
- [ ] Change `begin` to accept the `writable`; change `finish()` to `Promise<void>`; add `mimeType`. Update `SinkOpts` doc. Commit (compiles only after Tasks 3-5 update the sinks — so land this together with Task 3's first sink OR mark the sinks as the same commit; keep the branch compiling by doing Tasks 2+3+4+5 as one coherent sequence, committing when tsc passes).

## Task 3: MP4/HEVC sink → StreamTarget (fragmented)

**Files:** Modify `src/export/sinks/webcodecs-mp4.ts`
- [ ] `begin(opts, writable)`: `out = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented' }), target: new StreamTarget(writable) })`. Keep codec pick (HEVC→AVC), CBR `qualityFor`, matte flatten. `mimeType='video/mp4'`, keep `fileExt='mp4'`.
- [ ] `finish()`: `await out.finalize()` then the StreamTarget closes the writable (verify mediabunny closes it; if not, close explicitly). No Blob.
- [ ] Note: `StreamTarget` chunks are `{data,position}`; fragmented output is append-only so positions are monotonic — the fallback writable can ignore `position` and append. If mediabunny's StreamTarget writes `StreamTargetChunk` objects (not raw Uint8Array), adapt: the destination writable must accept what StreamTarget emits. Check `StreamTargetChunk` shape; if it's `{data:Uint8Array,position:number}`, wrap so `export-destination`'s writable receives `chunk.data` (Task 1 writable is `Uint8Array`; add a small adapter or make StreamTarget's writable a thin transform). Keep append-only invariant.

## Task 4: WebM sink → StreamTarget (fragmented)

**Files:** Modify `src/export/sinks/webm-alpha.ts`
- [ ] Same treatment: `WebMOutputFormat` fragmented/streaming + `StreamTarget(writable)`; keep VP9→AV1 alpha logic, `alpha:'keep'`. `mimeType='video/webm'`. `finish()` flush+close.

## Task 5: PNG sink → streamed fflate Zip

**Files:** Modify `src/export/sinks/png-sequence.ts`
- [ ] `begin(opts, writable)`: create an fflate `Zip` whose ondata `(err,chunk,final)=>` writes `chunk` to a `writable.getWriter()` (await backpressure). Store the writer.
- [ ] `addFrame`: draw vf → OffscreenCanvas → `convertToBlob({type:'image/png'})` → `Uint8Array`; `const e = new ZipPassThrough(name); zip.add(e); e.push(data, true)`. Do NOT retain the data in a `frames[]` array — push and drop (this removes the all-frames-in-memory leak).
- [ ] `finish()`: `zip.end()`; await the final ondata; close the writer/writable. `mimeType='application/zip'`.
- [ ] Mechanism note: the OLD code kept every PNG in `frames[]` + built one giant zip Uint8Array — the exact OOM. New code retains only the current frame. Verify no residual array.

## Task 6: Engine wires destination + emits finalize phase

**Files:** Modify `src/export/export-engine.ts`
- [ ] `runExport` (or a new signature) accepts the `ExportDestination` (created by the modal) OR creates it from job opts; passes `destination.writable` to `sink.begin`. After the frame loop, `await sink.finish()` then `const res = await destination.finalize()`; return `res` (`{blob,savedToDisk,filename}`).
- [ ] Progress: after the last frame, call `onProgress` with a distinct finalize signal (e.g. `onPhase('finalizing')` or `onProgress(total,total,'finalizing')`) so the UI can show "Finalizing…/Zipping…". Keep abort handling; on abort, abort the writable (`writable.abort()`), and for disk, best-effort remove/leave partial (document behaviour).

## Task 7: Modal — save-picker flow, done/saved state, "zipping" progress

**Files:** Modify `src/export/ExportModal.tsx`
- [ ] On Export click: build filename (`scene.<ext>`), `const dest = await createExportDestination({filename, mimeType: sink.mimeType, ext: sink.fileExt, preferDisk: true})`. Catch `ExportCancelled` → return to config silently.
- [ ] Call the engine with `dest`. Show a "Finalizing…"/"Zipping…" state during the finalize phase (item 8).
- [ ] Done state: if `savedToDisk` → show "Saved to <filename>" with NO download button (it's already on disk); if fallback blob → keep the existing `URL.createObjectURL` + `<a download>` button. Revoke object URLs as today.
- [ ] Remove any assumption that `finish()` returns a Blob.

## Task 8: Fix size estimates

**Files:** Modify `src/export/ExportModal.tsx` (estimate block ~line 580-594)
- [ ] **Video:** the estimate uses `mbps` at 1080p but the real bitrate is area-scaled (see `qualityFor`). Multiply by `(outW*outH)/(1920*1080)` so `sizeMB = (mbps * areaScale * dur)/8`. With CBR this now matches actual output closely.
- [ ] **PNG:** replace the flat `frames*areaK*0.0016` with a sampled estimate — render ONE preview frame to PNG (reuse the export preview path or a one-off), measure its byte size, `sizeMB = frames * bytesPerFrame / 1e6`. If sampling is too costly at modal-open, keep the constant but calibrate it higher for noisy content and label it "rough". Prefer the sampled approach; guard so it doesn't jank the UI (compute once, async).
- [ ] Verify estimate vs a real small export is within ~25%.

## Task 9: Verification gate for streaming (no-OOM + roundtrip)

**Files:** Create `scripts/verify-export-streaming.ts` (or extend `verify-video-export.ts`)
- [ ] In-page (playwright, like the other GPU/export gates): run a REAL export through each sink into the FALLBACK destination writable; assert (a) the output Blob is a valid file (mp4 demuxes via mediabunny Input to N frames; zip has N entries), (b) MECHANISM: assert the PNG sink never accumulates all frames — instrument a counter or assert peak retained ≤ small constant, and that video uses StreamTarget (not BufferTarget). Prove it can fail (revert to BufferTarget/frames[] → gate trips).
- [ ] Register `verify:export-streaming` in package.json. Run; commit.

## Self-review
- Interface change (Task 2) ripples to all 3 sinks + engine + modal — land them as a compiling sequence.
- StreamTargetChunk shape must be confirmed against mediabunny before Task 3 (adapter if `{data,position}`).
- Fallback append-only relies on fragmented output; confirm WebM/MP4 fragmented modes emit monotonic positions.
- Disk-cancel (AbortError) and mid-export abort both close/abort the writable without leaking.
