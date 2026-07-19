# Primitive Pipeline Audit — 2026-07-18

Read-only audit of all 41 node primitives across 4 optimization axes. No code
changed. Ran as 5 parallel category auditors (input · math+vector ·
distort+noise · color+effect+output · pattern), each reading every assigned
node file fully.

**Axes:** (1) live-edit fast path (`updateMode` uniform vs recompile), (2)
pass/texture boundaries, (3) codegen quality (GLSL↔IR parity, dedup, loop
bounds, Y-space), (4) uniform packing.

**Lens:** gradient-work learnings — anchor-relative math, coords(Y-down) vs
`v_uv`(Y-up), GLSL↔IR parity, uniform-vs-recompile classification.

## Totals: 1 P1 · 4 P2 · 13 P3

> **Resolved 2026-07-19:** P1 (pixelate IR anchor) fixed. P2 random `decimals` +
> fbm `octaves` → `uniform`; remap range values → connectable uniform params
> (also matches the Figma template); dither alpha handled separately (no invented
> alpha — see the alpha-rule commits). P3 anchor-family fixed: warp texture-mode
> transform recentred on `u_anchor`; gradient pinned-branch dead uniforms trimmed.
> Remaining open P3s: cosmetics (grayscale double-swizzle, image vec4 rebuild,
> arithmetic dead fallback), remap divide-by-zero guard (skipped — naïve `max()`
> would break inverted ranges), warp `warped`-space semantics, softness-range
> consistency across pattern nodes.

37 of 41 files fully clean. No node is broken today; the P1 is latent
(non-center anchor only). Recurring themes: (A) a small anchor/parity bug
family — same class the gradient work fixed; (B) a few live-edit params stuck
on `recompile` that could be `uniform` (needless worker recompiles = drag jank).

---

## P1 — correctness/parity

- **[pixelate] `src/nodes/distort/pixelate.ts:111`** — IR `uv` output subtracts
  `u_resolution * 0.5` (hardcoded) where GLSL (`:60`) uses `u_resolution *
  u_anchor`. IR's own `pxl_px_` (`:99`) correctly uses `u_anchor`, so it's
  internally inconsistent too. **Impact:** on WebGPU (the primary renderer),
  the pixelate `uv` aux output diverges from WebGL whenever Fragment Output
  anchor ≠ center. Same bug class as the gradient anchor work.
  **Fix:** IR `:111` → `binary('*', variable('u_resolution'),
  variable('u_anchor'), 'vec2')`.

## P2 — suboptimal (works today)

- **[random] `src/nodes/input/random.ts:36`** — `decimals` is `recompile` but
  only feeds `pow(10.0, -decimals)`; shapes no loop/branch. Every slider step
  = full recompile while min/max/seed already update jank-free.
  **Fix:** `updateMode:'uniform'`, read `ctx.inputs.decimals`, emit
  `pow(10.0, -decimals)` at runtime.
- **[fbm] `src/nodes/noise/fbm.ts:44`** — `octaves` is `recompile`, but the
  loop is already `for(i<8){ if(float(i)>=oct) break }` (constant bound +
  runtime early break); `octaves` is passed as an arg, never baked. The
  "to promote to uniform, rewrite the loop" comment is stale — the rewrite
  exists. **Fix:** `updateMode:'uniform'`; delete stale comment.
- **[remap] `src/nodes/math/remap.ts:16-57`** — the four range values
  (`inMin/inMax/outMin/outMax`) are plain input ports, not `connectable`
  uniform params like `clamp`/`power`. Unconnected they bake as literals with
  no inline slider (can't tweak without wiring a Constant), inconsistent with
  the clamp/power pattern. **Fix:** make them `connectable:true` +
  `updateMode:'uniform'`.
- **[dither] `src/nodes/postprocess/pixel-grid.ts:60,162`** — no `textureInput`
  on `color`; computes cells from `gl_FragCoord` but applies the mask to the
  live per-fragment color rather than resampling upstream at cell centers, so
  it's a screen-space mask, not true per-cell pixelation (description
  overstates it). **Fix:** either add `textureInput:true` + sample the FBO at
  cell-center UV (like pixelate), or soften the description. *Design call —
  which behavior is intended?*

## P3 — nits (grouped)

Anchor/space family (same class as gradient, low impact):
- **[warp] `distort/warp.ts:84,162`** — texture-mode noise coords scale/
  translate about hardcoded `0.5` instead of `u_anchor`; noise + sampled image
  drift apart on scale/translate at non-center anchor.
- **[warp] `distort/warp.ts:104,244`** — `warped` vec2 output carries screen-UV
  space in texture mode vs auto_uv space single-pass; inconsistent semantics
  across the pass boundary.
- **[gradient] `pattern/gradient.ts:256-259,485-488`** — pinned branch adds
  `u_anchor`/`u_resolution`/`u_dpr` but body only divides by `u_ref_size`;
  those three are always covered by auto_uv/SRT preamble already → dead fields
  in the WGSL uniform struct. Trim to just `u_ref_size`.

Live-edit / dead-weight:
- **[image] `input/image.ts:41`** — `imageName` is `recompile` but never used
  in codegen; recompiles for nothing (piggybacks on `imageData` in practice).
- **[image] `input/image.ts:40`** — `imageData` recompiles on image *swap*
  where only the sampler binding changes; hard to split cleanly, note only.

Codegen cosmetics:
- **[image] `input/image.ts:102,198`** — `vec4(x.rgb, x.a)` identity rebuild of
  a vec4; assign directly.
- **[grayscale] `color/grayscale.ts:44-46`** — `.rgb.r` double-swizzle; index
  the vec4 directly (`.r/.g/.b`).
- **[arithmetic] `math/arithmetic.ts:89`** — dead `|| formatDefault(op)`
  fallback; compiler always pre-resolves ports.
- **[arithmetic] `math/arithmetic.ts:92 vs 104-107`** — GLSL flat join vs IR
  left-assoc chain; equivalent output, benign structural divergence.
- **[remap] `math/remap.ts:62,69`** — `/(inMax-inMin)` unguarded; inMin==inMax →
  NaN. Guard with `max(..., 1e-6)` in both paths.

Consistency:
- **[warp/noise/fbm]** — `spatial` config literal duplicated between the
  definition and `getSpatialParams({...})`; hoist to one `const`.
- **[stripes] `pattern/stripes.ts:29`** — `softness` max `1.0` vs `0.5` on
  checkerboard/dots, and different AA math each; a "0.5 softness" means
  different edge widths per node. Align range + normalization across the family.
- **[checkerboard/stripes/dots]** — no `ctx.isPreview` branch (unlike gradient)
  — correct: `fract`-tiling patterns are inherently placement-independent, can't
  render blank. Optionally add a one-line comment noting why.

## What's clean (confirmed, not assumed)

- **GLSL↔IR parity** holds everywhere except pixelate P1: pattern family diffed
  statement-by-statement; color-space fns, reeded-glass, fragment-output all
  mirror. WGSL sample-then-`select` in image is a documented uniformity
  workaround, not a divergence.
- **Pass boundaries:** per-pixel color ops (invert/grayscale/brightness/
  posterize/hsv/color-ramp) are all single-pass; pixelate/reeded-glass/polar
  correctly use `textureInput`; pattern generators are correctly single-pass
  sources; math/vector carry no `textureInput`.
- **Uniform packing:** `color` params ride the compiler's `padColorUniformValue`
  vec4 path everywhere; no dead uniforms except the gradient pinned-branch nit;
  Fragment Output alpha does not leak.
- **Shared functions** all go through `addFunction`/IR function registry (noise/
  hash dedup verified); loops all have constant bounds + early break.
- **Y-space:** checkerboard/stripes/dots immune (coords/auto_uv only, never
  `v_uv`); gradient's rework introduced no parity/Y-space regression.

## Suggested fix order

1. **P1 pixelate** IR anchor — one-line, both-backend parity restore, verify
   with `verify-ir-poc.ts` + non-center anchor.
2. **P2 random/fbm** → `uniform` — kills two needless-recompile sources; cheap.
3. **P2 remap** → connectable params — usability + consistency.
4. **P2 dither** — needs a design call (mask vs true pixelation) before touching.
5. **P3** — batch the anchor-family + cosmetics opportunistically.
