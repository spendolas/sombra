# `RenderPass.resolution` — per-pass render-target resolution

**Date:** 2026-07-29 · **Status:** IMPLEMENTED · **Scope:** plumbing only

Let a render pass rasterise at a fraction (or multiple) of the canvas size. Unblocks the
blur bake-off's radius-adaptive pyramid — the only affordable route to a wide radius, at
about **62× less sampling work** at σ24 — and supersampled effect passes.

This spec covers the **capability only**. No shipped node declares a scale when it lands,
so nothing changes visually. Rewriting `blur.ts` to the pyramid, and applying quality-tier
scaling to all intermediates (`PHASE6-MULTIPASS.md` P4), are separate, deliberate changes.

**Correction to the existing docs:** `PHASE6-MULTIPASS.md:368` states the field "is
supported in the data structure but not exposed in UI until Phase 2." It is not — no such
field exists on `RenderPass` (`src/compiler/glsl-generator.ts:51`). That line should be
fixed as part of this work.

---

## Why this is delicate

Every pass currently gets identical built-in uniforms — `uploadBuiltinUniforms(ps.uniforms,
w, h, dpr, time)` in `src/webgl/renderer.ts`, using the **canvas** `w,h` even for
intermediates. That sameness is load-bearing. The comment at `src/webgl/renderer.ts:838`
records a real bug where FBO size drifted from `u_viewport` and produced "a whole-frame
scale error plus an anchor offset that persists until some unrelated layout resize."

Three uniforms are resolution-coupled:

| uniform | consumers | wrong value gives |
|---|---|---|
| `u_resolution` | `auto_uv`, including the y-flip `u_resolution.y - gl_FragCoord.y` | flipped/offset pattern |
| `u_dpr` | `auto_uv` divisor; blur sigma; every px-authored param | wrong pattern scale |
| `u_viewport` | `frag/u_viewport`, `1.0/u_viewport` — blur, pixelate, pixel-grid, reeded-glass | wrong texel step |

## The uniform contract

For a pass at requested scale `s`, canvas size `W×H`, device texture limit `maxTex`, and
floor `minPx` (1 for the main renderers, 4 for the preview renderers):

```
s_eff = clamp(s, minPx / min(W, H), maxTex / max(W, H))   // ONE scale, both axes
tw = clamp(round(s_eff·W), minPx, maxTex)      th = clamp(round(s_eff·H), minPx, maxTex)
u_resolution = u_viewport = (tw, th)
u_dpr        = dpr · (tw / W)
```

`tw` and `th` are never clamped to `[minPx, maxTex]` independently. `s_eff` is derived
once from *both* axes — capped so neither axis's scaled size can cross `maxTex`, floored
so neither can drop below `minPx` — and then applied to both. Clamping `tw`/`th`
separately lets one axis hit `maxTex` while the other doesn't, decoupling the axes so the
scalar `u_dpr` (derived from `tw`) is correct for X and silently wrong for Y.

Everything else is untouched. `u_ref_size` stays frozen at `REFERENCE_SIZE = 512`;
`u_anchor` is unitless.

**`u_dpr` must scale with the pass.** This is the whole mechanism, and the one thing that
cannot be got wrong. Scaling `u_resolution`/`u_viewport` while leaving `u_dpr` alone yields
a `1/s` zoom — precisely the failure at `renderer.ts:838`.

**`u_dpr` derives from the actual integer texture width, never the requested float.**
Rounding otherwise desynchronises the uniforms from the rasteriser, the same bug class again.

### Why pinning and alignment survive exactly

Pinning is:

```
auto_uv = (vec2(fragX, u_resolution.y − fragY) − u_resolution·u_anchor)
          / (u_dpr · u_ref_size) + u_anchor
```

A point at normalised position `p` across the frame has `frag.x = p·s·W`. Substituting
`u_resolution = s·W` and `u_dpr = s·dpr`:

```
(p·s·W − s·W·a) / (s·dpr·ref) + a  =  W(p − a) / (dpr·ref) + a
```

Y-axis including the flip: `u_resolution.y − frag.y = s·H(1−p)`, giving
`H(1−p−a)/(dpr·ref) + a`. **`s` cancels on both axes.** The anchor lands at an identical
pattern-space coordinate at any scale.

This extends to every px-authored param, because the library already divides them by
`u_dpr`:

```
pixelate      pxl_size = floor(pixelSize · u_dpr + 0.5)
pixel-grid    size     = floor(pixelSize · u_dpr + 0.5)
reeded-glass  ribWidth · u_dpr,  wavelength · u_dpr
```

At scale `s`: `pxl_centered → s·px₁`, `pxl_size → s·size₁`, so
`cell = floor(s·px₁ / s·size₁)` is unchanged. Rib width, wavelength, cell size, gradient
centre and warp noise coords are all invariant.

Audit of all seven `u_resolution` consumers in `src/nodes/`:

| node | usage | verdict |
|---|---|---|
| `distort/warp` | full `auto_uv` formula | `s` cancels |
| `pattern/gradient` | Pinned divides by `u_ref_size` only | unaffected |
| `input/image` | `aspect / (u_res.x/u_res.y)` — a ratio | `s` cancels |
| `distort/pixelate` | px-space × `u_dpr` | `s` cancels |
| `postprocess/pixel-grid` | px-space × `u_dpr` | `s` cancels |
| `transform/reeded-glass` | aspect ratio; `·u_dpr/u_resolution`; `toPx` | `s` cancels |
| `input/resolution` | returns `u_resolution` raw | **changes meaning** — see Limitations |

## Design decisions

**A scale factor, not pixel dimensions.** Forced: the compiler runs in a Web Worker
(`compiler.worker.ts`) with no canvas size, so it cannot emit pixels. A float also
composes with the quality tier by multiplication, and a radius-adaptive pyramid needs
arbitrary values, ruling out a `'half' | 'quarter'` enum.

**Range `(0, 4]`.** Above 1.0 is supersampling, which is half the motivation. Additionally
capped by `maxTextureDimension2D` (WebGPU) / `MAX_TEXTURE_SIZE` (WebGL2). The
implementation also floors `s` at `PASS_SCALE_MIN = 1/64` — below that a pass carries no
usable signal — so the true supported range is `[1/64, 4]`.

**One texture per pass at its own size.** Not one max-size texture with a sub-rect
viewport: that needs a uv-rescale uniform per sampler, and bilinear at the sub-rect edge
samples neighbouring garbage. Both renderers and both preview renderers already allocate
one target per pass, so this follows the existing shape rather than fighting it.

## Components

### 1. Data — the field

`RenderPass.resolution?: number` in `src/compiler/glsl-generator.ts`, mirrored on
`plan.wgsl.passes[i]`. That duplication across the two arrays is the pattern
`textureFilter` already uses. Absent → `1.0`.

`src/embed/artifact.ts` needs **no change**: `passes.map(({ vertexShader: _pv, ...p }) => p)`
spreads the rest, so the field round-trips. Asserted by a test rather than assumed.

### 2. Producer — how a node declares it

Extend `multiPass` in `src/nodes/types.ts`:

```ts
multiPass?: {
  count: (params: Record<string, unknown>) => number
  from: string
  to: string
  /** Target scale for sub-pass `i`, relative to canvas. Default 1.0. */
  resolution?: (passIndex: number, params: Record<string, unknown>) => number
}
```

`src/compiler/expand-passes.ts` already carries the sub-pass index through
`SUBPASS_PARAM_KEY` (`params.__subPass`), so it propagates the scale onto the expanded
virtual node, and the partitioner copies it to the `RenderPass`.

A field nothing can write cannot be tested end to end. This is what makes the gates below
real rather than vacuous.

### 3. Main renderers

**WebGL2** (`src/webgl/renderer.ts`) — `allocateFBOs(count, width, height)` takes one size
for all passes; it needs per-pass sizes. `renderMultiPass` already does
`gl.viewport(0, 0, fbo.width, fbo.height)`, so the rasteriser side is correct already;
`uploadBuiltinUniforms` must take the pass's target size and scaled dpr instead of the
canvas values.

**WebGPU** (`src/webgpu/renderer.ts`) — same for `ensureIntermediateTextures(width, height)`
and `writeMultiPassBuiltinUniforms`.

**Staleness guards must become per-pass.** Both compare a single size pair —
`lastIntermediateWidth`/`lastIntermediateHeight`, and `fboPool[0].width !== w`. With mixed
scales those mis-compare and destroy/recreate the pool every frame. This is not cleanup: it
is the documented bug at `src/webgpu/renderer.ts:456`, where comparing against the wrong
count made the pool "destroyed and recreated every single frame."

### 4. Preview renderers

The same formula, with `W = H = PREVIEW_SIZE = 80` and base `dpr = 1.0` (preview also forces
`u_anchor` to `(0.5, 0.5)`). A pass at scale `s` gets `tw = th = clamp(round(s·80), 4, maxTex)`,
`u_resolution = u_viewport = (tw, th)`, and `u_dpr = 1.0 · (tw / 80)`. The floor is **4 px
rather than the main renderer's 1 px** — a 1×1 intermediate carries no usable signal at
thumbnail scale, and previews are advisory. Deliberate divergence, not an inconsistency.

Neither preview renderer ping-pongs — `src/webgl/preview-renderer.ts:308` documents why it
was removed ("relay passes read from non-adjacent passes, so ping-pong (index % 2) aliases
sources and creates GL feedback loops"). Both use one target per intermediate pass, which is
the shape this needs.

`ensurePassFBOs(count)` is **grow-only** and never resizes, so it must track size per index
and recreate an entry whose size changed. WebGPU preview hardcodes `PREVIEW_SIZE` at its
texture creation sites. The `BYTES_PER_ROW = 512` readback alignment applies only to the
final 80×80 target, which is never scaled — intermediates are not read back, so alignment
is not a concern for them.

## Limitations — documented, not fixed

**A sub-pass that lands in the plan's final pass is pinned to canvas size** —
which today is every `multiPass` node's last sub-pass. Neither
`fragment_output` nor its port declares `textureInput`, so it never starts a new
pass depth — it always joins whatever pass already feeds it
(`partitionPasses` in `src/compiler/glsl-generator.ts`). That means whenever a
`multiPass` node's output reaches `fragment_output` with no other texture
boundary in between — the shape of every `multiPass` usage today — its last
sub-pass lands in the plan's *final* pass. Both main renderers render the final
pass straight to the canvas/swap-chain at full canvas resolution, independent
of `RenderPass.resolution`: `src/webgl/renderer.ts` (`renderMultiPass`)
computes `tw = w, th = h, tdpr = dpr` for the last pass with the comment
"Render to screen — always full canvas resolution", and
`src/webgpu/renderer.ts:785` says the same ("The LAST pass draws to the
swap-chain texture, which is always full canvas size regardless of what it
declared"). A `resolution` returned for a node's last sub-pass index is
therefore silently ignored — a pyramid must put its full-resolution sub-pass
last. Documented for authors in `NODE_AUTHORING_GUIDE.md`.

**`passTargetSize`'s device-texture-limit clamp changes behaviour for
undeclared passes too, on hardware where the canvas exceeds it.** Before this
change, an intermediate pass was allocated at the raw canvas size with no clamp
against the device limit: the old `resizeFBOs`/`allocateFBOs` (WebGL2) used
`Math.floor(canvas.clientWidth * dpr)` directly against `gl.texImage2D`, and the
old `ensureIntermediateTextures` (WebGPU) passed canvas size straight to
`device.createTexture` — neither consulted `MAX_TEXTURE_SIZE` /
`maxTextureDimension2D` for the allocation itself (WebGL2 only used the limit to
pick `maxIntermediateTextures`, a pass *count*, not a per-pass size). On a
canvas that exceeds the device's texture limit, that is an oversized
`texImage2D`/`createTexture` call — a GL error or a WebGPU validation failure.
`passTargetSize` now clamps every intermediate pass into `[minPx, maxTexture]`
regardless of whether it declares a `resolution`, so gate 1 ("absent field ⇒
byte-identical") holds only *below* the device's texture limit. Above it,
behaviour changes from an erroring allocation to a correctly dpr-scaled smaller
target — an improvement, and the one exception to the no-visual-change claim.

**The `Resolution` node** (`src/nodes/input/resolution.ts`) returns `u_resolution` raw, so
inside a scaled pass it reports pass size rather than canvas size. Unreachable when this
lands: no shipped node declares a scale. The fix is a separate `u_canvas_size` standard
uniform, which costs both codegen paths plus four renderers — deferred until something
needs it.

**Sub-texel anisotropy.** `tw/W` and `th/H` can differ by up to 1 part in `min(W, H)`
(~0.1% at 1080p), and `u_dpr` is scalar. That bound holds only because `tw` and `th` are
rounded off the *same* shared `s_eff` (see "The uniform contract") — with a shared scale,
the residual really is pure integer-rounding noise, below anything observable, and a
second uniform is not worth it. The bound does **not** hold if `tw`/`th` are clamped to
`maxTex`/`minPx` independently instead of sharing one `s_eff`: an earlier draft did that,
and it decouples the axes by as much as `maxTex`'s shortfall against the larger axis — a
5K canvas at dpr 2 against an 8192 `maxTex` diverges by 25%, not 0.1%.

**Integer quantisation in `floor(… + 0.5)`.** `floor(pixelSize·s·dpr + 0.5)` is not exactly
`s·floor(pixelSize·dpr + 0.5)`, so a pixelate or pixel-grid *inside* a scaled pass shifts
its grid phase sub-cell. At `s = 0.5` a 7-device-px cell becomes 4, not 3.5. Only reachable
by pixelating at reduced resolution, which defeats the node's purpose.

**Texel centres do not coincide** between a scaled pass and full res. Ordinary downsample
phase — symmetric, so content is coarser but does not shift. Alignment is preserved;
sharpness is not, by definition.

**WebGL intermediate cap** stays at `min(8, maxTextureUnits − 1)` with one FBO per pass and
no reuse. Deep pyramids on the WebGL2 fallback need that raised — bake-off prerequisite #2,
out of scope here.

## Error handling

- Absent `resolution` → `1.0`, silently. This is the common "no scale declared" case, not an
  error, so it does not warn.
- Non-finite or `≤ 0` `resolution` → `1.0`, **silently**. The warning this bullet
  originally specified was removed: `normalisePassScale` is reached from `passTargetSizes`,
  which each main renderer calls 2–3× per frame, once per pass, so a plan carrying
  `resolution: -1` emitted hundreds of lines per second. The producer validates instead —
  `resolvePassResolution` (`src/compiler/pass-resolution.ts`) drops non-finite and `≤ 0`
  scales at compile time and can name the node, which the sizing helper cannot: it takes no
  pass identity in its signature. A decoded `.ombra` artifact bypasses that check
  (`resolution` is not validated on decode), so a corrupt plan reaches the helper directly
  and is clamped without comment.
- Clamp `s` to `(0, 4]`; clamp the resulting pixel size to `[1, maxTex]` in the main
  renderers and `[4, maxTex]` in the preview renderers (see above).
- A scale that would exceed device limits **clamps silently** rather than failing the plan.
  (The intermediate-*count* cap it was modelled on does warn; the per-pass size clamp does
  not, for the per-frame reason above.)

## Verification gates

Ordered; each must pass before the next means anything.

1. **Absent field → byte-identical.** Plan JSON and rendered pixels unchanged, comparing
   each backend against *itself* before and after the change. Not a cross-backend equality
   claim — WebGPU and WebGL2 are known to differ on frost by up to 51 codes via hardware
   bilinear (`docs/research/2026-07-29-frost-backend-divergence.md`), and this gate must not
   be written in a way that trips over that. The regression wall protecting existing graphs.
2. **Pinning gate.** 9 anchor positions × `s ∈ {0.5, 1, 2}` through a scaled intermediate;
   anchor placement pixel-identical to full res. Produces side-by-side images for review.
3. **Invariance gate.** Reeded-glass at fixed params in a scaled pass vs full res, measuring
   **phase/centroid**, not mean — a mean-only check passes a shifted pattern.
4. **Pool-thrash gate.** Count `createTexture`/`createFramebuffer` calls across frames with
   mixed scales; must be zero after warmup. Directly targets the `renderer.ts:456` bug.
5. **Artifact round-trip.** `publishScene` → `decodeArtifact` preserves `resolution`.
6. **Preview agreement.** A two-pass preview whose first pass declares `resolution: 0.5`
   allocates a 40×40 intermediate and still lands its content on the same pixel of the
   80×80 thumbnail. Both preview renderers are driven through their production entry
   points — `renderMultiPassPreview` (WebGL2, GLSL) and `renderWGSLPreview` (WebGPU, WGSL)
   — fed by `compileNodePreview`/`compileNodePreviewIR`. *Not* stated as "matches the main
   render downsampled": that comparison is unfalsifiable at 80 px against a 256 px capture
   through two different filter paths. The falsifiable claims are the allocated size and
   the centroid, and the size is the load-bearing one — a preview that ignored `resolution`
   outright produces a byte-identical thumbnail and passes every position metric.
7. **Existing suites unchanged:** `self-validate` (433 shaders, 0 FAIL), `verify-ir-poc`
   (85), `validate-wgsl-multipass` (159), `verify-wired-texture-branch` (53),
   `verify:embed` (7), `tsc`, `lint`.

Gates 2–4 and 6 all live in `scripts/verify-pass-resolution-gpu.ts`, reusing the
full-resolution capture harness in `scripts/blur-bakeoff/lib/`.

**Scope of `scripts/verify-pass-resolution-gpu.ts`.** It runs headless, so
`devicePixelRatio` is 1 throughout — it does not exercise a `dpr > 1` capture on any half.
It drives both main renderers (`WebGL2ShaderRenderer`, `WebGPUShaderRenderer`) and, since
gate 6 landed, both preview renderers (`WebGL2PreviewRenderer`, `WebGPUPreviewRenderer`).
Noted here so its green pass count isn't over-read.

Both halves of gate 6 were shown to fail on demand before being trusted: forcing the
preview renderers to ignore `resolution` left the centroid at exactly (51.500, 51.500) with
**0** differing bytes and was caught only by the 40×40 size assertion; keeping the size but
pinning the scaled pass's `u_dpr` to 1.0 moved the thumbnail's content 8.699 px.

## Files

| file | change |
|---|---|
| `src/compiler/glsl-generator.ts` | `RenderPass.resolution?: number` + WGSL pass mirror |
| `src/nodes/types.ts` | `multiPass.resolution?` |
| `src/compiler/expand-passes.ts` | propagate scale onto expanded nodes |
| `src/compiler/compiler.worker.ts`, `ir-compiler.ts` | emit onto both pass arrays |
| `src/webgl/renderer.ts` | per-pass FBO sizes; per-pass uniforms; per-pass staleness guard |
| `src/webgpu/renderer.ts` | same |
| `src/webgl/preview-renderer.ts` | per-pass sizes in `ensurePassFBOs`; per-pass uniforms |
| `src/webgpu/preview-renderer.ts` | same |
| `PHASE6-MULTIPASS.md` | fix the false "supported in the data structure" claim (line 368) |
| `scripts/` | gates 2, 3, 4, 6 |
| `src/embed/artifact.ts` | none — verified by gate 5 |
