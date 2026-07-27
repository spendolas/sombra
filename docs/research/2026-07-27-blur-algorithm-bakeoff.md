# Which blur should Sombra use?

**Date:** 2026-07-27 · **Branch:** `research/blur-bakeoff` · **Status:** complete for the isotropic core; see [Gaps](#gaps-and-what-is-not-proven)

Conducted deliberately blind to any existing blur implementation, so the conclusion
rests on measurement rather than on what happens to be in the repo. (For the
record: no `blur`-named node exists under `src/`.)

The bar was set as *perceptual flawlessness with efficiency as the tiebreaker*, and
tricks were explicitly allowed — a method is disqualified only by a visible flaw,
never by being an approximation.

---

## Recommendation

**Use a radius-adaptive pyramid Gaussian, wrapped in a linear-light,
premultiplied-alpha bracket, with one LSB of dither on the final write.**

```
ingest   sRGB straight            ->  linear premultiplied
  N x    progressive halving      (each a 5-tap dual-filter box, N chosen from the radius)
  2 x    linear-sampled Gaussian  at the coarse level, sigma ~4px
  N x    progressive upsampling   (8-tap dual-filter)
egress   linear premultiplied     ->  sRGB straight + dither
```

`N = clamp(floor(log2(sigma / 4)), 0, 5)`, so the coarse-level sigma stays near 4px
at **every** radius. That single rule is what makes it work — see [why](#why-the-radius-must-drive-the-downscale).

Set the coarse sigma by **subtracting the pyramid's own blur**, not by dividing:

```
sigma_coarse = sqrt(max(0, sigma_target² − intrinsic²(N))) / 2^N
```

The down/up chain is itself a blur (measured intrinsic σ: 0.31 / 2.07 / 4.68 / 9.70
/ 19.21 / 38.99 for N = 0…5). Ignoring it runs 3–4.5% wide and puts a small step in
the blur width every time N changes — see [temporal](#temporal-stability).

It was the only candidate clean at every radius tested while its cost *falls* as
the radius grows:

| candidate | σ4 | σ12 | σ32 | σ64 | verdict |
|---|---|---|---|---|---|
| **pyramid Gaussian (adaptive)** | 36 | 23.8 | **14.7** | **14.4** | clean everywhere |
| separable Gaussian, linear-sampled | 36 | 100 | 260 | 516 | clean everywhere |
| separable Gaussian, full res | 68 | 196 | 516 | 1028 | clean everywhere |
| box ×3 (CLT) | 44 | 140 | 380 | 764 | flawed ≥σ12 |
| Kawase (5 passes, scaled offsets) | 22 | 22 | 22 | 22 | flawed ≥σ12 |
| dual filter (Bjørge) | 13.6 | 14.1 | 14.3 | 14.3 | flawed ≥σ32 |
| downscaled Gaussian (fixed ¼) | 4.2 | 6.2 | 11.2 | 19.2 | flawed at small σ |

*Cost = sampling work relative to one full-resolution tap, accounting for per-pass
resolution. Candidates are compared at **matched effective width**, then judged
against a true Gaussian of the width each actually achieved.*

Shape accuracy is indistinguishable from a full-resolution Gaussian — mean error
against the matched ideal, in 8-bit codes:

| σ | full-res Gaussian | pyramid Gaussian |
|---|---|---|
| 4 | 0.10 | 0.08 |
| 12 | 0.27 | 0.34 |
| 32 | 0.62 | 0.52 |
| 64 | 0.44 | 0.58 |

At σ64 that is the same picture for **71× less sampling work**.

**Fallback if the engine is not changed:** the **linear-sampled separable
Gaussian**. It is clean at every radius too, needs no new engine capability, and is
free relative to the naive version — folding adjacent tap pairs into one bilinear
fetch halves the reads at *byte-identical* quality (0.14/5 vs 0.14/5 at σ8;
0.63/7 vs 0.63/7 at σ32). There is no reason to ever ship the unfolded form.

---

## What the pipeline costs you, before any algorithm is chosen

Three properties of Sombra's renderer decide blur quality independently of the
kernel. All three were measured (`reports/blur-bakeoff/phase2.md`).

### 1. Averaging must happen in linear light — mandatory

The renderer does no colour management: targets are plain (non-sRGB) `rgba8unorm`
and nothing linearizes. Averaging gamma-encoded values put the midpoint of a
blurred black/white edge at **sRGB 132 instead of 190** and destroyed **12% of the
scene's light**. Mean error against the reference: **18.43 codes naive vs 0.03
linearized**.

This is the single largest quality factor found, and it is free to fix — a blur
that linearizes its own taps is correct regardless of what the engine does.

### 2. Convolution must be premultiplied — mandatory

Image texels are uploaded with straight alpha. Blurring them drags colour out of
fully transparent pixels: a red disc on a transparent green field grew a **visible
green halo**, worst-case leak **53/255**. Premultiplied convolution leaked exactly
**0**.

<!-- proof: reports/blur-bakeoff/phase2/e2-straight-alpha.png vs e2-premultiplied.png -->

Alpha still passes through untouched, per the repo's don't-invent-alpha rule — a
fully opaque input returns fully opaque (min alpha 255/255).

### 3. Banding is an *output* problem, and dither is the fix

This corrected an assumption. Banding is a property of the final 8-bit write, not
of intermediate precision:

| intermediates | banding (mean plateau length) |
|---|---|
| 8-bit | 15.06 |
| float16 | 15.06 — *no improvement* |
| 8-bit + 1 LSB dither | **2.75** |

8-bit intermediates also did **not** accumulate meaningful drift on ordinary LDR
content: over a 16-pass chain both stayed under half a code. So for a normal
soften blur, **8-bit intermediates are adequate** and float16 buys nothing.

Dither raises numeric error (0.38 codes) while removing visible structure — a
reminder that the metric is a screen and the eye is the judge.

### 3b. float16 *is* required once values exceed 1.0

Blurring a 4×-bright disc through an `rgba8unorm` boundary clips everything above
display white: the centre returned **sRGB 137 instead of 255**, losing **67% of the
light**. float16 held it exactly.

The blur does not create those values — any upstream node (brightness, multiply)
can, and every 8-bit boundary silently clamps them. **This is the case for float16:
bloom and bokeh highlights, not banding.**

### 4. Per-pass downscale is the only affordable route to a wide radius

At σ24 a full-resolution kernel needs **386 taps per pixel**; a quarter-resolution
pyramid needs **100 taps on 1/16 of the pixels** — about **62× less sampling work**
for 0.66 codes of error. The engine allocates every intermediate at full canvas
size, so this is not expressible today.

---

## Engine changes the recommendation depends on

| # | Change | Needed for | Without it |
|---|---|---|---|
| 1 | **Per-pass resolution** (`RenderPass.resolution`, already specced in `PHASE6-MULTIPASS.md` P4 but unimplemented) | the pyramid winner | fall back to linear-sampled Gaussian; ~36× more sampling work at σ64 |
| 2 | **Raise the WebGL intermediate cap / add ping-pong reuse** — currently `min(8, maxTextureUnits-1)`, one FBO per pass, no reuse | deep pyramids on the WebGL2 fallback | wide radii unavailable on WebGL2; WebGPU (cap 32) is fine |
| 3 | **Opt-in `rgba16float` intermediates** | bokeh, bloom, any >1.0 chain | highlights clip; LDR soften blur unaffected |
| 4 | *(nice to have)* dither on the final write | removing banding | banding at ~15 plateau length instead of 2.8 |

Changes 1 and 2 are the real prerequisites. Note the platform is not the
constraint: this machine (AMD RDNA-2) supports `rgba16float` **and**
`rgba32float` render targets, so the 8-bit ceiling is an engine choice.

---

## Why the radius must drive the downscale

The fixed quarter-resolution Gaussian failed at **small** radii (detail error 3.73
codes at σ4) while being clean at large ones. Quarter resolution at σ4 puts the
coarse-level sigma at ~2px — too little to resample without visibly discarding
detail the blur should have kept.

Choosing the number of halvings from the radius so the coarse sigma stays near 4px
fixes both ends. Two details matter:

- **Halve progressively**, never resample in one big jump: each step is a 5-tap
  dual-filter box, which is what keeps the downsample from aliasing.
- **Keep the coarse blur a real Gaussian** (linear-sampled). The dual filter's own
  up/down kernels alone are *not* Gaussian enough — pure dual filter was flawed at
  σ32+ (edge error 16–19 codes) and its radius control quantizes to powers of two.

---

## Per-category results

### Isotropic soften — solved

As above. Winner: adaptive pyramid Gaussian. Fallback: linear-sampled separable.

### Directional (motion) — use a plain 1D Gaussian, full resolution

A single 1D pass is **O(σ)**, not O(σ²): ~259 taps at σ32 against ~518 for a
separable isotropic blur of the same width. It stays affordable at full resolution
and needs no pyramid. Clean at full tap count.

Do **not** cap the tap count while keeping the extent — a 9-tap version of a σ32
blur lands **22–24 codes** off ideal, which is visible ghosting.

### Radial (zoom / spin) — same kernel, but scale taps with the corner radius

No closed-form CPU ground truth exists (the kernel direction varies per pixel), so
this was judged on artifacts and by eye rather than against a reference. Clean at
65 taps, visibly ghosted at 17.

Its distinctive risk: sample spacing grows with distance from the centre, so a tap
count that looks clean near the centre ghosts at the edges. Drive the tap count
from the pixel radius at the **far corner**, not from a nominal strength.

### Bokeh — needs a real aperture and float16; a Gaussian cannot fake it

| variant | flat-top ratio @0.6R | beyond aperture | verdict |
|---|---|---|---|
| disc gather, 64 taps (sunflower) | flat | hard | clean |
| disc gather, 256 taps | flat | hard | clean |
| separable hexagon (3 skewed boxes) | flat | **0.452 — soft** | flawed |
| Gaussian of matched width | **0.673 — domed** | soft | flawed |

The Gaussian result is the point: bokeh is defined by a *flat-topped, hard-edged*
aperture, and no amount of Gaussian tuning produces one. Use a disc gather with
golden-angle (sunflower) tap distribution — 64 taps already reads clean.

Combine with §3b: bokeh is precisely the effect whose bright cores an 8-bit
boundary destroys, so **bokeh requires float16 intermediates**.

### Progressive / spatially varying — square the mask

The important finding. Building a progressive blur by stacking levels and blending
per pixel, the obvious implementation makes the per-pixel **pass count** linear in
the mask. That is wrong: repeated blurs accumulate as **σ ∝ √passes**, so perceived
blur rises steeply and then saturates, bunching the entire visible transition up
at the sharp end — a hard edge, clearly visible in the proof image.

Squaring the mask first makes σ linear across the ramp:

| configuration | stepping | verdict |
|---|---|---|
| 4 levels, linear mask | 13.04 | flawed — visible hand-off |
| 8 levels, linear mask | 15.73 | flawed |
| 4 levels, **quadratic** mask | — | clean |
| 8 levels, **quadratic** mask | — | clean |
| 12 levels, quadratic mask | 13.70 | marginal (just over threshold) |

---

## Temporal stability

The bake-off judged single frames. Two things can still ruin a blur in motion, and
both were measured through static equivalents (`reports/blur-bakeoff/phase5.md`,
`phase5b.json`).

### Pyramid crawl — not an issue

A blur commutes with translation, so *shift → blur → unshift* must give the same
image for any shift. A screen-aligned pyramid need not, and the residual would be
exactly the shimmer that appears when content moves under it. Measured across every
phase of the downsample grid:

| | σ12 | σ32 |
|---|---|---|
| pyramid Gaussian | 0.306 mean / 2 max | 0.200 / 2 |
| linear-sampled (control) | 0.270 / 1 | 0.183 / 3 |

The pyramid is as translation-invariant as a plain separable Gaussian. **Moving
content will not shimmer.**

### Radius pops — real, small, and halved by compensation

The level count steps at σ = 8, 16, 32, 64, and the down/up chain contributes its
own blur, so its contribution jumps while the coarse Gaussian's sigma drops — and
the two do not cancel. Sweeping σ in 0.5 steps on structured content:

| | median step | step at σ16 | step at σ32 | worst spike |
|---|---|---|---|---|
| naive `σ/2^N` | 0.343 codes | 0.906 | 1.028 | 3.90× at σ32 |
| intrinsic-compensated | 0.355 | 0.499 | 0.573 | 2.07× at σ32 |

So at a threshold the blur width moves about **3× a normal sweep step** — roughly
1 code — which compensation halves. Side by side, the naive pair straddling σ32 is
barely distinguishable, so this was never a large flaw; but it is measurable, and
the fix costs nothing. Compensation also fixes absolute accuracy (naive returned
33.98 for a requested 32.5, and 49.13 for 48).

**If a radius is animated**, the safest option is to **hold the level count fixed**
for the duration — no level transition can then occur. A fixed `N=2` spans σ 4.7 to
40+ for only 110 taps.

### Radius changes are recompiles

Tap and level counts bake as compile-time literals for GL ES 3.0 portability, so a
radius change rebuilds the shader rather than updating a uniform. The pyramid keeps
its tap count nearly constant across radii so its shaders stay small; a
full-resolution kernel grows without bound. Either way a dragged slider recompiles
per step — a live-update concern (debounce, or cap max taps and drive the active
count by uniform, which would also make radius fully continuous) rather than an
image-quality one.

---

## How "flawless" was decided

Flawlessness was enforced as a **gate, not a score**: detector screens run first and
a candidate with any detected flaw is eliminated *before* its cost is reported.
Efficiency only ever broke ties among the clean.

- **Ground truth** — a CPU reference blur in float linear light, premultiply-correct,
  verified against a brute-force 2D convolution and shown to leak no colour at
  alpha edges.
- **Matched width** — candidates parameterized by pass count (Kawase, dual filter)
  were calibrated so their measured 10–90% edge rise matched the target, then judged
  against a Gaussian of the width they actually achieved. Comparing at unmatched
  widths would have been meaningless.
- **Provocation stimuli first** — hard step edge, low-contrast ramp, high-frequency
  noise, transparent-edge sprite, bright highlights. A clean result on an easy photo
  proves nothing.
- **Calibrated thresholds** — every gate is set so the known-good control
  (full-resolution Gaussian) passes, and every detector was validated against a
  known-good and a known-bad input.
- **Both backends** — the winner agrees to **0.18–0.27 mean codes** between WebGPU
  and WebGL2 on four real photographs, and sits **0.49–1.97 codes** from the ideal
  Gaussian.
- **The eye last** — the detectors' verdicts were confirmed visually. Kawase's
  failure shows as a plainly visible crosshatch grid; the winner is
  indistinguishable from the reference.

Measurement bugs found and fixed along the way are documented in the commit
history rather than quietly corrected — several initially made the *known-good
control* look flawed, which is exactly how a miscalibrated harness fools you:
measuring effective width on sRGB instead of linear samples (inflated σ by 1.23×),
an absolute banding threshold on a stimulus with inherent plateaus, a canvas too
small for σ64 so clamp-to-edge dominated, and three separate "too dim / too noisy
to see the effect" false negatives.

---

## Gaps and what is not proven

Stated explicitly so the recommendation is not over-trusted:

1. **Temporal testing is indirect.** Crawl and radius pops were measured through
   static equivalents (translation invariance; a fine radius sweep) rather than by
   playing an animation, because the rig cannot animate. No true motion sequence was
   viewed, and no per-frame flicker detector on time-varying *content* was built.
   The σ-estimator's noise floor (~2× the expected step at 0.5σ granularity) also
   means pops smaller than ~3% of blur width cannot be resolved.
2. **The rig is not the engine.** Byte-exact passthrough proves the rig is
   internally faithful, but the winner has not been implemented as a real
   `NodeDefinition` and compared against the rig through Sombra's own compiler.
3. **Progressive is under-tested.** The rig binds two textures, so the candidate
   had to accumulate iteratively. The likely-better variant — bind N pre-blurred
   levels and interpolate between adjacent ones — was not testable and remains
   unproven. The iterative version still shows a visible transition band.
4. **Radial has no ground truth**, only artifact screens and the eye.
5. **Human sign-off is single-reviewer.** The plan called for blind re-scoring and a
   second reviewer for the shortlist; neither happened.
6. **No perf timing.** Cost is sampling work (taps × pixels), a good proxy but not
   measured frame time. Pass-count overhead and bandwidth are not in it.

---

## Reproducing

```bash
npm run blur:test                                  # 10 suites, 57 tests
npx tsx scripts/blur-bakeoff/probe-gpu.ts          # machine capability
npx tsx scripts/blur-bakeoff/phase2-pipeline.ts    # pipeline isolation
npx tsx scripts/blur-bakeoff/phase3-bakeoff.ts     # isotropic bake-off
npx tsx scripts/blur-bakeoff/phase3b-winner.ts     # real photos + both backends
npx tsx scripts/blur-bakeoff/phase3c-suite.ts      # directional/radial/bokeh/progressive
npx tsx scripts/blur-bakeoff/phase5-temporal.ts    # crawl + radius sweep
npx tsx scripts/blur-bakeoff/phase5b-fix.ts        # intrinsic-blur compensation
```

Reports and proof images land in `reports/blur-bakeoff/` (gitignored — regenerate
with the commands above). The harness itself is dependency-free pure TypeScript
plus `pako`; the GPU rig drives real Chrome through `playwright-core`.
