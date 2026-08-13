# Video Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a client-side video/image-sequence export to Sombra — render the current shader graph deterministically to an offscreen target at a chosen resolution and encode it, in-browser, to MP4 (H.264), transparent WebM (VP9/AV1 alpha), or a PNG sequence.

**Architecture:** A new `src/export/` module. An **export renderer** renders the compiled `RenderPlan.wgsl.passes` to an *offscreen* WebGPU texture at target resolution, driven by explicit uniform values (time, resolution, dpr) — generalizing the 80×80 preview renderer's `copyTextureToBuffer` readback. An **export engine** steps `u_time` frame-by-frame, un-premultiplies, and hands each frame to a pluggable **`FrameSink`** (MediaBunny for MP4/WebM, `fflate` for the PNG zip). An **ExportModal** (launched from `GraphToolbar`, per the pinned mockup) drives it.

**Tech Stack:** TypeScript (strict), React 19, WebGPU, WebCodecs, **MediaBunny** (encode/mux), **fflate** (zip), Zustand, `@xyflow/react`.

## Global Constraints

- **Client-side only** — ships on static GitHub Pages, no backend. (Server-side encoding is parked: `docs/superpowers/specs/2026-08-07-video-export-server-side-roadmap.md`.)
- **v1 export is WebGPU-only.** The offscreen path uses `RenderPlan.wgsl.passes`. On WebGL2 the export button is disabled with a "requires WebGPU" note. WebGL2 export is a follow-up. The app's live rendering/preview on WebGL2 must keep working untouched.
- **TypeScript ≥ 5.7** (MediaBunny requirement; repo is on `~5.6.2`).
- **Transparent-video reality (verified in the render-test spike):** raw WebCodecs cannot encode alpha for any codec; MediaBunny produces real alpha **only in Matroska-family containers (WebM/MKV)** via `alpha:'keep'`. MP4/MOV alpha and Safari HEVC-alpha are **out of scope** (need a backend). So: `mp4-h264` = opaque (matte flatten); transparent = `webm-alpha` (WebM) + `png-sequence`.
- **Alpha handling:** the canvas/render targets are **premultiplied**; delivery wants **straight** alpha → un-premultiply before capture. Honor the repo's **"don't invent alpha"** rule (`NODE_AUTHORING_GUIDE.md`): alpha passes through, never synthesized.
- **Uniform offsets are dynamic** — always read from `RenderPlan.wgsl.passes[i].uniformLayout.offsets` (a `Map<string,number>`); never hardcode. Built-in order is defined in `src/compiler/ir/wgsl-assembler.ts:86-100`.
- **`REFERENCE_SIZE = 512`** (`src/renderer/constants.ts:12`); `auto_uv ≈ (fragXY − u_resolution·anchor)/(u_dpr·512) + anchor`.
- **Verification = `tsx` scripts + `window.__sombra` browser checks** — there is NO unit-test framework. GPU scripts use the headless-Chrome Playwright pattern from `scripts/self-validate/index.ts:436-452`; assertions use `test/assert/run` from `scripts/blur-bakeoff/lib/test-util.ts`.
- **Every gate needs a mechanism-engaged assertion** — assert the code path ran (frame count, dimensions, frames-differ-over-time, alpha-present), not just "no error"; then confirm it can fail.

---

## File structure

```
src/export/
  frame-sink.ts        # FrameSink interface + SinkOpts/ExportFrame types
  registry.ts          # sink registry + tier gating (single chokepoint)
  export-renderer.ts   # offscreen WebGPU render of RenderPlan.wgsl.passes at target res + explicit time
  framing.ts           # pure: (view, size, framing) -> { width,height, uDpr, anchor }
  export-engine.ts     # deterministic frame loop; recompiles graph; drives renderer -> sink
  sinks/
    webcodecs-mp4.ts     # H.264 MP4 (opaque, matte flatten)   [free]
    webm-alpha.ts        # VP9/AV1 + alpha WebM (transparent)   [free]
    png-sequence.ts      # PNG RGBA sequence, zipped (fflate)   [free]
  ExportModal.tsx      # the modal (mirrors EmbedModal + pinned mockup)
src/utils/icons.ts     # MODIFY: add a 'film' icon
src/components/GraphToolbar.tsx  # MODIFY: add the export button + <ExportModal/>
scripts/verify-video-export.ts   # headless-Chrome round-trip + alpha + determinism gate
```

---

### Task 1: Prerequisites — TS 5.7 bump + dependencies

**Files:**
- Modify: `package.json` (typescript version; add `mediabunny`, `fflate`)

**Interfaces:**
- Produces: a toolchain that compiles on TS ≥5.7 with `mediabunny` + `fflate` importable.

- [ ] **Step 1: Bump TypeScript**

In `package.json` change `"typescript": "~5.6.2"` → `"typescript": "~5.7.2"`.

- [ ] **Step 2: Install and confirm the bump is clean**

```bash
npm install
npx tsc -b
npm run lint
```
Expected: `tsc -b` and lint both exit 0 (no new errors from the version bump).

- [ ] **Step 3: Add runtime deps**

```bash
npm install mediabunny fflate
```

- [ ] **Step 4: Confirm imports resolve (no app wiring yet)**

```bash
node --input-type=module -e "import('mediabunny').then(m=>console.log('mediabunny', typeof m.Output)); import('fflate').then(m=>console.log('fflate', typeof m.zip))"
```
Expected: `mediabunny function` and `fflate function`.

- [ ] **Step 5: Commit** (TS bump is its own concern — one commit)

```bash
git add package.json package-lock.json
git commit -m "build(export): TS 5.6->5.7 + add mediabunny, fflate (video-export prereqs)"
```

---

### Task 2: Export renderer — offscreen WebGPU render at target resolution, explicit time

This is the main engineering task. It generalizes `WebGPUPreviewRenderer`'s offscreen render + `copyTextureToBuffer` readback (`src/webgpu/preview-renderer.ts:519-544`, fixed 80×80) to an arbitrary target size, with **explicit** uniform values (time, resolution, dpr, anchor) instead of the internal `Date.now()` clock.

**Files:**
- Create: `src/export/export-renderer.ts`
- Test: `scripts/verify-video-export.ts` (created in Task 8; a smoke check here is inline via `window.__sombra`)
- Reference (read, do not modify): `src/webgpu/preview-renderer.ts:198-544`, `src/webgpu/renderer.ts:750-801` (uniform writers), `src/compiler/glsl-generator.ts:75-101` (`RenderPlan`/`wgsl.passes`), `src/compiler/ir/wgsl-assembler.ts:86-145` (uniform layout).

**Interfaces:**
- Consumes: a `RenderPlan` (from `compileGraph` + `compileGraphIR`, obtained in Task 4) — specifically `plan.wgsl.passes[i]` (`{ shaderCode, uniformLayout, textureBindings, inputTextures, resolution? }`); a shared `GPUDevice` from the main renderer (`mainRenderer.getDevice()`, `src/webgpu/renderer.ts:65`).
- Produces:
  ```ts
  export interface ExportRenderTarget {
    readonly device: GPUDevice
    readonly width: number
    readonly height: number
    /** Render one frame to the offscreen texture. Writes built-in uniforms from `frame`
     *  into each pass's uniform buffer using pass.uniformLayout.offsets (dynamic). */
    renderFrame(frame: ExportFrameUniforms): void
    /** Read back the offscreen texture as STRAIGHT-alpha RGBA8 (un-premultiplied). */
    readback(): Promise<Uint8ClampedArray>   // length width*height*4, row-major, Y-down
    /** A VideoFrame for the WebCodecs sinks, straight alpha, at `timestampUs`. */
    toVideoFrame(timestampUs: number): VideoFrame
    dispose(): void
  }
  export interface ExportFrameUniforms {
    timeSec: number
    uResolution: [number, number]  // = [width, height]
    uDpr: number                   // framing scale (Task 6)
    anchor: [number, number]       // Fragment Output anchor, default [0.5,0.5]
  }
  export function createExportRenderTarget(
    device: GPUDevice, plan: RenderPlan, width: number, height: number,
  ): ExportRenderTarget
  ```

- [ ] **Step 1: Scaffold the offscreen target + a passthrough single-pass render**

Create `src/export/export-renderer.ts`. Allocate the offscreen render texture (`format:'rgba8unorm'`, `usage: RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC`, size `[width,height]`) and a readback staging buffer with **256-aligned bytesPerRow** exactly like `preview-renderer.ts:20-22` but at `width`:
```ts
const bytesPerRow = Math.ceil(width * 4 / 256) * 256
const stagingSize = bytesPerRow * height
```
Build the render pipeline(s) from `plan.wgsl.passes[i].shaderCode` mirroring `WebGPUPreviewRenderer.renderSinglePassWGSL`/`renderMultiPassWGSL` (`preview-renderer.ts:224,295`) — the vertex shader, bind-group layout (uniform buffer + per-sampler `_tex`/`_samp`), and intermediate textures for multi-pass are all constructed there; reuse that structure. For multi-pass, each intermediate renders at `pass.resolution ?? 1` × the target size (same `resolution` semantics as `RenderPass.resolution`; scale `u_viewport`/`u_dpr` per the existing `passTargetSizes` rule — see `renderer.ts` `passTargetSizes`).

- [ ] **Step 2: Write built-in uniforms from `ExportFrameUniforms` (dynamic offsets)**

For each pass, get `const off = pass.uniformLayout.offsets` and write only the built-ins that exist in the map (mirrors `renderer.ts:750-801`), into a `Float32Array` view of the uniform buffer:
```ts
const set1 = (name: string, v: number) => { const o = off.get(name); if (o != null) f32[o/4] = v }
const set2 = (name: string, a: number, b: number) => { const o = off.get(name); if (o != null){ f32[o/4]=a; f32[o/4+1]=b } }
set1('u_time', frame.timeSec)
set2('u_resolution', passW, passH)       // pass target size in device px
set1('u_dpr', frame.uDpr)
set1('u_ref_size', 512)                  // REFERENCE_SIZE
set2('u_anchor', frame.anchor[0], frame.anchor[1])
set2('u_viewport', passW, passH)
set2('u_mouse', 0, 0)
device.queue.writeBuffer(uniformBuffer, 0, f32.buffer, 0, off ? layout.totalSize : f32.byteLength)
```
Then `device.queue.submit` the render pass encoder into the offscreen texture (final pass) / intermediates.

- [ ] **Step 3: Readback → un-premultiply → straight alpha**

Mirror `preview-renderer.ts:519-544` (`copyTextureToBuffer` with `bytesPerRow`, `mapAsync`, strip row padding). WebGPU Y=0 is top → NO flip. Then **un-premultiply** each pixel (the target is premultiplied):
```ts
for (let i = 0; i < out.length; i += 4) {
  const a = out[i+3]
  if (a > 0 && a < 255) { const s = 255 / a; out[i]=Math.min(255,out[i]*s); out[i+1]=Math.min(255,out[i+1]*s); out[i+2]=Math.min(255,out[i+2]*s) }
}
```

- [ ] **Step 4: `toVideoFrame` — draw the offscreen texture into an `OffscreenCanvas`**

WebGPU textures aren't directly a `VideoFrame` source; render/blit the offscreen texture to a 2D `OffscreenCanvas` (or reuse the readback `Uint8ClampedArray` → `ImageData` → `OffscreenCanvas.putImageData`) sized `width×height`, then `new VideoFrame(offscreenCanvas, { timestamp: timestampUs, duration })`. Keep straight alpha (the canvas ctx `alpha:true`).

- [ ] **Step 5: Smoke-test in-browser via `window.__sombra`**

Run the dev server, build a `time → hsv_to_rgb → fragment_output` graph, obtain the compiled plan (Task 4 provides the helper; for this smoke test re-compile inline via `compileGraph`+`compileGraphIR`), create a target at 320×180, `renderFrame({timeSec:0,...})` → `readback()` centre pixel A; `renderFrame({timeSec:0.5,...})` → centre pixel B. Assert **A ≠ B** (time drive works) and readback length === 320*180*4.
Expected: pixels differ; correct length.

- [ ] **Step 6: Commit**

```bash
git add src/export/export-renderer.ts
git commit -m "feat(export): offscreen WebGPU export renderer (target res, explicit time, straight alpha)"
```

---

### Task 3: FrameSink interface + registry

**Files:**
- Create: `src/export/frame-sink.ts`, `src/export/registry.ts`
- Test: `scripts/verify-export-registry.ts` (tsx, no GPU)

**Interfaces:**
- Produces:
  ```ts
  // frame-sink.ts
  export interface SinkOpts { width: number; height: number; fps: number; alpha: boolean; matte?: string }
  export interface FrameSink {
    readonly id: string
    readonly label: string
    readonly supportsAlpha: boolean
    readonly output: 'file' | 'zip'
    readonly tier: 'free' | 'pro'
    readonly fileExt: string              // 'mp4' | 'webm' | 'zip'
    isSupported(): Promise<boolean>       // runtime feature detection
    begin(o: SinkOpts): Promise<void>
    addFrame(frame: VideoFrame, timestampUs: number): Promise<void>  // sink may also read ImageData internally
    finish(): Promise<Blob>
  }
  // registry.ts
  export function registerSink(s: FrameSink): void
  export function getSinks(): FrameSink[]
  export async function getAvailableSinks(entitlements: { pro: boolean }): Promise<FrameSink[]>  // isSupported() && tier-gate
  ```

- [ ] **Step 1: Write the failing registry test**

`scripts/verify-export-registry.ts`:
```ts
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import { registerSink, getAvailableSinks } from '../src/export/registry'
const fakeFree = { id:'a', label:'A', supportsAlpha:false, output:'file', tier:'free', fileExt:'mp4', isSupported:async()=>true, begin:async()=>{}, addFrame:async()=>{}, finish:async()=>new Blob() } as any
const fakeProUnsup = { id:'b', label:'B', supportsAlpha:true, output:'file', tier:'pro', fileExt:'webm', isSupported:async()=>false, begin:async()=>{}, addFrame:async()=>{}, finish:async()=>new Blob() } as any
registerSink(fakeFree); registerSink(fakeProUnsup)
test('free entitlement hides pro + unsupported', async () => {
  const av = await getAvailableSinks({ pro:false })
  assert(av.length === 1 && av[0].id === 'a', 'only the supported free sink')
})
await run('export-registry')
```

- [ ] **Step 2: Run it, expect fail** — `npx tsx scripts/verify-export-registry.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `frame-sink.ts` (types only) and `registry.ts`**

```ts
// registry.ts
import type { FrameSink } from './frame-sink'
const sinks: FrameSink[] = []
export function registerSink(s: FrameSink){ if(!sinks.some(x=>x.id===s.id)) sinks.push(s) }
export function getSinks(){ return [...sinks] }
export async function getAvailableSinks(ent: { pro: boolean }){
  const gated = sinks.filter(s => s.tier === 'free' || ent.pro)
  const flags = await Promise.all(gated.map(s => s.isSupported()))
  return gated.filter((_, i) => flags[i])
}
```

- [ ] **Step 4: Run it, expect pass.**

- [ ] **Step 5: Commit** — `git commit -m "feat(export): FrameSink interface + registry with tier gating"`

---

### Task 4: Export engine — deterministic frame loop

**Files:**
- Create: `src/export/export-engine.ts`
- Reference: `src/stores/graphStore.ts` (`useGraphStore.getState().nodes/edges`), `src/compiler/glsl-generator.ts:640` (`compileGraph`), `src/compiler/compiler.worker.ts:161` (`compileGraphIR`), `src/utils/preview-canvas-size.ts` (`previewCanvasSize`).

**Interfaces:**
- Consumes: `createExportRenderTarget` (Task 2), `FrameSink` (Task 3), `computeExportFrame` (Task 6).
- Produces:
  ```ts
  export interface ExportJob { sink: FrameSink; width: number; height: number; fps: number; durationSec: number; alpha: boolean; matte?: string; framing: FramingChoice /* Task 6 */ }
  export async function runExport(job: ExportJob, onProgress: (frame: number, total: number) => void, signal?: AbortSignal): Promise<Blob>
  ```

- [ ] **Step 1: Obtain a fresh `RenderPlan` for export**

Re-compile deterministically from the current graph (the plan is NOT stored — reference sheet §5):
```ts
import { compileGraph } from '../compiler/glsl-generator'
import { compileGraphIR } from '../compiler/ir-compiler' // confirm export path; it's imported by compiler.worker.ts:161
import { useGraphStore } from '../stores/graphStore'
const { nodes, edges } = useGraphStore.getState()
const plan = compileGraph(nodes, edges)
if (!plan.success) throw new Error('compile failed: ' + plan.errors.map(e=>e.message).join('; '))
const ir = compileGraphIR(nodes, edges); plan.wgsl = { passes: ir.passes }   // attach WGSL passes for the export renderer
```
(If `compileGraphIR` is not main-thread importable, add a tiny `src/compiler/compile-plan.ts` that runs both and returns a full `RenderPlan` — used by both the worker and export.)

- [ ] **Step 2: The offline loop (no wall-clock)**

```ts
const total = Math.max(1, Math.round(job.durationSec * job.fps))
const target = createExportRenderTarget(device, plan, job.width, job.height)
await job.sink.begin({ width: job.width, height: job.height, fps: job.fps, alpha: job.alpha, matte: job.matte })
for (let i = 0; i < total; i++) {
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
  const t = i / job.fps
  target.renderFrame({ timeSec: t, uResolution: [job.width, job.height], uDpr: job.framing.uDpr, anchor: job.framing.anchor })
  const vf = target.toVideoFrame(Math.round(t * 1e6))
  await job.sink.addFrame(vf, Math.round(t * 1e6))
  vf.close()
  onProgress(i + 1, total)
}
const blob = await job.sink.finish()
target.dispose()
return blob
```

- [ ] **Step 3: Determinism note.** `u_time` is the only time input and is driven by `i/fps`; the `random` node and all animation are functions of uniforms → identical output for identical settings. No `Date.now()` anywhere in the loop.

- [ ] **Step 4: In-browser smoke via `window.__sombra`** — build a graph, `runExport` with a stub sink that counts `addFrame` calls; assert calls === `duration*fps` and each `VideoFrame` has the target `displayWidth/Height`.

- [ ] **Step 5: Commit** — `git commit -m "feat(export): deterministic offline export engine (recompile + frame loop)"`

---

### Task 5: The three FrameSinks

**Files:**
- Create: `src/export/sinks/webcodecs-mp4.ts`, `src/export/sinks/webm-alpha.ts`, `src/export/sinks/png-sequence.ts`
- Register all three in `src/export/registry.ts` (import-for-side-effect from an `src/export/sinks/index.ts`).

Uses the exact MediaBunny API validated in the render-test spike: `Output`, `Mp4OutputFormat`, `WebMOutputFormat`, `BufferTarget`, `VideoSampleSource`, `VideoSample`, `QUALITY_HIGH`.

- [ ] **Step 1: `webcodecs-mp4.ts` (opaque H.264, matte flatten)**

```ts
import { Output, Mp4OutputFormat, BufferTarget, VideoSampleSource, VideoSample, QUALITY_HIGH } from 'mediabunny'
import type { FrameSink, SinkOpts } from '../frame-sink'
export function makeMp4Sink(): FrameSink {
  let out: any, src: any, matteCanvas: OffscreenCanvas, mctx: OffscreenCanvasRenderingContext2D, o!: SinkOpts
  return {
    id:'mp4-h264', label:'MP4 · H.264', supportsAlpha:false, output:'file', tier:'free', fileExt:'mp4',
    async isSupported(){ try{ return (await (globalThis as any).VideoEncoder.isConfigSupported({codec:'avc1.42001f',width:1280,height:720,bitrate:8e6})).supported }catch{ return false } },
    async begin(opts){ o=opts; out=new Output({format:new Mp4OutputFormat(),target:new BufferTarget()});
      src=new VideoSampleSource({codec:'avc',bitrate:QUALITY_HIGH}); out.addVideoTrack(src); await out.start();
      matteCanvas=new OffscreenCanvas(opts.width,opts.height); mctx=matteCanvas.getContext('2d')! },
    async addFrame(vf, ts){ // flatten onto matte (H.264 has no alpha)
      mctx.clearRect(0,0,o.width,o.height); mctx.fillStyle=o.matte||'#000000'; mctx.fillRect(0,0,o.width,o.height);
      mctx.drawImage(vf,0,0); const s=new VideoSample(matteCanvas,{timestamp:ts/1e6,duration:1/o.fps}); await src.add(s); s.close() },
    async finish(){ await out.finalize(); return new Blob([out.target.buffer],{type:'video/mp4'}) },
  }
}
```

- [ ] **Step 2: `webm-alpha.ts` (transparent, MediaBunny `alpha:'keep'`)**

Prefer AV1 (better compression, verified), fall back to VP9 via `isSupported`:
```ts
import { Output, WebMOutputFormat, BufferTarget, VideoSampleSource, VideoSample, QUALITY_HIGH } from 'mediabunny'
export function makeWebmAlphaSink(): FrameSink {
  let out:any, src:any, o:any, codec:'av1'|'vp9'='vp9'
  return {
    id:'webm-alpha', label:'WebM · alpha', supportsAlpha:true, output:'file', tier:'free', fileExt:'webm',
    async isSupported(){ try{ const V=(globalThis as any).VideoEncoder;
      if((await V.isConfigSupported({codec:'av01.0.04M.08',width:1280,height:720,bitrate:8e6})).supported){codec='av1';return true}
      return (await V.isConfigSupported({codec:'vp09.00.10.08',width:1280,height:720,bitrate:8e6})).supported }catch{ return false } },
    async begin(opts){ o=opts; out=new Output({format:new WebMOutputFormat(),target:new BufferTarget()});
      src=new VideoSampleSource({codec,bitrate:QUALITY_HIGH,alpha:'keep'}); out.addVideoTrack(src); await out.start() },
    async addFrame(vf, ts){ const s=new VideoSample(vf,{timestamp:ts/1e6,duration:1/o.fps}); await src.add(s); s.close() },
    async finish(){ await out.finalize(); return new Blob([out.target.buffer],{type:'video/webm'}) },
  }
}
```

- [ ] **Step 3: `png-sequence.ts` (fflate zip of straight-alpha PNGs)**

`addFrame` draws the `VideoFrame` to an `OffscreenCanvas` and `convertToBlob({type:'image/png'})` (native PNG, keeps alpha), collects bytes, and `finish` zips with fflate:
```ts
import { zip } from 'fflate'
export function makePngSequenceSink(): FrameSink {
  let o:any, frames:{name:string;data:Uint8Array}[]=[], cv:OffscreenCanvas, ctx:OffscreenCanvasRenderingContext2D, n=0
  return {
    id:'png-sequence', label:'PNG sequence', supportsAlpha:true, output:'zip', tier:'free', fileExt:'zip',
    async isSupported(){ return typeof OffscreenCanvas!=='undefined' },
    async begin(opts){ o=opts; frames=[]; n=0; cv=new OffscreenCanvas(opts.width,opts.height); ctx=cv.getContext('2d')! },
    async addFrame(vf){ ctx.clearRect(0,0,o.width,o.height); ctx.drawImage(vf,0,0);
      const blob=await cv.convertToBlob({type:'image/png'}); const buf=new Uint8Array(await blob.arrayBuffer());
      frames.push({name:`frame_${String(n++).padStart(5,'0')}.png`, data:buf}) },
    async finish(){ const files:Record<string,Uint8Array>={}; for(const f of frames) files[f.name]=f.data;
      const out:Uint8Array=await new Promise((res,rej)=>zip(files,{level:0},(e,d)=>e?rej(e):res(d)));
      return new Blob([out],{type:'application/zip'}) },
  }
}
```
(PNG is already deflate-compressed → `level:0` on the zip avoids double-compressing.)

- [ ] **Step 4: Register** — `src/export/sinks/index.ts` imports the three factories and calls `registerSink(...)`; import it once from the app (e.g. top of `ExportModal.tsx`).

- [ ] **Step 5: In-browser smoke** — for each sink: `begin` → `addFrame` a few VideoFrames from a transparent canvas → `finish`; assert `blob.size > 0` and correct MIME. (Deep round-trip is Task 8.)

- [ ] **Step 6: Commit** — `git commit -m "feat(export): mp4-h264, webm-alpha (MediaBunny), png-sequence (fflate) sinks"`

---

### Task 6: Size + Framing → export-frame parameters

Pure functions (no GPU) that turn the mockup's Size + Framing controls into the `ExportFrameUniforms` the renderer needs. Verifiable with a plain tsx script.

**Files:**
- Create: `src/export/framing.ts`
- Test: `scripts/verify-export-framing.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SizeSource = { kind:'match' } | { kind:'mul'; factor:2|4 } | { kind:'preset'; w:number; h:number } | { kind:'custom'; w:number; h:number }
  export type FramingMode = 'reveal' | 'fill' | 'fit'
  export interface FramingChoice { uDpr: number; anchor: [number,number] }
  export interface ViewInfo { cssW: number; cssH: number; deviceDpr: number }  // from previewCanvasSize + devicePixelRatio
  export function targetSize(src: SizeSource, view: ViewInfo): { width:number; height:number }
  export function computeFraming(mode: FramingMode, view: ViewInfo, width: number, height: number): FramingChoice
  export function describeResult(src: SizeSource, mode: FramingMode, view: ViewInfo): { text: string; framingHidden: boolean }
  ```

- [ ] **Step 1: The framing math (mirrors the pinned mockup's verified logic)**

`targetSize`: `match` → `[cssW*deviceDpr, cssH*deviceDpr]` (the view's device pixels); `mul` → view device px × factor; `preset`/`custom` → literal.
`computeFraming` — preserve the view's framing except Reveal (verified in the mockup):
```ts
const viewLogicalW = view.cssW, viewLogicalH = view.cssH   // auto_uv logical extent = u_resolution/u_dpr
export function computeFraming(mode, view, width, height): FramingChoice {
  if (mode === 'reveal') return { uDpr: 1, anchor: [0.5,0.5] }         // logical = target px → anchor-relative reveal/crop
  const targetAR = width/height, viewAR = view.cssW/view.cssH
  const needX = (view.cssW)/targetAR, needY = view.cssH                // s so the frame contains the view per axis (÷512 cancels)
  const s = mode === 'fill' ? Math.min(needX, needY) : Math.max(needX, needY)  // cover vs contain
  return { uDpr: width / s, anchor: [0.5,0.5] }
}
```
**Known limitation (documented):** `uDpr` is also read by blur-radius scaling. For **preserve** modes (Fill/Fit, and Match/upscale) `uDpr` tracks the view, so blur's *visible reach* stays constant (correct). For **Reveal**, `uDpr=1` makes blur reach grow vs the editor — a known discrepancy. The clean fix (a separate `u_frame_scale` built-in uniform so `u_dpr` stays = device dpr for blur) is a follow-up in `2026-08-07-video-export-server-side-roadmap.md`'s sibling "framing uniform" note. Ship the caveat; most graphs have no blur.

- [ ] **Step 2: `describeResult` + framing-hidden-on-match** — match+same-size → `framingHidden:true`, text "Exporting your current view exactly, 1:1." (copy the exact strings from the mockup's `describe()`).

- [ ] **Step 3: Write the failing test** `scripts/verify-export-framing.ts`:
```ts
import { test, run, assert, assertClose } from './blur-bakeoff/lib/test-util'
import { targetSize, computeFraming } from '../src/export/framing'
const view = { cssW:1280, cssH:720, deviceDpr:1 }
test('match = view device px, framing preserved (uDpr=view)', () => {
  const t = targetSize({kind:'match'}, view); assert(t.width===1280 && t.height===720, 'match size')
  const f = computeFraming('fill', view, t.width, t.height); assertClose(f.uDpr, 1, 0.001, 'match+fill uDpr==deviceDpr')
})
test('2x reveal reveals (uDpr=1, not 2)', () => {
  const t = targetSize({kind:'mul',factor:2}, view); assert(t.width===2560, '2x width')
  assert(computeFraming('reveal', view, t.width, t.height).uDpr === 1, 'reveal uDpr=1')
})
test('vertical fill crops (uDpr>view), fit reveals (uDpr<fill)', () => {
  const fill = computeFraming('fill', view, 1080, 1920).uDpr, fit = computeFraming('fit', view, 1080, 1920).uDpr
  assert(fit < fill, 'fit contains (smaller scale) < fill cover')
})
await run('export-framing')
```

- [ ] **Step 4: Run → fail → implement → pass.**

- [ ] **Step 5: Commit** — `git commit -m "feat(export): Size + Reveal/Fill/Fit framing math (verified)"`

---

### Task 7: ExportModal + GraphToolbar button

**Files:**
- Modify: `src/utils/icons.ts` (add `film`)
- Create: `src/export/ExportModal.tsx`
- Modify: `src/components/GraphToolbar.tsx` (add the button + modal)
- Reference: the pinned mockup `docs/superpowers/specs/2026-08-07-export-modal-mockup.html`, `src/components/EmbedModal.tsx` (portal/open-close template), `src/generated/ds.ts` (token classes).

**Interfaces:**
- Consumes: `runExport` (Task 4), `getAvailableSinks` (Task 3), `targetSize`/`computeFraming`/`describeResult` (Task 6), `previewCanvasSize` (`src/utils/preview-canvas-size.ts`).

- [ ] **Step 1: Add the `film` icon**

In `src/utils/icons.ts`: `import { Film } from 'lucide-react'` (alongside the existing lucide imports at `:7-11`) and add `film: Film,` to the `icons` map (`:13-33`).

- [ ] **Step 2: Build `ExportModal.tsx`**

Mirror `EmbedModal.tsx:9,44,60` exactly for shell/portal/open-close: `export function ExportModal({ open, onClose }: { open: boolean; onClose: () => void })`, `if (!open) return null`, `createPortal(..., document.body)`. Inside, reproduce the pinned mockup's controls (Format cards from `getAvailableSinks`, Quality segmented, Size seg + preset/custom, Framing seg Reveal/Fill/Fit hidden-on-match, FPS/Duration, Background/matte only when `!selectedSink.supportsAlpha`, "You'll get" readout via `describeResult`, estimate pinned in the footer). Style with `ds.*` token classes (Tailwind), no raw hex. On **Export**: build `ExportJob`, call `runExport(job, setProgress, abortController.signal)`, swap the right column to the progress panel, then the done panel with a Download link (`URL.createObjectURL(blob)`, `download="scene.<sink.fileExt>"`).

- [ ] **Step 3: Disable on WebGL2 / no valid compile**

Read the renderer backend (the app's renderer instance / `create-renderer` result exposes `.backend`). If `backend !== 'webgpu'`, render the Format list disabled with a "Video export requires WebGPU" note. Also disable Export when the current graph has no successful compile (check `useCompilerStore.getState().hasErrors` / a null shader).

- [ ] **Step 4: Wire the toolbar button** — in `GraphToolbar.tsx`, after the `code`/EmbedModal button (`:77-83`):
```tsx
const [exportOpen, setExportOpen] = useState(false)
// ...
<IconButton icon="film" onClick={() => setExportOpen(true)} title="Export video / image sequence" />
<ExportModal open={exportOpen} onClose={() => setExportOpen(false)} />
```

- [ ] **Step 5: Manual browser check** — `npm run dev`, click the film button, export a 2s 720p MP4 and a 2s WebM-alpha; confirm the modal flow (progress → done → download) and that both files download and play. `npm run lint`.

- [ ] **Step 6: Commit** — `git commit -m "feat(export): ExportModal + GraphToolbar film button (per mockup)"`

---

### Task 8: Verification gate — round-trip, alpha, determinism

**Files:**
- Create: `scripts/verify-video-export.ts` (headless Chrome, mechanism-engaged)
- Modify: `package.json` (add `"verify:video-export": "tsx scripts/verify-video-export.ts"`)

**Interfaces:**
- Consumes: the export engine + sinks, run inside a real page (WebGPU secure-context) via the `self-validate` Playwright pattern.

- [ ] **Step 1: Stand up the headless page**

Copy the launch + local-`node:http`-server + `page.goto` pattern from `scripts/self-validate/index.ts:436-452` (`chromium.launch({channel:'chrome', headless:true, args:['--enable-unsafe-webgpu']})`). Serve a tiny page that imports the export module + `mediabunny` and exposes a `window.__runExportTest()`.

- [ ] **Step 2: The mechanism-engaged assertions (inside `page.evaluate`)**

For a known animated graph, export 12 frames at 160×90:
1. **Frame count + dims:** decode the result with MediaBunny `Input`/`VideoSampleSink`; assert `frameCount === 12` and each sample is 160×90.
2. **Frames vary over time:** decode frame 0 and frame 6, sample a centre pixel; assert they **differ** (proves the time drive advanced — a static export fails here).
3. **Alpha present (webm-alpha):** feed a graph with a transparent region; assert decoded `sample.format === 'I420A'` / `track.canBeTransparent() === true` and a known-transparent texel has α<40, a known-opaque texel α>200 (proves un-premultiply + alpha survived).
4. **PNG sequence:** unzip (fflate `unzip`) → assert 12 PNGs, each 160×90 with a non-trivial alpha channel.
5. **Determinism:** export the same graph twice; assert the PNG-sequence bytes are identical.
6. **Feature-detect matrix:** log `getAvailableSinks` results; skip (not fail) a sink whose `isSupported()` is false on this machine.

- [ ] **Step 3: Prove the gate can fail** — temporarily force `timeSec` constant in the engine; assertion #2 must FAIL. Revert.

- [ ] **Step 4: Run green** — `npm run verify:video-export` → all pass. Also run `npm run self-validate` and `npm run lint` to confirm nothing regressed (the new built-in-uniform writes and export renderer must not touch the live render/preview paths).

- [ ] **Step 5: Commit** — `git commit -m "test(export): headless round-trip + alpha + determinism gate (verify:video-export)"`

---

## Self-review

- **Spec coverage:** Format picker/sinks (T3,T5,T7), Quality (T5 bitrate/`QUALITY_HIGH`), Size + Reveal/Fill/Fit (T6), Background/matte (T5 mp4 + T7 UI), live "You'll get" (T6 `describeResult` + T7), estimate-in-footer (T7), WYSIWYG offscreen render (T2), un-premult/"don't invent alpha" (T2 step 3), determinism (T4 step 3, T8 #5), feature detection (T3 `isSupported`, T8 #6), toolbar entry (T7), verification (T8). **Deferred by design (in spec/roadmap):** MP4/MOV transparency & Safari HEVC (server-side roadmap), WebGL2 export, EXR/16-bit, seamless looping, the separate `u_frame_scale` uniform (Reveal+blur perfection — noted T6).
- **Placeholder scan:** none — every code step has real code or a cited file:line to mirror. The two "confirm import path" notes (`compileGraphIR` in T4, backend accessor in T7) are explicit verification actions, not placeholders.
- **Type consistency:** `FrameSink`/`SinkOpts` (T3) used verbatim by all sinks (T5) and the engine (T4); `ExportFrameUniforms`/`ExportRenderTarget` (T2) consumed by the engine (T4); `FramingChoice.uDpr`/`anchor` (T6) flow into `ExportFrameUniforms` (T2) via the engine (T4). `fileExt` used by the modal's download name (T7).
- **Open risk to watch during T2:** multi-pass intermediate sizing at `pass.resolution` — mirror the existing `passTargetSizes`/`u_dpr` scaling rule (verified feature, `verify:pass-resolution`), or intermediates render at the wrong scale.
