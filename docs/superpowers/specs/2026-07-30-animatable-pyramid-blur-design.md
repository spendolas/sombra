# Animatable pyramid-class blur — design + prototype findings

**Date:** 2026-07-30 · **Status:** prototype landed as `kawase_blur` (experimental), not the default.

## Problem

`pyramid_blur` bakes its pass count and per-pass resolution from the radius at compile
time, so radius is `recompile`-only and cannot be wired or animated. Sombra's premise is
"plug anything into everything" — a blur whose slider can't animate is a non-starter as a
default. We want a blur with an **animatable (uniform) radius** that stays clean and cheap.

## Feasibility (what the framework allows)

`expandMultiPassNodes` (`src/compiler/expand-passes.ts`) builds a **strictly linear** chain:
sub-pass *k* reads only sub-pass *k−1*, and `multiPass.count`/`resolution` are evaluated
**once at compile time**. Consequences:

- A **uniform radius** IS supported — connectable params propagate to every sub-pass.
- A pass **cannot read two prior passes**, and pass **count/resolution cannot vary by
  uniform**. So the literal "render band N and band N+1, cross-fade by fractional radius"
  (design option B) needs a real framework change (expand-passes + texture-boundary +
  renderer). It is NOT a shader-only / WebGPU-only fast path.

## Options weighed

- **B — framework cross-fade:** highest fidelity, smooth full range; ~a day of compiler +
  renderer work touching shared machinery. Deferred.
- **C — mip-assisted single pass:** needs per-frame WebGPU mip generation (renderer change);
  softer/blockier. Deferred.
- **D — multi-pass Kawase, fixed count, uniform offsets (CHOSEN for the prototype):** fits the
  framework today, zero surgery, radius is a live uniform. Cost fixed in radius; faint
  grid/shimmer possible at extreme radius.

## Prototype: `kawase_blur`

Fixed **5 passes**, full-res. Each pass fetches the 4 diagonal corners at ±off and averages
(0.25 each) — separable, so per axis it is two deltas at ±off, variance off². Across passes
variances add: σ_texels = k·√(Σ Aₚ²), Aₚ = `[1,2,3,4,5]`. The shader solves
`k = (radius·⅓·u_dpr) / √(Σ Aₚ²)` from the **live radius uniform**, so σ tracks radius/3 with
no per-radius calibration constant. Same quality bracket as every Sombra blur: linear-light +
premultiplied alpha (ingest folded into pass 0, egress into pass 5) + dithered 8-bit write;
alpha passes through.

Radius is `connectable: true` + `updateMode: 'uniform'` → wireable and animatable, no
recompile, no pop. Cost is constant in radius (20 fetches) — cheaper than the separable
Gaussian at large radius, fixed at small.

## Measured results (GPU, vs CPU Gaussian ground truth)

Edge rise-width ratio (measured / ideal 2.5631·σ), step edge, dpr 1:

| radius | 4 | 8 | 16 | 24 | 32 | 48 | 64 | 96 | 128 | 192 | 256 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ratio | 1.28 | 1.10 | 1.07 | 1.04 | 1.03 | 1.01 | 0.99 | 0.98 | 0.97 | 0.97 | 0.96 |

Within **~3%** of a true Gaussian across the mid-range; low-end over-blur (r=4 → 1.28) is
bilinear-tent variance on sub-texel offsets; high-end narrowing (r=256 → 0.96) is the sparse
taps starting to under-cover. Gate `scripts/verify-kawase-blur-gpu.ts` asserts: (1) compiled
shader byte-identical across radii → uniform-driven, no recompile; (2) width rises
monotonically over a radius sweep → no pop; (3) width within 20% of σ=radius/3 and reproduces
the CPU reference. 9/9 GPU. Live-verified in-app: radius 6→60→120 blurs progressively on one
byte-identical shader, no console errors.

## Low-end correction (done)

Added an intrinsic-tent subtraction (`INTRINSIC_TEXELS = 1.07`): the kernel targets
√(σ² − floor²) so the tent floor lands the output back on σ. Result: r=4 went 1.28→0.96,
and the whole r≥8 range holds within ~4% of a true Gaussian (gate tightened to 12%, 17/17).
Side effect: radius < 3.2 snaps to sharp (sub-pixel blur is below the tent floor and can't
be represented) — monotonic, no pop.

## Extreme-radius ceiling (measured — the look DOES demand more)

Grating-leakage test (`scripts/`, exploratory): how much of a high-freq grating survives the
blur, vs a true Gaussian (which crushes all of them → 0). Worst-case leakage over a period
sweep, by radius:

| radius | 32 | 48 | 64 | 96 | 128 | 192 | 256 |
|---|---|---|---|---|---|---|---|
| worst leak (codes) | 13 | 13 | 70 | 28 | 118 | 126 | 131 |

Plain 5-pass Kawase's clean ceiling was ~radius 48. Above it the fixed 5-tap kernel (a product
of cosines) developed passband recurrences — coherent grid leakage up to ~130–230 codes that
crawled in motion.

## Resolution: stochastic jitter (option C) — solves it, no framework surgery

Rotating the 4-corner tap pattern by a **per-pixel, per-pass hashed angle** both fills the
kernel gaps (each pixel samples a different orientation → the neighbourhood-average kernel is
smooth) and decorrelates the residual into **static, screen-fixed** grain (hash of position,
not time → no temporal crawl). Measured at radius 256:

| metric | plain Kawase | stochastic | ideal Gaussian |
|---|---|---|---|
| worst grating leakage (codes) | 131 | **9** | 0 |
| fixed-pixel flicker as content pans (codes) | tens (crawling grid) | **1–7** | 0 |
| static grain (codes) | — | **~1.8** (below the dither) | — |

This makes `kawase_blur` a clean, **large-radius, animatable** blur — the full ask — with a
**shader-only** change: no compiler or renderer surgery, no entanglement. Options A and B are
therefore not needed. Gate `scripts/verify-kawase-shimmer.ts` (5/5) asserts leakage < 20,
flicker < 12, grain < 4 at r=256 — all far below the un-jittered 131, so a future edit that
drops the jitter fails the gate. Shape/animatability gate still 17/17. Live-verified in-app: a
fine (cell-12) checkerboard at radius 150 washes to smooth grey, no grid/moiré.

## Open / next

- **Consolidation:** three blur nodes now (`blur`, `pyramid_blur`, `kawase_blur`). With Kawase
  now clean at large radius AND animatable, it is a candidate to become the DEFAULT blur (it
  spans small→large, animatable, fixed cost), with `pyramid_blur`/separable `blur` retired or
  kept as specialised. Decide the final palette story.
- **Grain vs a real photo:** confirm the ~1.8-code static grain is invisible on smooth
  gradients / photographic content (measured on gratings; expected fine).
