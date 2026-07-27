# Image node crop/SRT gizmo — analysis + cleanup plan

**Date:** 2026-07-17
**Status:** analysis (no source changes made)
**Scope:** `src/components/ImageUploader.tsx` (minimap crop gizmo), `src/nodes/input/image.ts` (shader-side fit/fill), the framework SRT injection in `src/compiler/glsl-generator.ts` + `src/compiler/ir/wgsl-backend.ts` / `src/compiler/ir/glsl-backend.ts`.

## 1. How crop + SRT currently work, end to end

**Params** (`src/nodes/input/image.ts:39-51`): `imageData`, `imageName`, `imageAspect`, `imageWidth`, `imageHeight` (upload metadata) + `fitMode` (`contain`/`cover`) + the generic spatial params from `getSpatialParams({transforms:['scale','rotate','translate']})` (`src/nodes/types.ts:99-148`): `srt_scale` (0-10, default 1), `srt_rotate` (-180..180 degrees), `srt_translateX/Y` (-500..500, declared as generic px-ish units, `updateMode:'uniform'` so drags never trigger a recompile).

**Shader side, per frame:**
1. Image's `inputs.coords` default is `'screen_uv'` (`image.ts:31`), which the compiler resolves to raw `v_uv` — **not** the isotropic `auto_uv` (`glsl-generator.ts:329-331` vs `:319-328`). `v_uv` is 0..1 across the *live* canvas in both axes, so 1 UV-unit in x and 1 UV-unit in y do **not** represent the same pixel distance unless the canvas is square.
2. The framework's generic SRT injection (`glsl-generator.ts:538-581`, mirrored in `ir/wgsl-backend.ts:504-537` and `ir/glsl-backend.ts` for the two codegen backends) runs on that `coords` for any node with `definition.spatial`, Image included:
   - `srt = coords - u_anchor`
   - `srt /= scale`
   - rotate by `srt_rotate` degrees, **no aspect term** (deliberately dropped in commit `37230d0`, "spatial rotation is resolution-invariant (aspect-free)")
   - `srt -= vec2(tX, -tY) / (u_dpr * u_ref_size)` (translate, in frozen-reference px units)
   - `srt += u_anchor`
   - `inputs.coords = srt`
3. `image.ts`'s `glsl()`/`ir()` then apply fit/fill on top of that SRT'd coords (`image.ts:70-103`, IR mirror `:126-205`): compute `img_ratio = imageAspect / (u_resolution.x/u_resolution.y)`, then squeeze one axis depending on `contain` vs `cover`, then sample.

**UI side (`ImageUploader.tsx`):**
- `canvasToImageUV()` (`:46-85`) is a hand-written JS re-implementation of the *forward* shader chain (SRT + fit/fill) used to place the crop-viewport polygon on the thumbnail. `computePolygon()` (`:88-103`) forward-maps the 4 canvas corners through it to draw the polygon; `hitTestPolygon()` (`:205-245`) hit-tests vertices/edges/inside/outside against that polygon to pick a gesture mode + cursor.
- Drag gestures write params directly, using their own **inverse** derivations rather than reusing `canvasToImageUV`:
  - **Offset** (`applyDrag`, `:407-439`): client-pixel delta → thumbnail-pixel delta → image-UV delta → un-fit/fill (another hand copy of the ratio logic) → invert the SRT translate sign convention → clamp to `±imageWidth/2`, `±imageHeight/2` → round → write `srt_translateX/Y`.
  - **Scale** (`:441-464`): distance-from-anchor ratio → `newScale = startScale/ratio` → optional anchor-compensation translate so the dragged anchor corner/edge/center stays visually fixed, derived from an aspect+rotation-conjugated `Kx/Ky` term.
  - **Rotate** (`:466-474`): angle-from-centroid delta added to `startRotate`, wrapped to ±180.
- All gesture math starts from a frozen `DragState` snapshot taken at `pointerdown` (start offset/scale/rotate, anchor point, start distance/angle) and applies relative deltas each `pointermove` — this part is solid (no drift/accumulation bugs) and was recently hardened so `pointermove`/`pointerup`/`pointercancel` are bound on `window` for the drag's lifetime instead of the `<svg>` (commit `6ed5964`), because the gizmo restyles/moves the polygon every frame and can slide out from under the cursor mid-drag, silently dropping native pointer capture.
- Canvas size comes from `usePreviewStore().mainCanvasSize` (`useCanvasSize`, `:260-262`), fed live by a `ResizeObserver` on the single reparented main canvas — this is **live**, not the shader's frozen `u_ref_size`.

## 2. Concrete messiness

1. **Three-to-five hand-synced copies of the same math, one of them already stale.**
   - The fit/fill formula exists in `image.ts` (glsl + ir, mechanically mirrored — expected, that's the dual-backend convention) **and again** in `canvasToImageUV` (forward) **and again**, inverted, inline in `applyDrag`'s offset branch (`:419-424`). Any future fit/fill change (e.g. a third fit mode) needs to be found and updated in 3+ places by hand, with no shared source of truth and no test that would catch a miss.
   - The SRT chain exists in `glsl-generator.ts` + `wgsl-backend.ts`/`glsl-backend.ts` (expected — dual backend) **and again**, transcribed by hand, in `canvasToImageUV` — and this copy has already drifted from the real shader (see Bugs, below).
   - The scale-anchor compensation (`Kx`/`Ky` in `applyDrag`, `:451-456`) is effectively a *fourth*, from-scratch re-derivation of "how does the SRT respond to a scale change," done algebraically rather than by inverting a single shared function — it's the single hardest-to-follow block in the file and the docstring/comments don't explain the derivation, just the result.

2. **The SRT replica in `canvasToImageUV` is out of date with the real shader** (see Bugs #1 and #2). The file's own header comment ("Replicates glsl-generator.ts lines 479-509") points at a line range that no longer contains the SRT logic at all (SRT injection is now at `glsl-generator.ts:538-581`) — a good sign this comment/derivation predates a shader-side refactor and nobody revisited the UI math afterward.

3. **Tangled gesture-state / hit-testing / cursor-selection in one pass.** `hitTestPolygon` (`:205-245`) does geometric hit-testing (corner/edge/inside/outside), gesture-mode selection, *and* cursor SVG selection all in one function with early-return branches; `handlePointerDown` then re-derives anchor points from the same polygon a second time with its own corner-index bookkeeping (`cornerUVs`, `oppIdx`/`oppA`/`oppB` computed via mod-4 arithmetic). The corner-order convention (`[[0,0],[1,0],[1,1],[0,1]]`, index 3 = "top-left" per the comment at `:575`) is implicit and repeated in three places (`computePolygon`, `handlePointerDown`, the diamond-marker JSX) with no named constant — a reordering bug would be silent.

4. **Mixed responsibilities in one 608-line file.** Custom cursor SVG generation (`svgCursor`/`moveCursor`/`scaleCursor`/`rotateCursor`, `:140-199`, ~60 lines of hand-built SVG path strings) and the geometry/gesture math live in the same module as file-upload handling and the render/JSX. None of these need each other's internals.

5. **Magic numbers with no shared home.** `CORNER_ZONE=8`, `EDGE_ZONE=6`, `ROTATE_ZONE=20` (px, thumbnail space) are fine as tuned constants but aren't documented as to *why* those values, and the translate clamp range (`±imageWidth/2`, `±imageHeight/2`, `:431`) is inconsistent with the *declared* param range for the same field (`srt_translateX/Y` min/max is a flat `-500..500` from the generic `getSpatialParams()`, `types.ts:134-141`) — so the properties-panel numeric slider for Offset X/Y allows a different range than what the gizmo drag will ever produce (undershoots on large images, overshoots into "crop entirely off-image" territory on small ones).

6. **`aspect` is computed 3+ times** (`canvasToImageUV` internally, `applyDrag`'s scale branch, `applyDrag`'s offset branch's ratio calc) from the same two live numbers (`canvasW/canvasH`) rather than once and threaded through.

## 3. Bugs found

### Bug 1 (real, currently live): rotation aspect-handling mismatch between UI and shader
`canvasToImageUV` (`ImageUploader.tsx:61-67`) applies an **aspect-corrected** rotation (`sx *= aspect` before rotating, `sx = rx/aspect` after) to keep the visual rotation angle-preserving despite `v_uv` being non-isotropic on non-square canvases. Commit `37230d0` ("fix: spatial rotation is resolution-invariant (aspect-free)") deliberately *removed* the equivalent aspect term from the real SRT injection in `glsl-generator.ts` / `wgsl-backend.ts` / `ir/glsl-backend.ts`, with justification that "auto_uv is already isotropic... so a plain rotation gives a true, resolution-independent angle." **That justification is specific to `auto_uv`.** Image's `coords` default is `'screen_uv'` (`image.ts:31`), which resolves to raw, non-isotropic `v_uv` (`glsl-generator.ts:329-331`) — the framework SRT injection is generic over any `spatial` node and doesn't distinguish, so Image got the aspect term dropped from its *actual rendering* too. The commit's own message lists the nodes it checked ("stripes, dots, checkerboard, tile, warp, pixelate, polar, reeded_glass") — **Image is not in that list**, suggesting this generic node wasn't considered.
Net effect: on a non-square canvas, rotating the image via `srt_rotate` (shader-side) likely shears/warps rather than rotating cleanly, while the crop-gizmo overlay (still using the old aspect-corrected math) shows a clean rotation that no longer matches what's rendered. This is latent at `srt_rotate = 0` (the common case) since `sin(0)=0` makes the aspect term a no-op — which is probably why it hasn't been noticed. **Recommend visually verifying** (non-square preview + nonzero rotate) before deciding whether to fix the shader (add Image to the isotropic-coords set, e.g. switch its default to `auto_uv` and adjust fit/fill accordingly) or intentionally accept the shear and fix the UI math to match.

### Bug 2 (real, currently live): translate-basis mismatch after resize
The shader's SRT translate divides by the **frozen** `u_dpr * u_ref_size` (`glsl-generator.ts:574`, captured once on first render per `CLAUDE.md`'s "frozen reference sizing" convention). `canvasToImageUV`'s translate term and `applyDrag`'s offset-inversion both divide/multiply by `canvasW`/`canvasH` from `usePreviewStore().mainCanvasSize` (`ImageUploader.tsx:295`, `:326-331` `clientToSvg`, `:428-429`), which is **live** — updated by a `ResizeObserver` every time the window/panel resizes. Before any resize these are proportionally related (`u_resolution ≈ dpr·CSS-size` at load time), so it works at first. After a resize, the UI's basis for converting a drag delta to a `srt_translateX/Y` value diverges from the frozen basis the shader actually uses — dragging the gizmo will feel like it's under- or over-shooting relative to what actually moves in the preview.

### Bug 3 (real, likely live): gizmo ignores `u_anchor`
The real SRT recenters on the render's anchor pin before scale/rotate and re-adds it after (`srt = coords - u_anchor; ...; srt += u_anchor`, `glsl-generator.ts:548,577`) — `u_anchor` is a single global per-render setting (the "9-point anchor pin," default `[0.5,0.5]`, `src/webgpu/renderer.ts:86`, settable via `setAnchor()`). `canvasToImageUV` and the whole gizmo hard-assume the canvas center as the pivot (thumbnail UV 0..1 with no anchor offset anywhere). If the anchor pin is moved off-center, the shader's actual scale/rotate pivot moves with it but the crop-gizmo overlay and its gesture math do not — polygon and drag behavior would visibly diverge from the render. Not exercised by this investigation (didn't check whether the anchor pin is reachable/commonly used together with an Image node), but the code has no anchor term anywhere, so this is a structural gap rather than an edge case.

### Minor: bounds inconsistency (not a correctness bug, but user-visible)
`srt_translateX/Y`'s declared UI slider range is a flat `±500` (`types.ts:134-141`, generic to all spatial nodes) while the gizmo drag clamps to `±imageWidth/2`/`±imageHeight/2` (`ImageUploader.tsx:431`) — these disagree for any image not exactly 1000×1000ish, so the properties-panel numeric field and the gizmo drag have different effective ranges for the same param.

## 4. Staged cleanup plan (smallest-risk first)

Ordered so each stage is independently shippable and the riskiest math changes come last, after the shared utilities exist to reason about them in one place.

### Stage 0 — behavior-preserving: extract cursor SVG generation
Move `svgCursor`/`moveCursor`/`scaleCursor`/`rotateCursor` (`:140-199`) to a small `src/components/image-crop/cursors.ts` (or similar) with no other changes. Pure extraction, zero risk, immediately shrinks `ImageUploader.tsx` by ~60 lines and separates a concern that has nothing to do with SRT math. **Behavior-preserving.**

### Stage 1 — behavior-preserving: extract geometry primitives
Move `centroid`, `pointInPolygon`, `distToSegment`, `Pt` type to a small geometry util (shared home for any future gizmo, dovetails with the in-flight `docs/superpowers/specs/2026-07-17-preview-gizmo-gradient-pinnings-design.md` framework, which will need identical primitives). Straight extraction, no logic change. **Behavior-preserving.**

### Stage 2 — behavior-preserving: single source of truth for fit/fill math
Factor the fit/fill formula (currently duplicated in `image.ts` glsl, `image.ts` ir, `canvasToImageUV`, and inline in `applyDrag`'s offset branch) into one pure TS function with an explicit forward and inverse (e.g. `fitFillForward(uv, imageAspect, canvasAspect, fitMode)` / `fitFillInverse(...)`), used by both `canvasToImageUV` and `applyDrag`. The GLSL/WGSL copies stay as-is (can't share TS code with shader text) but gain a comment pointing at the shared TS util as the "spec." This directly kills messiness #1's fit/fill duplication and gives Bug fixes below a single place to land. **Behavior-preserving** (it's the same formula, just deduplicated) — verify via the existing `computePolygon`/`applyDrag` call sites producing byte-identical output before/after.

### Stage 3 — behavior-preserving: single source of truth for the *current* SRT forward+inverse
Write one pure TS module (e.g. `src/compiler/spatial-transform.ts` or colocate under `src/components/image-crop/`) with `applySRT(uv, params, canvasSize)` and `invertSRT(...)`, matching **whatever the shader currently does** (aspect-free rotation, frozen-ref-size translate divisor, anchor term included as a parameter even if Image always passes `[0.5,0.5]` today). Replace `canvasToImageUV`'s hand-rolled chain with a call to this module, and replace `applyDrag`'s ad hoc inverses (offset delta un-fit/un-SRT, and ideally the scale anchor-compensation `Kx/Ky` block) with calls to `invertSRT`/a small anchor-preserving-scale helper built on top of it. This is where Bugs 1-3 get *decided*, not silently fixed: pick the anchor/translate-basis/rotation semantics once, encode them in the one function, and every call site (polygon + all three gestures) automatically agrees with the real shader by construction instead of by manual re-derivation. **This stage is where behavior may change** for non-zero-rotation and non-square-canvas cases (Bug 1) and for anchor-pin-moved cases (Bug 3) and for post-resize drags (Bug 2) — flag those specifically for visual regression testing (square vs. wide canvas, rotate ≠ 0, before/after a window resize, anchor pin moved) before merging.

### Stage 4 — behavior-preserving: consolidate hit-testing / gesture-mode selection
Once Stage 1-3 land, revisit `hitTestPolygon` + `handlePointerDown`'s duplicate corner/anchor bookkeeping — name the corner-order convention as a constant (`const CORNER_UVS: Pt[] = [[0,0],[1,0],[1,1],[0,1]]`) shared by `computePolygon`, `handlePointerDown`, and the diamond-marker JSX, and consider returning the resolved anchor point directly from `hitTestPolygon` instead of re-deriving it in `handlePointerDown`. Cosmetic/structural, low risk once the math underneath is centralized.

### Stage 5 — decide, don't silently change: bounds consistency
Reconcile the `±500` declared param range vs. the `±imageWidth/2` gizmo clamp (messiness #5/minor bug). Either make the declared min/max image-size-aware (would need `NodeParameter.min/max` to accept a function of other params — a bigger, possibly out-of-scope framework change) or relax/remove the gizmo-side clamp to match the declared range and rely on the fit/fill sampling naturally going transparent/black outside image bounds. **Behavior-changing**, low blast radius (only affects extreme crop values), do last and call it out explicitly to the user rather than bundling it into the math refactor.

### Explicitly leave alone
- The `DragState` snapshot-at-pointerdown + relative-delta-per-pointermove pattern — already correct, not the source of any bug found here.
- The `window`-bound `pointermove`/`pointerup`/`pointercancel` drag lifetime (`:480-501`) — this was the recent, deliberate drag-release-robustness fix (`6ed5964`); don't touch.
- `useCanvasSize`'s reliance on `previewStore.mainCanvasSize` fed by the single reparented canvas's `ResizeObserver` — this itself is correct and already fixed a real multi-instance-overlay bug (per its own docstring); the *use* of a live size where the shader wants a frozen one (Bug 2) is the issue, not this hook.

## 5. Relationship to the in-flight gizmo framework

`docs/superpowers/specs/2026-07-17-preview-gizmo-gradient-pinnings-design.md` is building a generic `gizmo` framework (px-relative-to-`u_anchor` control points, mapped via `u_dpr`/`u_ref_size`/`u_anchor`/`u_resolution`, dragged on the *main preview*, not a thumbnail). The Image crop gizmo is a different shape of problem (a 4-corner polygon derived from SRT + fit/fill, rendered on a *thumbnail* in the node card/properties panel, not point handles on the main preview) — it should **not** be forced into that framework directly. But Stage 3's `applySRT`/`invertSRT` util (px ↔ coords, anchor/`u_dpr`/`u_ref_size`-aware) is exactly the same coordinate-mapping primitive the gizmo framework's "Coord mapping" section describes needing (see its "Inverse of the `auto_uv` pixel mapping" note). Worth writing Stage 3's util so the gizmo framework can import/reuse the SRT half (not the fit/fill half, which is Image-specific) once both exist — flag this as a shared-utility opportunity when that framework lands, not a blocking dependency for either effort.
