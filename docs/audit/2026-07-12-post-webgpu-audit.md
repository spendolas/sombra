# Post-WebGPU-Migration Audit — 2026-07-12

Full-spectrum audit (UI → shader) of functionality broken or band-aided during/before the WebGL→WebGPU migration. **Two rounds**: Round 1 = 4 parallel static-review agents (compiler/IR, renderer, nodes, UI/state) + live browser verification. Round 2 (deep sweep) = 6 more agents (persistence/utils, remaining UI components, worker/async, WGSL internals, dead-code/DS-pipeline, plus an adversarial re-verification of Round-1 claims) + more live flows (viewer round-trip, reload persistence, Cmd+K, drag-drop, image pipeline). All existing verification scripts pass (46/46 IR parity, 159/159 WGSL GPU, tokens clean, tsc clean) — **everything below is invisible to the current test suite** (reasons in §Testing gaps).

Round-2 additions live in §Round 2; Round-1 items corrected by re-verification are annotated inline with ⚖️.

Verification legend: ✅ **live-verified** (reproduced in running app) · 🔬 **agent-verified** (empirically executed/compiled by review agent) · 📄 **code-cited** (precise source evidence, not executed).

---

## P0 — BROKEN (user-visible failures)

### 1. ✅ Entire WebGL2 fallback is dead: `u_anchor` never declared in GLSL assembler
`src/compiler/glsl-generator.ts:973-1012` (`assembleFragmentShader`)
Codegen references `u_anchor` (added at lines 305/319/524 for auto_uv, auto_fragcoord, SRT) since commit `55998c8` (9-point anchor pin), but the GLSL uniform block only declares u_time/u_resolution/u_mouse/u_ref_size/u_dpr/u_viewport. `wgsl-assembler.ts:95-96` got the new field; GLSL didn't.
**Live proof:** compiled current graph's fragment shader in a raw WebGL2 context → `ERROR: 'u_anchor' : undeclared identifier` ×6, COMPILE_STATUS false.
**Impact:** every graph containing any noise/pattern/image/spatial node → black canvas on WebGL2 (Firefox/Safari/no-WebGPU users) AND all WebGL preview thumbnails (subgraph-compiler uses same assembler). Fix is ~one line.

### 2. ✅ Compile errors have zero UI surface
`src/stores/compilerStore.ts:101` + no consumer anywhere
`getErrorsForNode`/`hasErrors`/`errors` are read by no component; `ShaderNode.tsx` has no error rendering. `use-live-compiler.ts:124` writes errors into the void.
**Live proof:** created a graph cycle → compile fails, store holds 1 error, DOM contains no error text anywhere; canvas silently falls back to bouncing-SOMBRA placeholder.
**Impact:** any compile failure = silent black/placeholder with no explanation. Contradicts CLAUDE.md "shader errors are mapped back to node IDs" — they're mapped, then dropped.

### 3. ✅ WebGPU IR failure = silent stale canvas reported as success
`src/compiler/ir-compiler.ts:433-472` + `compiler.worker.ts:152-157` + `App.tsx:64-67` + `webgpu/renderer.ts:256-257`
`compileGraphIR` returns `null` on any failure (discarding node-attributed errors built at ir-compiler.ts:493/621); worker reports GLSL success with `wgsl` undefined; renderer rejects the plan ("No WGSL data") into console.error only. No fallback to the (currently also broken, see #1) WebGL path is attempted.
**Impact:** on WebGPU, an IR bug in any node = UI says success, canvas keeps the previous shader.

### 4. ✅ Share URL silently dead for image graphs
`src/utils/sombra-file.ts:370` + `GraphToolbar.tsx:42`
`btoa(String.fromCharCode(...compressed))` spreads the compressed buffer as call args.
**Live proof:** connected image node with ~1MB imageData → `RangeError: Maximum call stack size exceeded`. Toolbar try/catch only wraps `clipboard.writeText`, so the throw escapes → button does nothing, no feedback.

### 5. ✅ Redo is unreachable
`src/App.tsx:302` — guard `e.key === 'z'`, but Cmd+Shift+Z delivers `key === 'Z'`. No toolbar redo button exists either.
**Live proof:** add node → Cmd+Z undoes → Cmd+Shift+Z does nothing.

### 6. ✅ Legacy saves with `random` node bake `NaN` into shaders
`src/nodes/input/random.ts:44,53` — `Number(ctx.params.decimals) ?? 7`: fallback unreachable (should be `Number(ctx.params.decimals ?? 7)`); duplicated in glsl() and ir().
**Live proof:** imported graph with `random` lacking `decimals` → compile reports success, generated shader contains literal `NaN` (→ GPU compile failure, invisible per #2/#3).
Root enabler: **.sombra file import does not merge param defaults** (`sombra-file.ts` importFromFile), while the URL-decode path does (sombra-file.ts:403-407). Any param added after a file was saved arrives `undefined`.

### 7. ✅ Old saves referencing renamed nodes hard-fail import
Rename map in `sombra-file.ts:163-168` covers warp/pixelate renames but not `pixel_grid` → `dither` (`src/nodes/postprocess/pixel-grid.ts:55`).
**Live proof:** `shaders/sombra-bioluminescence.json` → `Error: Invalid file: unknown node type "pixel_grid"`. (Other 13 scratch graphs import + compile clean.)

### 8. 🔬 ShaderNode conditional hooks — crash on unknown→known definition transition
`src/components/ShaderNode.tsx:126,189-258` — 3×useRef + useEffect after conditional early return (4 eslint rules-of-hooks errors). If a node instance transitions from missing definition to resolved (e.g. stale localStorage graph + hot fix), React throws "Rendered more hooks…"; no error boundary → white screen.

### 9. 📄 Viewer (shared/embed URLs) missed three editor features
`src/viewer.ts:83-113` — never calls `uploadImageTexture`, `setAnchor`, or `setAnimationSpeed` (editor does all three, App.tsx:81,412).
**Impact:** shared links with Image nodes render black; anchor ≠ center and speed ≠ 1 diverge from what the author sees. Viewer error page also says "WebGL" for WebGPU failures.

### 10. 🔬 WebGL multi-pass preview thumbnails corrupt for deep/relay chains
`src/webgl/preview-renderer.ts:278,311` — still 2-FBO ping-pong (`i % 2` write / `sourcePassIdx % 2` read) while the compiler emits absolute pass indices with relay passes. The ping-pong aliasing fix (commit `f4aabdf`) was applied only to the WebGPU preview (`webgpu/preview-renderer.ts:257` — one texture per pass). Same-parity reads = GL feedback loops / clobbered sources → garbage thumbnails on fallback. Main WebGL renderer is correct (one FBO per pass).
Related missed backports in the GLSL preview compiler: `subgraph-compiler.ts:185` missing `reEmitSet` in passBoundaries filter (vs glsl-generator.ts:779-781 and ir-subgraph-compiler.ts:245-247); `subgraph-compiler.ts:124-127,227-231` never threads `imageSamplers` → image thumbnails blank on WebGL.

---

## P1 — DEGRADED (wrong results, dead controls, data loss)

### Cross-backend visual divergence (same graph looks different per browser)
- 📄 **Warp texture-mode y-flip**: `src/nodes/distort/warp.ts:160` keeps GLSL's `u_resolution.y - gl_FragCoord.y` flip in the mechanically-translated WGSL, where `in.position.y` is already top-down → noise distortion field vertically mirrored on WebGPU vs WebGL2. Compare reeded-glass.ts:437-442 which supplies an explicit no-flip WGSL variant ("NO y-flip needed").
- 📄 **Dither y-convention**: `src/nodes/postprocess/pixel-grid.ts:141,255` — raw `gl_FragCoord.xy` cell coords with no y shim → Bayer orientation, triangle SDF direction, anchor-relative grid all vertically mirrored between backends.
- 📄 **Pixelate UV output**: `src/nodes/distort/pixelate.ts:52-58` GLSL omits the y-flip that auto_uv applies (glsl-generator.ts:303) → downstream consumers get flipped V on WebGL2 only.
- 📄 **auto_fragcoord trap**: `ir-compiler.ts:361-370` GLSL y-up vs WGSL y-down, no flip — dead today (no node uses it), first user gets mirrored output.

### Anchor feature half-wired on WebGL
- 📄 `src/webgl/renderer.ts:714-717,830-848` — `setAnchor` only requests a render; multi-pass render skips clean passes and anchor never marks passes dirty → anchor change does nothing on static multi-pass graphs, mixed-anchor output on animated ones. (WebGPU re-renders everything each frame, so correct there.) Moot until P0#1 fixed, then immediately visible.

### Undo/history model
- 📄 Deleting a connected node → 2 history entries (edges change + nodes change snapshot separately, `graphStore.ts:135-167`); one Cmd+Z restores a corrupt intermediate (node without edges). Same for connection-replace (App.tsx:143-170).
- 📄 `updateNodeData` never snapshots (`graphStore.ts:195-203`) → param edits not undoable; structural undo silently reverts accumulated param edits.
- 📄 Cmd+Z has no input-field guard (App.tsx:300-310, unlike Cmd+K/F handlers) → undoing graph state while typing in a text/number input, and preventDefault kills native text undo.

### Edge/connection handling
- ✅ `onReconnect` (`FlowCanvas.tsx:51-57`) bypasses single-wire-per-input dedupe, undo history, and keeps stale `edge.data` port types → duplicate edges into one handle; wrong edge color; not undoable. **Field-reproduced by user 2026-07-12 in normal editing: two wires into Fragment Output's single Color input (screenshot) — compiler silently uses first edge, second is dead. Bump priority.**
- 📄 No cycle detection in `isValidConnection` (FlowCanvas.tsx:75-104) → UI allows feedback loops; compiler rejects; combined with P0#2 the user just sees the preview die silently. ✅ (cycle silence live-verified)
- 📄 Edges into `showWhen`-hidden connectable params are never cleaned up (ShaderNode.tsx:150-160) → orphan edges to nonexistent handles (dynamicInputs do get cleanup at :110-124).
- 📄 Second Fragment Output possible via palette drag (singleton guard only in Cmd+K palette, `CommandPalette.tsx:14`) → silently dead subgraph (compiler uses `nodes.find()`).

### Preview thumbnails
- 📄 Stale-flag race: `preview-scheduler.ts:270,315,372-376` — compile result unconditionally clears staleness; param changes made while a compile is in flight are lost → thumbnail sticks one change behind. compileId generated but never validated.
- 📄 `previewStore.clearNodes` has zero callers → deleted nodes' ImageBitmaps leak for the session; stale thumbnail flashes on id resurrection via undo.
- 📄 Failed preview compile leaves last-good bitmap silently forever (preview-scheduler.ts:228,337-358).

### Renderer resource/lifecycle
- 📄 Device/context loss = permanent black: WebGPU recovery requests a new device but never restores the render plan; `onDeviceLost` has zero registered callbacks app-wide; shared-device preview renderer keeps the dead device; WebGL `contextrestored` installs the default black shader and never re-uploads image textures (`webgpu/renderer.ts:220-243`, `webgl/renderer.ts:204-227,125`).
- 📄 >9-pass graphs on WebGPU: render loop `break`s past the 8-intermediate cap → silent black (WebGL warns and still draws); capped graphs also destroy/recreate all intermediates+bind groups **every frame** (`webgpu/renderer.ts:878,424-435`).
- 📄 Missing image texture on WebGPU → draw with omitted bind group → per-frame validation errors + black until upload (`webgpu/renderer.ts:573-609,848-850`); async `uploadImageTexture` race can leave older image on screen + leak the losing GPUTexture (:751-790).
- 📄 Multi-pass pipelines bypass the pipeline cache entirely — synchronous createRenderPipeline for all passes on every recompile → jank (`webgpu/renderer.ts:321-401` vs :281).

### Editor perf
- 📄 `imageData` (multi-MB base64, param typed `'float'`) is JSON.stringify'd into the semantic memo key on **every nodes-array change** (every drag frame) — `use-live-compiler.ts:151-172` + `image.ts:707`. Editor-wide drag jank with any image loaded.

### Import/error UX
- 📄 `.sombra` import failure → console.error only, no user feedback (GraphToolbar.tsx:34-37). ✅ (silent-failure pattern live-verified via bioluminescence file)
- 📄 Page reload silently wipes Image-node imageData (persist partialize, graphStore.ts:313-321 — intentional quota tradeoff, but invisible to the user; combined with WebGPU missing-texture behavior above = black shader after every reload of an image graph).
- 📄 IR coercion failure path: `coerceTypeForIR` (ir-compiler.ts:72-73) silently returns identity → opaque WGSL validation error with no node attribution (GLSL twin throws node-mapped error).

---

## P2 — BAND-AIDS / DEBT (works today, fragile)

1. **Duplicate drifting coercion tables** — `ir-compiler.ts:36-74` vs `type-coercion.ts:15-101`: asymmetric row sets; IR injects WGSL syntax (`vec3f(...)`) into "backend-neutral" IR → IR→GLSL lowering emits invalid GLSL for coerced graphs (also blinds verify-ir-poc). Documented as pre-Phase-3 debt in `docs/migration/sombra-webgpu-preview-handoff-v2.md:499`, never fixed.
2. **Regex GLSL→WGSL translation is load-bearing** for every `raw()` node (`wgsl-backend.ts:56-131`, `wgsl-assembler.ts:263-268`): line-start-only decl rewrite, string ternary rewriter, `fragColor = (.+);` regex. Green only because current nodes fit the patterns.
3. **Preview init rAF-polling race** — App.tsx:230-249 polls `rendererRef` via rAF retry loop; `PreviewScheduler.destroy()` never disposes the PreviewRenderer (GPU leak on remount).
4. **ShaderNode expand/collapse** — rAF polling of scrollHeight + direct parent-DOM `marginTop` mutation + suppressed effect deps + now-unused eslint-disable (ShaderNode.tsx:194-258).
5. ✅ **`ImageUploader.useCanvasSize`** queries `document.querySelector('canvas')` once at mount as a u_resolution proxy — wrong canvas in floating/fullwindow modes or post-reparent (ImageUploader.tsx:247-263). **Field-reproduced by user 2026-07-12: the component mounts TWICE per image node (`definition.component` in ShaderNode.tsx:432 node card AND PropertiesPanel.tsx:199 "Custom Controls") — each instance queries at its own mount moment and grabs a different canvas (80×80 thumbnail / main canvas / hidden 0×0 holder), so the two SRT crop-overlay frames visibly disagree for the same node (screenshot). Fix direction: derive u_resolution from a store/renderer source of truth, not per-instance DOM queries.**
6. **`useIR` decided by `navigator.gpu` truthiness** (App.tsx:418) while the actual backend resolves async with fallback — adapter-failure path hands a WGSL plan to the WebGL renderer.
7. **FBM octaves connectable but `recompile`-keyed** (fbm.ts:43-45, acknowledged TODO) — slider drag = full worker recompile per step; runtime-octaves mechanism already exists in the function body.
8. **Renderer key skip bug masked** — use-live-compiler.ts:219-229: simultaneous semantic+renderer change skips renderer branch; hidden by App re-applying anchor/quality on every compile.
9. **markAllDirty() no-op placeholder** on WebGPU (renderer.ts:1013-1018) — masks missing dirty-tracking; full re-render every frame.
10. **Worker Map-serialization folklore** — preview path hand-serializes Map→Record claiming structured clone can't (false), main path posts Maps raw; CLAUDE.md codifies the false claim (compiler.worker.ts:59-117 vs 149-161).
11. **Dither `showWhen` mismatch** — `dither` param visible only for circle but applied for diamond/triangle too (pixel-grid.ts:113 vs 157,300) — invisible stale slider modulates output.
12. **Pixelate dead input** — `coords` port declared, never read in either generator (pixelate.ts:18) — live handle, silently does nothing.
13. **Posterize math overshoot** — `floor(c*levels)/(levels-1)` → 1.33 for white at levels=4 (posterize.ts:32) — blows out >1.0 both backends.
14. **Reeded Glass chevron fork** — coords output vs texture-mode color use different wave math (reeded-glass.ts:229 vs 319) — intra-node, backend-consistent.
15. **No copy/paste/duplicate for nodes** — absent entirely.
16. **Empty persisted graph force-repopulated with default** on reload (App.tsx:183-190) — intentional blank canvas impossible.

---

## P3 — SMELLS / DOCS / MINOR

- **Docs stale:** `NODE_AUTHORING_GUIDE.md:413-441` inventory two refactors old (23 nodes, lists deleted files, doesn't mention mandatory `ir()`, updateMode, spatial, textureInput — new-node authors will ship GLSL-only nodes). `BROWSER-AUTOMATION.md:179` says "23 total" (41 shipped). CLAUDE.md: frozen-ref described as captured-on-first-render but is hard-coded 512 (`REFERENCE_SIZE`, 4 files); Map/postMessage claim false. Page `<title>` still "Sombra - WebGL Shader Builder".
- **u_mouse dead end-to-end** — declared by both codegens, never uploaded by either main renderer, read by no node.
- **`startAnimation()` no already-running guard** (both backends) — safe only by caller convention.
- **PreviewRenderer interface rot** — WebGPU preview's interface methods are warn-and-return-null stubs; scheduler downcasts to call `renderWGSLPreview`; `renderer/types.ts` imports a type from the WebGL backend file.
- **WebGL program-cache dispose double-delete** (webgl/renderer.ts:958-977); LRU eviction guard only protects `this.program`, not active multi-pass programs (:291-307).
- **Silent wiring holes:** unresolvable sourceHandle interpolates `undefined` into shader source (glsl-generator.ts:420-441); null boundary group → downstream falls back to partition index (diverges from compiled index once relays exist) (glsl-generator.ts:820-877 + IR mirror); dynamic textureInput ports would be missed by pass partitioning (glsl-generator.ts:117-134 — latent, no node hits it).
- **Stale-result race** — compile-success gating checks current refs, not compiled snapshot (use-live-compiler.ts:105-109).
- **Lint debt:** 39 errors / 9 warnings (`npm run lint`) — includes all rules-of-hooks errors above, dead `_width/_height` (removed `setMainResolution` feature corpse), `no-constant-binary-expression` on random.ts (= P0#6).
- **Preview thumbnails render 80×80 but display at 210+ CSS px** (×2 DPR ≈ 5× upscale) — blurry by design tradeoff; revisit.
- **Bridge `importGraph` doesn't fitView** — imported graphs appear off-viewport at current zoom.
- `.claude/launch.json` had hardcoded arm64 `/opt/homebrew/bin/npx` — fixed to bare `npx` during this audit (works on both machines).

## Verified OK (checked, not broken)

- All 40 node subgraph previews GPU-validate live (`validateAllSubgraphWGSL`).
- 13/14 scratch `.sombra` graphs import + compile clean (the 14th = P0#7).
- Uniform fast path works: slider param change → no recompile (verified via store identity), renderer-direct update.
- Preview mode switching docked↔fullwindow (F/Esc) — no FlowCanvas remount, viewport preserved; canvas reparent effect deps correct.
- Undo (Cmd+Z) works for structural ops.
- localStorage graph migrations (v3) + `.sombra` v1→v2 migration sound (modulo missing pixel_grid mapping).
- Remaining 39 nodes' glsl()/ir() pairs semantically parallel (noise/hash/FBM/ramp/SRT lowering all match).
- **Zoom toolbar buttons (fit/±/slider/dblclick-zoom): NOT broken** — they stall only under `visibilityState: hidden` (rAF throttling in automated panes); wheel-zoom instant path works. Worth one manual click-check in a focused window.

## Testing gaps (why the suite is green while all this is red)

1. `verify-ir-poc.ts` compares codegen **strings**; `validate-wgsl-multipass.ts` only GPU-compiles **WGSL**. **Nothing ever compiles an assembled GLSL fragment shader** → P0#1 shipped invisibly. Add: assembled-GLSL compile test (headless-gl or browser harness) per node + per multipass fixture.
2. Nothing renders and **pixel-compares WebGPU vs WebGL2** output → all y-flip/orientation divergences invisible. Add: 80×80 readback diff harness (preview infra already supports readback).
3. No tests load **legacy save files** → NaN/rename/defaults-merge breakage invisible. Add: fixture corpus of old `.sombra`/URL-hash saves (the `shaders/` scratch files are a start).
4. No UI-flow tests → dead redo, silent share, error-surfacing gaps invisible. The `window.__sombra` bridge is sufficient to script these (this audit did).

## Round 2 — deep-sweep findings

### P0 — BROKEN (new)

**R1. ✅ Image node completely broken on WebGPU with a real image loaded**
Main IR path (`ir-compiler.ts` → `wgsl-assembler.ts`) emits **zero `@group(1)` texture/sampler declarations** and no `imageSamplers` metadata on the pass — the shader references `u_<id>_image_tex` at the `textureSample` call with no binding declared.
**Live proof:** connected image node with real 2×2 PNG → `compileGraphIR` pass 0 → `createShaderModule` → `unresolved value 'u_n…_image_tex'`; `group1Decls: []`; pass metadata has no imageSamplers. Worker still reports `success: true`, UI shows nothing (P0#2/#3 compound) — canvas silently stale.
Note: only the *preview* IR path (`ir-subgraph-compiler.ts:158,322`) threads imageSamplers to the assembler; the main path never does. Even if it did, two further WGSL landmines wait in `image.ts:151-157` (mechanically-translated `clamp(vec2, 0.0, 1.0)` scalar-splat — no such WGSL overload; `textureSample` under non-uniform control flow in contain mode → `derivative_uniformity` error). The 159/167-test suite only ever tests `imageData: ''` — the entire loaded-image path is untested. 🔬+✅
Also: WebGPU *preview* renderer never binds image textures at all (no imageTextures map exists in the class; incomplete bind group → command buffer invalidated → thumbnail shows the **previous node's** staging-buffer pixels). 📄

**R2. 📄 Cmd+K palette: highlighted row ≠ inserted node**
`CommandPalette.tsx:84,169,183-197,280-290` — keyboard index maps into score-sorted `flatResults` but rows render in category-grouped order (`groupByCategory` re-buckets). Orders diverge for nearly any query → arrow-select "Gradient", Enter inserts something else; hover + Enter same class of wrong. (Live test confirmed palette opens/searches/creates — the *which node* mismatch is the bug.)

**R3. 📄 Uniform edits clobbered by in-flight compile**
`use-live-compiler.ts:242-251` + `App.tsx:64-71` — worker snapshot of `userUniforms` is taken at dispatch; `applyCompileResult` unconditionally replays that snapshot after the plan swap. Slider values changed during the compile visually snap back to stale values until the slider moves again.

**R4. 📄 Stuck "compiling" spinner / dead-worker session freeze**
- `use-live-compiler.ts:238-252,290-294`: `setCompiling(true)` fires synchronously but dispatch is debounced; if the semantic key reverts before the timeout (undo, delete+re-add), the compile is cancelled with nothing ever calling `setCompiling(false)` → spinner stuck until next structural change.
- `use-live-compiler.ts:139-142` + `preview-scheduler.ts:83-88`: no worker crash recovery anywhere — hook's `onerror` only logs; scheduler has **no onerror at all** and `pendingCompile` never times out. After a worker OOM (huge graph/imageData), main preview and all thumbnails freeze silently for the rest of the session.

**R5. 📄 Slider drag after structural change: preview frozen (debounce starvation)**
`use-live-compiler.ts:211-288` — one shared `timeoutRef` serves semantic + uniform paths; while `semanticChanged`, every drag tick clears and re-arms the compile debounce → compile never dispatches AND uniform fast path never runs until drag stops.

**R6. 📄 v1 `.sombra` files with `uv_coords` are unrecoverable**
`sombra-file.ts:162-167` vs `:81` — registry validation (`:194-196`) runs **before** `migrateV1ToV2`, and `TYPE_RENAMES` lacks `uv_coords`, so the migration branch written specifically for it is unreachable → "unknown node type", file rejected wholesale.

**R7. 📄 Default first-run graph is visually wrong**
`test-graph.ts:28` (`createDefaultGraph`, live via App.tsx:185) seeds noise with `scale: 3.0` — a param that no longer exists (post-SRT it's `srt_scale`). Every new user's default shader renders at 1× density instead of the designed 3×; the dead key persists into localStorage and share URLs. All other presets in the file reference more stale params (`scaleX/offsetX`, warp `frequency`, noise `scale: 50`) but are dead code (zero importers).

**R8. 🔬 `npm run audit:collect` / `audit:visual` / `audit:full` crash**
`scripts/audit-collect.ts:17`, `scripts/visual-audit.ts:19` import `playwright-core` — not in package.json or node_modules. Executed: `ERR_MODULE_NOT_FOUND`. Also `scripts/schema.ts` is **untracked in git** while CLAUDE.md lists it as part of the verification suite — exists only via Dropbox sync.

### P1 — DEGRADED (new)

- 📄 **localStorage graphs never got the SRT migration** (`graphStore.ts:270-312` vs `sombra-file.ts:35-128`): persist `migrate` renames types + strips stale edges but never remaps `scale/offset/angle` → `srt_*`. Users' pre-SRT graphs silently lost all scale/rotate/offset settings on upgrade — same graph in a `.sombra` file migrates correctly. Also asymmetric the other way: file import lacks the stale-handle edge stripping localStorage has (`sombra-file.ts:134-219`).
- 📄 **Bare `{nodes,edges}` JSON imports get v1 migration applied** (`sombra-file.ts:214`): fileVersion defaults to 1 → param renames run on modern graphs; currently a lucky no-op, breaks the first time a param reuses a legacy name.
- ✅ **Viewer ignores hash changes**: navigating from one share link to another in the same tab shows the stale shader/error (viewer.ts has no `hashchange` listener; observed live). Share encode also silently drops all edge-less nodes incl. an unwired Fragment Output → confusing viewer error with no hint (`sombra-file.ts:336-338`).
- 📄 **Stripes v1 migration NaN**: `sombra-file.ts:75` `Number(params.angle)` without `|| fallback` (every sibling line has one); header comment says deg→rad, code keeps degrees.
- 📄 **Image init race**: `App.tsx:423-457` image-texture sync bails when renderer is null and only re-runs on `[nodes]` — on load with persisted image graphs, upload depends on unrelated churn after async renderer init. Unordered `img.onload` can apply the older of two rapid uploads. (Currently masked by R1 — nothing image-related works on WebGPU anyway.)
- 📄 **GPUDevice leak + zombie resurrection**: `dispose()` never calls `device.destroy()`; each StrictMode-discarded/remounted renderer leaves a live GPUDevice with an armed `device.lost` handler that re-requests a device (reason `'destroyed'` never fires). One leaked device per mount cycle in dev. (This also explains the 8× "Renderer backend" logs: console accumulation across reloads ×2 StrictMode — not 8 live renderers.)
- 📄 **Animated-thumbnail backpressure**: `preview-scheduler.ts:337-357` re-arms rAF before its awaits; batches pile up behind renderLock unboundedly on slow GPUs. Plus post-`destroy()` in-flight handlers re-add orphan bitmaps after `clearAll` (leak), and a cache-read/render race can overwrite a fresh thumbnail with stale output for up to ~1s.
- 📄 **ImageBitmap close race**: `previewStore.setPreview` closes the old bitmap synchronously; `ShaderNode` passive effect can still `drawImage(closedBitmap)` → uncaught `InvalidStateError` inside a React effect during heavy churn.
- 📄 **Color Ramp editing lags**: `stops` is `updateMode:'recompile'` — every stop-drag pointermove queues a debounced full worker recompile (50–300ms behind cursor). Stop values could be uniforms; only count changes need recompile.
- 📄 **Disabled states render fully opaque**: `opacity-[var(--disabled-opacity)]` used in CommandPalette + sombra-slider but `--disabled-opacity` is defined nowhere → invalid at computed-value time → opacity 1. Also `text-caption` class used 3× in ImageUploader doesn't exist.
- 📄 **PixelatePreview overlay wrong except at dpr=2**: `PixelatePreview.tsx:16-23` — conic-gradient quadrant math halves the cell size, and shader blocks are physical px while overlay uses CSS px; the two errors cancel only on retina.
- 📄 **Drag-listener leaks**: ColorRampEditor, ImageUploader, FloatingPreview, ui/slider all remove document/window listeners only on pointerup — no pointercancel, no unmount cleanup; ImageUploader can leave a custom SVG cursor stuck on body.
- 📄 **No file-size cap on image upload** (`ImageUploader.tsx:480-502`) — multi-MB base64 into params, spread-copied per SRT drag tick, cloned to worker per recompile, multiplied through undo history.
- 📄 **Compile/preview postMessage ships full graph incl. imageData per request** (`preview-scheduler.ts:378-394`) — up to 4 full-graph clones per frame during drags.
- 📄 **Double compile-result store write** (`use-live-compiler.ts:110-112` + `App.tsx:371-377`): `setShaders` called twice per compile, second call blanks vertexShader.
- 📄 **Main-canvas vs thumbnail time-phase offset**: independent `Date.now()` epochs per renderer; pause doesn't stop time (resume = phase jump).
- 📄 **Buffered-success replay after failure** (`App.tsx:379-389`): failing compile doesn't clear `pendingCompileRef` — when the renderer finishes init it replays the outdated successful shader while UI holds the error state.
- 📄 **Slider text/scrub bypasses min/max entirely** (`sombra-slider.tsx:196-197,251-267`, intentional per docstring) — but recompile-mode params accept e.g. `1e9` → baked into codegen (loop bounds), can hang compile; step-snap also blocks fine-grained entry. Related codegen guard: `formatFloat(1e21)` emits `1e21.0` — invalid in both GLSL and WGSL (`wgsl-backend.ts:19-22`).
- 📄 **Pipeline cache keyed by 32-bit rolling hash** of WGSL source (`webgpu/renderer.ts:1064-1072`) — collision = silently wrong pipeline; preview cache correctly uses full source keys.
- 📄 **Device-loss recovery leaves dead imageTextures** (`webgpu/renderer.ts:212-245`) — bind groups created against textures from the destroyed device; images broken until manual re-upload (compounds R1).
- 📄 **BROWSER-AUTOMATION.md missing 9 live bridge APIs** (incl. `validateAllSubgraphWGSL`, which CLAUDE.md explicitly points at this doc for) — all 14 documented ones do exist.

### User-requested UX changes (2026-07-12, not bugs — queue for planning)

- **Anchor picker: replace dropdown with a 3×3 toggle grid.** Current enum dropdown renders glyph labels (`↖ ↑ ↗ … ·`) — selected center shows as a lone dot, unclear. A 3×3 pin grid matches the mental model of the 9-point anchor (Fragment Output `anchor` param, fragment-output.ts:56; also mirrors the Figma-style anchor widget convention). Component work: new DS widget (Figma first per golden rule) + `NodeParameters`/`PropertiesPanel` render branch for it.

### P2/P3 (new, terse)

- Latent WGSL translator traps (all verified currently-dodged, will bite the next node): vector `mod()` routes to f32-only `sombra_mod` (dead `sombra_mod_v2` emitted but never called); scalar→vector promotion only for *literal* floats; `==` in raw ternaries mis-parsed by `findExprStart` (`select(y, x, = b)`); param-component writes (`p.x =`) missed by mutation regex; braceless-for wrapper closes at first bare `}` (nested-body loops mis-scope). `screen_uv` default resolves to literal `'in.v_uv'` — WGSL syntax in IR (same class as coercion issue; excludes image/pixelate from GLSL parity checks).
- IR ternary semantics: GLSL lowers lazy `?:`, WGSL lowers eager `select()` — both branches always evaluated on WebGPU; NaN/Inf from guarded branches (division guards) leaks on WGSL only. Value-invisible to both test scripts.
- `glsl-backend.ts` (IR→GLSL) is unreachable from all app entries — parity path exists only for the offline script; runtime GLSL is the legacy string generator.
- `test-graph.ts`: 7 of 8 exported builders dead (~700 lines); CLAUDE.md checklist still directs new presets into it.
- Dead exports: `encodeGraphToHash` (legacy fat-hash encoder, invites misuse), `imageSamplerName`, `forLoop`, `BaseNodeFooter`. Dagre auto-layout is a dead feature (lays out the 4-node default graph once, ships in main bundle).
- eslint config gaps: no `argsIgnorePattern: '^_'`, generated `src/generated/` not ignored → ~25% of the 39 errors are noise burying the 2 real bugs.
- Git hygiene: generated audit reports + ~1.6MB of screenshots tracked (`drift-report.md`, `artifacts/visual-parity/`…); `docs/migration/` handoffs + `docs/audit/` untracked; `@types/dagre` unused; `@types/pako` in prod deps.
- `public/design-system.html`: 37KB hand-written token reference with hardcoded hex, outside the tokens pipeline, deployed publicly — contradicts "Figma is source of truth".
- `settingsStore` persist has no version/migrate (graphStore has both) — renamed enum values wedge until localStorage cleared.
- TypedEdge colors by source port only — coerced connections visually indistinguishable. `ds.ts:106` contains leaked Figma paint name `bg-gradient:linear` (inert, masked by inline style). NodeParameters renders nothing for `vec2/vec3` param types (latent). CommandPalette keyboard dies after a stray click (handler on backdrop, rows non-focusable). PixelatePreview `useViewport()` re-renders every node per pan/zoom frame. CLAUDE.md says "167/167" but suite is 159 (bridge's `validateAllWGSL` is the 167 one). Favicon is stock vite.svg; viewer.html has none.

### ⚖️ Round-1 corrections (adversarial re-verification)

- **CONFIRMED with executed repro**: 2-entry history corruption on connected-node delete (one undo = node-without-edges); param edits not undoable; reconnect bypasses dedupe/history/edge-data (wrong color specifically when source end moves to a different-typed output); WebGL anchor dead on static multi-pass (zero draws — u_anchor uploaded only during draws); preview stale-flag loss; WebGPU >8-intermediates break (≥10 total passes incl. relays; also per-frame texture-pool thrash in that state); reeded-glass chevron fork (chevron only, both paths reachable); renderer-key skip (real damage = one dropped uniform upload later).
- **REFUTED**: `useIR`/backend mismatch harm — WebGL renderer never reads `wgsl`; only cost is wasted IR compile time. IR coercion identity fallback — unreachable with today's 41-node library (float-only connectable params); latent only.
- **NARROWED**: posterize overshoot only at exactly c=1.0 (pure white), invisible at output (hardware clamp), only affects same-pass downstream math. ImageUploader wrong-canvas — happens when an image node mounts while any thumbnail exists (common mid-session); at app mount it correctly grabs the main canvas. resolveGroup-null wiring hole — unreachable on well-formed graphs (needs hand-edited/bridge-imported bad handles). Two-decls-on-one-line regex hazard — zero occurrences in current node code.
- **Round-1 live-test false alarm cleared**: share URL → viewer round-trip **works** for ordinary graphs (earlier failure was an audit-corrupted graph + the no-reload hash navigation above). Zoom toolbar confirmed fine (rAF stall artifact). Cmd+K opens/searches/creates fine (modulo R2 selection mismatch). Palette drag-drop payload (`application/reactflow`) parses correctly; reload persistence round-trips; Backspace deletes selected nodes.

### Round-2 verified OK

Export→import `.sombra` round-trip lossless (19/23 nodes/edges identity). localStorage reload identical. Preview modes docked/floating switch cleanly. Uniform-buffer layout math byte-verified correct on both paths (vec3 align-16 handled; offsets Map agreed by assembler, renderer, fast path). Texture binding numbering consistent (by samplerName, not position). mod lowering is floor-mod on both backends (no `%` sign hazard). DS pipeline fully healthy: 89/89 ds.* keys generated↔used, marker regions intact, queue empty, `tsc -b` 0, only 2 `as any` in src. NodePalette covers all categories; FloatingPreview resize math correct; resizable v4 shim correct; RandomDisplay JS/GLSL rounding parity holds.

## Self-validation suite (built 2026-07-12, post-audit)

`npm run self-validate` (`scripts/self-validate/index.ts`; `--no-gpu` / `--only=matrix,...` variants). Machine-checkable regression net for the audit's bug classes; writes `reports/self-validate/{matrix,invariants,fixtures,gpu}.json` + `latest.md` for agents/CI; non-zero exit on FAIL.

Checks: **matrix** — per-node codegen over the full param space (every enum combo, image loaded AND empty, inputs wired AND unwired), both backends, static uniform/binding contracts. **invariants** — preset params exist on definitions, showWhen keys, input ports actually read, CSS `var()` references defined, doc node-counts. **fixtures** — every `shaders/*.sombra|json` imports + compiles both paths. **gpu** — every unique generated shader really compiled in headless Chrome (WGSL `createShaderModule` + WebGL2). Note: WebGPU needs a secure context — the runner serves an ephemeral localhost page (about:blank silently lacks `navigator.gpu`).

**Post-fix status (same day): 0 FAIL / 1 WARN** — the fixes below were applied and the suite, verify-ir-poc (46/46), validate-wgsl-multipass (159/159), and `tsc -b` are all green. Fixed: u_anchor GLSL declaration (P0#1); main-IR imageSamplers chicken-and-egg (`imageSamplers: size>0 ? set : undefined` — first image node saw undefined, could never register) + explicit dual-backend WGSL in image.ts (unconditional sample + select() mask, vec2f clamp) (R1); random `??` (P0#6); rename map pixel_grid→dither + uv_coords→uv_transform pre-validation (P0#7/R6); file-import defaults-merge + stale-handle edge stripping; stripes migration NaN; default-graph + preset SRT params (R7); pixelate dead coords port removed; `--disabled-opacity` defined (+ds-queue entry) + text-caption→text-body; redo key + input-field guard (P0#5); chunked base64url encode (P0#4); dagre ESM interop unwrap. Remaining WARN = BROWSER-AUTOMATION.md node tables (23 vs 41) — doc overhaul left for planning. Runtime note: image rendering verified at shader/binding/GPU-compile level + preview chain; one manual glance at the main canvas in a visible browser recommended (automation panes report `visibilityState: hidden`, rAF never fires, so the editor canvas cannot present frames under automation — the standalone viewer, which renders its first frame synchronously, renders correctly with the fixed code).

**Fix-session addendum (same day, commits `8940428`/`e4d01c9`/`4219756`):** reconnect-duplicate + edge-data staleness fixed via atomic `graphStore.replaceEdge` (single history entry); ImageUploader dual-mount overlay mismatch fixed via `previewStore.mainCanvasSize` (ResizeObserver-fed, replaces per-instance `document.querySelector`); error surfacing shipped (ShaderNode error ring/badge, PreviewPanel `CompileErrorBanner`, `RenderPlan.wgslError` for IR-fail-GLSL-success — P0#2/P0#3); **compile-loop cluster (fix-order #4) fixed as one piece**: split semantic/uniform/renderer effects with independent timers (R5 starvation, R4 revert-stuck-spinner), post-compile re-collection of live param values pushed over the plan's dispatch-time snapshot (R3 clobber), unconditional renderer-key effect (skip), worker crash → respawn + single guarded retry + error surfacing, 10s dispatch watchdog for hung workers (R4 dead-session half; preview-scheduler's missing onerror/timeout still open). Uniform fast path now fixed 50ms debounce. Live-verified: revert-within-debounce settles spinner; interleaved semantic+uniform edits converge; same-tick anchor+semantic applies both. `use-live-compiler.ts` lint-clean (pre-existing useIR warning eliminated).

**Fix-session addendum 2 (same day, commits `b2c6221`/`3d66b52`):** preview-scheduler worker crash/hang recovery shipped (onerror respawn + requeue-once, pendingCompile timestamped with 10s hung-sweep in tick) — closes R4's second half. Two NEW findings discovered live during verification, both fixed: **(a) invalid edge sourceHandle → silent garbage codegen on both backends** (GLSL emitted literal `vec4(undefined, 1.0)`, IR emitted empty `vec4f(, 1.0)`; both reported success; failure only visible as unattributed GPU console error; unreachable via UI drag but reachable via stale saves/programmatic edges) — both generators now default-fallback + node-attributed error; **(b) color↔vec3 coercion asymmetry** — 'color' documented as vec3 alias but GLSL rule table only had vec3↔color (so float→color connections were rejected in UI while float→vec3 worked) and IR table had a different partial half (float→color fell to identity fallback = WGSL type error); both tables now carry the full vec3-equivalent set bidirectionally, which also widens legal connections (float/vec2/vec4 → color inputs now wirable).

**Baseline run (pre-fix): 416 FAIL / 1 WARN**, machine-confirming the audit:
- 191 unique GLSL shaders fail real GL compile — all `u_anchor` (P0#1, at full param-space scale)
- WGSL GPU: `unresolved value 'u_…_image_tex'` (R1) **plus** `no matching call to clamp(vec2<f32>, abstract-float, abstract-float)` — the image.ts cover-mode landmine, now GPU-confirmed
- `createDefaultGraph/def-noise` dead `scale` param (R7) + all Spectra preset param rot
- `pixelate.coords` dead port, `--disabled-opacity` undefined, `pixel_grid` fixture import failure, doc-count drift
- Bonus infra finding: CLAUDE.md calls `validate-wgsl-multipass.ts` "GPU compilation tests" — it's **regex heuristics only**; real GPU validation existed only in the browser dev-bridge until this suite. Also `@dagrejs/dagre`'s default-only ESM build needed an interop unwrap in `layout.ts` to run under node (vite wraps once, tsx twice).

## Suggested fix order for the planning session

1. **P0#1 u_anchor** (one line) — unblocks the entire WebGL2 backend and makes parity testing possible at all.
2. **R1 image pipeline on WebGPU** — thread imageSamplers through the main IR path into the assembler (mirror ir-subgraph-compiler), fix the two WGSL landmines in image.ts (clamp splat, derivative-uniformity), add image bindings to the WebGPU preview renderer. Image nodes are currently 100% dead on WebGPU.
3. **Error plumbing** (P0#2 + P0#3 + renderer-level errors → compilerStore + node-badge/toast UI) — every other failure becomes diagnosable once errors are visible. R1 shipped precisely because nothing surfaces.
4. **Compile-loop correctness cluster** (R3 uniform clobber, R4 stuck spinner + worker respawn, R5 slider starvation, renderer-key skip) — all in use-live-compiler.ts; fix as one piece.
5. **Save-compat set** (P0#6 random `??`, defaults-merge on file import, pixel_grid→dither AND uv_coords rename-map entries + validate-after-migrate ordering, localStorage SRT migration, stripes NaN, R7 default-graph param) — small diffs, protects user data.
6. **P0#4 share btoa** (chunked conversion) + P0#5 redo key + P0#8 hooks order + R2 palette selection order.
7. **WebGL preview backports** (P0#10: one-FBO-per-pass, reEmitSet filter, imageSamplers) — after #1, fallback previews become trustworthy.
8. **Viewer parity** (P0#9 + hashchange handling).
9. Then P1 clusters by area (undo model, reconnect path, y-flip parity, device-loss/GPUDevice lifecycle, scheduler races), guided by what the user feels most.
10. Tooling hygiene batch: eslint config (ignores + argsIgnorePattern), commit scripts/schema.ts + handoff docs, playwright-core dep or delete audit scripts, untrack generated reports.
11. Add the §Testing-gaps harnesses before large refactors (esp. before touching coercion tables / regex translator). Priority additions from Round 2: an image-loaded WGSL fixture (the entire loaded-image path is untested today) and a cross-backend pixel-diff harness (ternary-vs-select NaN class is invisible to everything else).
