# Video Export — Design Spec

**Date:** 2026-08-07
**Status:** design, pending review → implementation plan
**Owner topic:** client-side video / frame-sequence export for Sombra

## 1. Goal

Let a user export a Sombra graph's animation as a shareable file, entirely client-side (no
backend, ships on GitHub Pages). Cover two distinct destinations with one system:

- **Web delivery** — a single video file, including a **transparent** one.
- **Editor hand-off** — an **alpha-preserving, lossless** asset for After Effects / Premiere /
  Resolve.

Formats are **user-selectable per export** and sit behind a **pluggable interface** so new
formats (and a future paywall tier) drop in without touching the render loop.

## 2. Non-goals (v1)

- **ProRes** — no hardware path exists in-browser (WebCodecs has no ProRes encoder; the WASM
  sandbox can't reach hardware). Deferred; full analysis handed off separately
  (`browser-video-export-findings-2026-08-07.md`). Reachable later only via slow `ffmpeg.wasm`
  or a custom Zig/WASM encoder (~1–2 months) — a premium-tier candidate, not v1.
- **Audio** — shaders have none. Video-only.
- **Seamless looping** — its own topic (a "loop-time" source so graphs are periodic by design);
  tracked separately. v1 exports a plain time range.
- **EXR / 16-bit / HDR** — Sombra's pipeline is 8-bit sRGB; float export needs a float render
  target + EXR encoder. Deferred; v1 sequence is 8-bit PNG.
- **AV1 / HEVC** — easy to add later behind feature detection; not required for v1.

## 3. Constraints & prerequisites

- **No backend**, static Pages deploy. Everything runs in the browser.
- **Renderer:** WebGPU-first, WebGL2 fallback — both must keep working (export must degrade,
  not break, on WebGL2).
- **Premultiplied canvas** (`alphaMode: 'premultiplied'` / `premultipliedAlpha: true`). Alpha
  delivery formats want **straight** alpha → an un-premultiply step is required (see §6).
- **Determinism:** `u_time` is a per-render uniform; export drives it by frame index, never
  wall-clock. All animation is a function of uniforms, so frames are reproducible.
- **Prerequisite — TypeScript bump:** MediaBunny needs **TS ≥ 5.7**; repo is on **5.6.3**. A
  small, isolated bump (`tsc -b` + lint gate) precedes adoption. Its own commit.
- **Prerequisite — alpha spike:** confirm MediaBunny encodes VP9/VP8-alpha WebM with a ~10-line
  encode-one-transparent-frame-then-decode check before committing the alpha path to it.

## 4. Architecture

New module `src/export/`, independent of the embed player (`src/embed/`) — different concern,
no shared import boundary required. Pieces:

```
src/export/
  frame-sink.ts       # the FrameSink interface (the abstraction)
  export-engine.ts    # offline deterministic render loop; format-agnostic
  registry.ts         # FrameSink registry + tier gating (paywall chokepoint)
  sinks/
    webcodecs-mp4.ts      # H.264 / MP4 (opaque)         [free]
    webcodecs-webm.ts     # VP9-alpha / WebM (transparent) [free]
    png-sequence.ts       # PNG RGBA sequence, zipped       [free]
  ExportModal.tsx     # UI: format, resolution, fps, duration, progress, download
```

### 4.1 FrameSink interface

Every format implements one interface; the engine never knows which it drives.

```ts
interface FrameSink {
  readonly id: string                 // 'mp4-h264', 'webm-vp9-alpha', 'png-sequence'
  readonly label: string
  readonly supportsAlpha: boolean
  readonly output: 'file' | 'zip'
  readonly tier: 'free' | 'pro'       // paywall metadata (see §4.3)
  isSupported(): Promise<boolean>     // runtime feature-detect (WebCodecs isConfigSupported)
  begin(opts: SinkOpts): Promise<void>            // {width,height,fps,alpha,matte?}
  addFrame(frame: VideoFrame, timestampUs: number): Promise<void>
  finish(): Promise<Blob>             // the downloadable (a video file, or a zip)
}
```

A new format — including a hypothetical custom codec — is a new `FrameSink` + one registry
line. Nothing in the engine or UI changes.

### 4.2 Export engine (the render loop)

Format-agnostic, offline, deterministic:

```
resolve sink (feature-detected) → sink.begin({w,h,fps,alpha,matte})
for i in 0 .. duration*fps - 1:
    t = i / fps
    render graph at time t to an OFFSCREEN target sized w×h   (export resolution)
    if alpha: apply un-premultiply pass; else: composite over matte
    frame = new VideoFrame(offscreenCanvas, {timestamp: i/fps * 1e6})   // GPU-resident
    await sink.addFrame(frame, i/fps*1e6); frame.close()
    report progress(i / total)
blob = await sink.finish() → trigger download
```

- **Offscreen render at export resolution:** a new renderer entry point renders the compiled
  `RenderPlan` to an offscreen RGBA target of arbitrary size at a given `u_time`. Reuses the
  existing multi-pass machinery and the preview renderer's offscreen/readback patterns, scaled
  up from 80×80 to export size. WebGPU and WebGL2 both.
- **WebCodecs path is GPU-resident:** the `VideoFrame` is built from the offscreen canvas — no
  per-frame CPU readback. Backpressure is handled by awaiting the encoder queue.
- **Sequence path** overrides `addFrame` to read pixels back (`copyTextureToBuffer` /
  `readPixels`), encode PNG (`OffscreenCanvas.convertToBlob` or `canvas.toBlob`), and stream
  into a zip (`fflate`, streaming, to bound memory). `output: 'zip'`.
- **Determinism check:** frames must actually vary with `t` — asserted in verification (§8), so
  a broken time-drive can't silently export a static clip.

### 4.3 Registry + tier gating (paywall angle)

- The registry lists all sinks; `getAvailable(entitlements)` returns those where
  `isSupported()` is true AND `canUse(sink.tier, entitlements)`.
- Gating is a **single chokepoint** — encoders carry only a `tier` label; no gating logic
  inside them. Paywalling = flip a `tier` + provide entitlements.
- **Honest limit:** with no backend, client-side gating is **soft (bypassable)**. Real
  enforcement needs a server / signed license later. v1 ships soft-gated; harden when a backend
  exists. Documented, not hidden.

## 5. Formats (v1)

| id | container | codec | alpha | output | tier | notes |
|---|---|---|---|---|---|---|
| `mp4-h264` | MP4 | H.264 (WebCodecs) | no (matte) | file | free | universal, hardware ~everywhere |
| `webm-vp9-alpha` | WebM | VP9 + alpha (WebCodecs) | **yes** | file | free | transparent; great in Resolve, weak in Adobe; VP9 encode often software (still fine offline) |
| `png-sequence` | ZIP | PNG RGBA | **yes** | zip | free | lossless, straight alpha, universal editor import |

Encoder/mux layer: **MediaBunny** (MPL-2.0, zero deps, ~5 kB gzip, WebCodecs-based) for the two
video formats. `fflate` for the sequence zip. PNG via the browser's native canvas encoder.

## 6. Alpha handling

- Canvas is **premultiplied**; alpha delivery wants **straight**. Before capture on alpha
  formats, a **final GPU pass un-premultiplies** (`rgb / max(a, ε)`), so the captured frame is
  straight-alpha. Stays GPU-side (no readback) for the WebCodecs path.
- Honor the repo's **"don't invent alpha"** rule: export passes the graph's alpha through; it
  does not synthesize opacity.
- **Opaque formats** (H.264): no alpha channel → composite over a user-chosen **matte color**
  (default black) so semi-transparent content flattens predictably.

## 7. UI

### 7.1 Entry point (where it lives)

Export is another "get your work out" action, so it joins the existing ones in
**`GraphToolbar`** (the floating top-left pill that already holds Save `.sombra` / Open /
Copy-share-URL / Embed). Add a **5th `IconButton`** (film/export icon) that opens an
**`ExportModal`**, mirroring the existing `code` → `EmbedModal` pattern exactly
(`open`/`onClose` state in `GraphToolbar`):

```tsx
<IconButton icon="film" onClick={() => setExportOpen(true)} title="Export video / image sequence" />
<ExportModal open={exportOpen} onClose={() => setExportOpen(false)} />
```

- **Disabled when there's no valid compile** (no `RenderPlan` to render) — export operates on
  the current compiled plan.
- **Secondary entry:** a `Cmd+K` command ("Export video…") via the existing command palette.
- `ExportModal` is **separate** from `EmbedModal` (single responsibility: embed = the live
  player; export = files, with its own resolution/fps/duration/progress UI). A unified
  "Export ▾" grouping is a fair alternative if toolbar space becomes a concern — not needed now.

### 7.2 ExportModal contents

- **Format** picker — only feature-detected + entitled sinks; each shows alpha/where-it-goes.
- **Resolution** — presets (720p/1080p/4K) + custom; **live preview at the chosen aspect**,
  because `auto_uv` is anchor-relative — a different aspect *reveals/hides* edges rather than
  zooming, so the user must see the framing before exporting.
- **FPS** (24/30/60) and **duration** (seconds) → `totalFrames`.
- **Matte color** (opaque formats only).
- **Progress** bar (frames encoded / total) + cancel; **download** on finish.

## 8. Error handling & edge cases

- **Unsupported codec** on this machine → sink hidden/disabled (feature detection), never a
  hard failure. H.264 is the always-available default.
- **Software-fallback encode** (e.g. VP9) → slower, not broken; offline loop tolerates it (no
  dropped frames). Show an "encoding may take longer" hint.
- **Long/large exports** → stream (encode-as-you-go, streaming zip); bound memory; cap
  duration×resolution with a warning.
- **Encoder/queue errors** → surface to the modal, abort cleanly, close all `VideoFrame`s.
- **WebGL2 path** → export still works via `readPixels`; WebCodecs `VideoFrame` from a WebGL2
  canvas is supported.

## 9. Verification (scripts, per repo convention — no test framework)

Headless Chrome (reuse `scripts/self-validate` Playwright harness):

1. **Round-trip, mechanism-engaged:** export a known animated graph at small res for N frames;
   for video sinks, **decode the result back** (MediaBunny) and assert frame count == N, exact
   dimensions, and **frames differ across time** (proves the time-drive advanced — a static
   export fails). For `png-sequence`, unzip and assert N PNGs of the right size.
2. **Alpha present:** on `webm-vp9-alpha` and `png-sequence`, feed a graph with a transparent
   region and assert the decoded output has non-trivial alpha (not all-opaque) — proves alpha
   survived, and that we un-premultiplied (spot-check a known texel).
3. **Feature-detection matrix:** log `isConfigSupported` per codec; gate the suite so a missing
   codec skips, not fails.
4. **Determinism:** exporting the same graph twice yields byte-identical frames (PNG path).

## 10. Deferred / future (recorded, not built)

- **ProRes** single-file (`ffmpeg.wasm` premium tier, or custom Zig/WASM encoder) — see handoff.
- **AV1 / HEVC** sinks (feature-detected).
- **EXR / 16-bit / float-linear** sequence (needs float render target).
- **Seamless looping** (loop-time source) — separate design.
- **Server-enforced paywall** (replace soft client-side gating).

## 11. Open questions

- Default duration/fps caps for the memory guardrail (pick sane limits during implementation).
- Whether v1 ships one background-matte color or a full picker for opaque export.
- `fflate` vs an alternative for streaming zip (confirm size/streaming during build).
