# Reeded Glass — rib-edge antialiasing

**Date:** 2026-07-28 · **Branch:** `research/blur-bakeoff` · **HEAD at measurement:** `d3923d1`
**Status:** decision, not shipped. `src/` untouched.
**Complaint:** "antialiasing on the rib edges — it's very rough."

Measurement corpus: `reports/blur-bakeoff/phase10/` (988 sweep rows × 2 backends, 31 calibration
gates, 3 independent adversarial passes). Every candidate ran the node's **actual emitted shader**
— nothing about the lens is reimplemented in the bench.

All three adversarial passes returned **QUALIFIED**, and all three converged on the same dissent:
**the sweep's winner (A3) is not the right fix.** That dissent is adopted below.

---

## 1. Diagnosis

### 1.1 What the map does

Closed form, validated against the emitted GLSL to 3.2e-7
(`reports/blur-bakeoff/phase10/analytic.json`):

```
k = min(clamp(curvature, 0.01, 1.0), 0.99)   amp = curvature > 1 ? curvature : 1
A = (ior − 1)·amp·k                           x   = 2·local − 1
L′(local) = ± [ 1 − A / (1 − k²x²)^{3/2} ]           ← rib-normal derivative
```

`ribWidth`, `srt_scale`, `u_dpr` and `u_resolution` all cancel. At the defaults (ior 1.5,
curvature 0.8): **L′ = +0.600 at the rib centre, −0.8519 at the seam**, max|L′| = 0.8519 — exactly
the brief's prediction, to 4 significant figures.

**Seam jump** = `2·F(D)·period` = **0.66667 × rib period**, closed form confirmed to 1e-6.
At ribWidth 80 CSS px, u_dpr 2 → 160 device px period → **106.7 device px of sampled displacement
across one pixel boundary**, drawn at 1 sample/pixel with no coverage term anywhere in the shader.

### 1.2 Apportionment

Ablation ladder, one change per step, seam-band mean error in 8-bit codes vs a 16×16 ground truth
(`phase10-apportion.json`, 9/9 gates):

| step | change | A0 | Δ |
|---|---|---:|---:|
| L0 | ior = 1, no lens (control) | 1.538 | — |
| L1 | lens on, bow 0, period 73.00 px (**integer**) | 1.030 | −0.509 |
| L2 | + bow 1 | 0.533 | −0.497 |
| **L3** | **+ srt_scale 1.07 → period 78.11 px, seam straddles pixels** | **2.357** | **+1.824** |
| L4 | + rotate 15° | 2.443 | +0.087 |
| L5 | L3 + ior 2.5 (31.5% of rib minifies) | 5.620 | +3.177 |
| L6 | L3 + curvature 1.5 (mirror fold active) | 10.468 | +4.848 |

| mechanism | verdict | evidence |
|---|---|---|
| **Seam C0 discontinuity** | **~100% of the aliasing excess at shipped defaults** | L2→L3 is +1.824 of a 2.357 total, and it is *purely a phase change* — same lens, same 52.07 px jump, only the period moved off an integer. p95 2→13, max 16→94. |
| **Phase-gating (new)** | the artifact is **not always present** | At `ribWidth × u_dpr × srt_scale` = an integer, no pixel ever straddles a seam and there is no seam error at all. `default`, `rib20`, `rib200`, `bow0`, `ior1p2`, `curv0p4`, `horizontal`, `dpr2` all read A0 ≤ 0.74. This is why it "sometimes looks rough". |
| **Oblique/curved seam staircase** | real, and the thing that reads as "rough" | Straight ribs at rotate 0 are *exactly* axis-aligned and cannot staircase. Step run: 114.6 px at 0.5°, 11.4 px at 5°, 1.0 px at 45°; wave/circular seams sweep 1.6 px → infinite twice per wavelength. Measured staircase 0.25932 px at rot 7° vs 0.000 at rot 0. |
| **Caustic (L′ → 0)** | **refuted — a non-event** | Two zero-crossings per rib at local 0.0774 / 0.9226 (6.0 device px from the seam). That ring reads **0.482** vs the 0.445 rib interior — statistically identical, 4.8× below the seam. At curvature 1.5 the caustic ring reads 0.446, *below* the 0.969 interior. Infinite magnification smears; smears do not alias. |
| **Minification** | **zero at defaults, dominant at extremes** | max\|L′\| = 0.852 < 1 → everywhere magnifying, 0% of the rib minifies in 1-D. Onset cliff is `curvature = 0.8095` at ior 1.5 (**one slider step** above the default) and `ior = 1.540` at curvature 0.8. Past it: \|L′\| = 52 one device px from the seam at curvature 1.0, 85 at half a pixel; caustics/rib go 2 → 4 → 8 → 28. |
| **Bow shear** | real 2-D minification, **benign** | σmax 1.326 over 35.7% of rib area at defaults, but L1→L2 measures **−0.497** — bow *reduces* error. |
| **Mirror fold** | inactive at defaults | Engages only at D > 1 (ior > 2.5 at curvature 0.8, ior > 1.285 at curvature 1.0). It is what makes L6 the worst config. |
| **`ANIMATED_DPR_SCALE = 0.75`** | **louder than the whole aliasing error — but not this complaint** | Same CSS scene, 1200×800 static vs 900×600 animated then upscaled: resolution loss alone with *perfect* AA = **4.568 codes**, vs **3.571 codes** for the entire aliasing error at static DPR. 77.3% of the animating error is a floor no node change can cross. **But** `setAnimated()` has exactly one caller — `src/App.tsx:82-83`, `isTimeLiveAtOutput` — and `notifyChange()` early-returns when not animated (`src/webgpu/renderer.ts:1020`). Dragging a slider does **not** trigger it. On a static graph at the default `adaptive` tier the user sees `STATIC_DPR_SCALE = 1.0`. |
| **Render Quality dropdown** | **the one engine lever that does apply with no animation** | `medium` sets `STATIC_DPR_SCALE = 0.75`, `low` sets 0.5, on both backends (`src/nodes/output/fragment-output.ts:88-98`, `src/webgpu/renderer.ts:997-1003`). A user on Medium eats the 4.568-code penalty permanently. **Check this before shipping anything.** |

### 1.3 Where the error actually lives

Zone decomposition of a straddling-seam frame (`z-phase`), and the fraction of pixels carrying a
visible error (`|A0 − GT| ≥ 8 codes`, `worst/look-worst.json`):

| zone | % frame | A0 mean / p95 / max |
|---|---:|---|
| seam ±3 px | 7.9% | **2.306 / 13 / 94** |
| caustic ±3 px | 15.6% | 0.482 / 1 / 14 |
| rib interior | 76.5% | 0.445 / 1 / 24 |

| config | error-bearing pixels | A0 mean / max on them |
|---|---:|---|
| misaligned | **0.59%** | 20.57 / 94 |
| rot15 | 0.54% | 22.28 / 117 |
| rot45 | 0.54% | 23.09 / 116 |
| wave-sine | 0.56% | 22.12 / 124 |
| curv1p5 | 4.02% | 18.20 / 142 |
| default (integer period) | 0.06% | 9.36 / 22 |

**The defect is 0.5–0.6% of the frame at 90–124 codes.** That is a hard, high-contrast, one-pixel-
wide line — not a broad softness. Confirmed visually: the luma profile across a seam at the defaults
is `197 197 197 197 196 196 196 196 | 193 193 193 193 193 193 192 192` — a clean step with **zero
transition pixels**.

The 0.44-code rib-interior term is **not** aliasing. It is the 1-px box prefilter: A0 point-samples
a bilinear texture while the reference box-filters. Measured, A0's far-field gradient energy is
**3–19% above** ground truth — A0 is *sharper* than correct, not aliased. This term is 76.5% of the
±3 px band and it is what the sweep's ranking metric was actually measuring (see §6).

---

## 2. Recommendation — **A4, analytic seam coverage**

**Not A3.** The sweep ranked A3 (2×2 rotated-grid supersample) first; three independent adversarial
passes each found that ranking unsound and each pointed at A4. Detail in §6. Summary of the
override:

On the error-bearing pixels — the only pixels where the complaint lives — A4 beats A3 on **every**
straddling / oblique / curved configuration, at **1/4 the fetches**:

| config | A0 mean/max | **A4 mean/max** | A3 mean/max |
|---|---|---|---|
| misaligned | 20.57 / 94 | **1.84 / 24** | 4.31 / 30 |
| rot15 | 22.28 / 117 | **3.86 / 21** | 6.89 / 54 |
| wave-sine | 22.12 / 124 | **4.97 / 30** | 6.42 / 68 |
| rot45 | 23.09 / 116 | **7.72 / 27** | 8.53 / 48 |
| ior2p5 | 11.26 / 53 | 11.26 / 53 (no-op) | **1.07 / 9** |
| curv1p5 | 18.20 / 142 | 18.20 / 142 (no-op) | **3.72 / 55** |

A3's only genuine wins are `ior2p5` and `curv1p5` — **minification and the mirror fold, a different
defect** (§8, open question 5). A3 also leaves a coherent same-sign dark terrace on the seam pixel
(rot45 cross-seam luma: GT `152 · 118 · 36 · 33`; A4 `153 · 107 · 48 · 33`, err 11/12; A3
`152 · 94 · 33 · 33`, err **24**/3 — identical on five consecutive rows), and its residual
periodicity at rot45 is **0.93, higher than A0's 0.89**.

### 2.1 The design

Compute the signed distance from the pixel centre to the nearest rib seam, along the seam normal,
in screen device px. If a seam falls inside the pixel, split the pixel at it and sample each side
at the centroid of its own sub-interval, weighted by coverage. Otherwise take today's single tap.

**No hardware derivatives anywhere.** The seam normal and rate come from `rg_gm_*`, `rg_gp_*`,
`rg_den_*` — the analytic wave gradients `emitScreenDelta` (`reeded-glass.ts:204-253`) already
computes — and the rib rate is exact in closed form. This is the house style and it sidesteps three
constraints at once:

- **WGSL `derivative_uniformity`** is a non-issue: measured on real Tint, `fwidth` inside the
  `frost > 0.001` branch is rejected (`'fwidth' must only be called from uniform control flow`) and
  the failure is silent — `createRenderPipeline` returns a pipeline object and the whole frame is
  dropped at draw. We emit no derivative builtin at all.
- **The missing `dFdx → dpdx` translator rule** (`wgsl-backend.ts` has no derivative entry;
  `dFdx` passes through unmapped and fails at Tint as `unresolved call target`) never applies.
- **Differentiating the wrong quantity.** Measured: `fwidth(rg_sampleUV.x)` returns **52.6 px/px**
  (the jump, not the slope) at the seam — and only on ~50% of sub-pixel phases, so a derivative-
  driven seam detector would *blink* as the user drags translate or resizes. The analytic rate reads
  exactly 1.000 at every phase.

### 2.2 The GLSL

Drops in identically to both paths: `glsl()` pushes these as strings into `lines`; `ir()` wraps the
same strings in single-argument `raw()` **except** where noted. `{ID}` is `${id}`; `{S}` is the
sub-sample suffix (`_a` / `_b`); `{RESPERP}` is `u_resolution.y` for vertical ribs, `u_resolution.x`
for horizontal.

**Step 1 — seam geometry.** Insert immediately after `emitScreenDelta`'s lines
(`reeded-glass.ts:505` in `glsl()`, `:797` in `ir()`). Single-argument `raw()` — pure scalars and
pattern-basis (y-up) vectors, mechanically translatable.

```glsl
// --- rib-seam coverage AA ------------------------------------------------
// phi = rib phase; seams sit at integer phi. |grad phi| per SCREEN device px
// is exact: sqrt(den)/(ribWidth * u_dpr * srt_scale). rg_den_{ID} is already
// (1+gm)^2 + gp^2 from emitScreenDelta — no derivative builtin, no re-eval.
float rg_phi_{ID} = rg_wm_scr_{ID} / rg_ribUV_scr_{ID};
float rg_prd_{ID} = ${inputs.ribWidth} * u_dpr * ${inputs.srt_scale};
float rg_gl_{ID}  = sqrt(rg_den_{ID}) / max(rg_prd_{ID}, 1e-6);
// signed distance, pixel centre -> nearest seam, along +n, in device px
float rg_ss_{ID}  = (floor(rg_phi_{ID} + 0.5) - rg_phi_{ID}) / max(rg_gl_{ID}, 1e-9);
// seam normal in SCREEN axes. Device px are isotropic, so this is a plain
// R(-theta) — no aspect conjugation (that exists in emitScreenDelta only
// because the delta there is in per-axis UV, not px).
vec2 rg_n_{ID} = ${isVert
  ? `vec2(1.0 + rg_gm_${id}, rg_gp_${id})`
  : `vec2(rg_gp_${id}, 1.0 + rg_gm_${id})`};
rg_n_{ID} = vec2( rg_n_{ID}.x * cos(rg_rad_scr_{ID}) + rg_n_{ID}.y * sin(rg_rad_scr_{ID}),
                 -rg_n_{ID}.x * sin(rg_rad_scr_{ID}) + rg_n_{ID}.y * cos(rg_rad_scr_{ID}))
          / max(sqrt(rg_den_{ID}), 1e-9);
// half the unit pixel's support projected on the normal
float rg_hw_{ID} = (abs(rg_n_{ID}.x) + abs(rg_n_{ID}.y)) * 0.5;
// coverage of the two sides and the centroid of each sub-interval, in px
float rg_la_{ID} = rg_ss_{ID} + rg_hw_{ID};
float rg_lb_{ID} = rg_hw_{ID} - rg_ss_{ID};
float rg_ca_{ID} = (rg_ss_{ID} - rg_hw_{ID}) * 0.5;
float rg_cb_{ID} = (rg_ss_{ID} + rg_hw_{ID}) * 0.5;
float rg_wa_{ID} = rg_la_{ID} / max(2.0 * rg_hw_{ID}, 1e-6);
bool  rg_split_{ID} = abs(rg_ss_{ID}) < rg_hw_{ID};
```

**Step 2 — the lens tail, per sub-sample.** Refactor `reeded-glass.ts:494-505` (`glsl()`) /
`:781-797` (`ir()`) into an emitter `emitLensTail({ id, sfx, offPx, … })` that produces the block
below, and call it three times: `sfx = ''` with `offPx = '0.0'` (today's centre tap, unchanged),
then `sfx = '_a'` / `'_b'` with `offPx = 'rg_ca_{ID}'` / `'rg_cb_{ID}'`.

The wave field is **first-order extrapolated, not re-evaluated** — `Δwm = t · |∇φ| · ribUV_scr`,
exact for straight ribs and accurate to O(0.25·w″) over ±0.5 px for curved ones. This is the whole
cost saving on noise ribs (§4). `rg_gm`, `rg_gp`, `rg_den` and `rg_srt_scr` are reused verbatim
from the centre fragment. Single-argument `raw()`.

```glsl
float rg_wm{S}_{ID}   = rg_wm_scr_{ID} + ({OFFPX}) * rg_gl_{ID} * rg_ribUV_scr_{ID};
vec2  rg_lens{S}_{ID} = reedLens(rg_wm{S}_{ID}, rg_ribUV_scr_{ID},
                                 ${inputs.ior}, ${inputs.curvature});
float rg_disp{S}_{ID} = rg_lens{S}_{ID}.x - rg_wm{S}_{ID};
float rg_bow{S}_{ID}  = rg_lens{S}_{ID}.y * (${inputs.ribWidth} * u_dpr * 0.5)
                        * ${inputs.bow} / {RESPERP};
// … emitScreenDelta tail with disp = rg_disp{S}_{ID}, bowPerp = rg_bow{S}_{ID},
//    reusing rg_gm_{ID} / rg_gp_{ID} / rg_den_{ID}, producing rg_d{S}_{ID} …
```

**Step 3 — the sample positions.** ⚠️ **These lines MUST be a two-argument `raw()` with a
hand-written WGSL arm**, for exactly the reason the existing `:809-813` already is: the base is
`gl_FragCoord`, which the assembler rewrites to `in.position` — **y-down on WGSL** — while
`rg_n_{ID}` and `rg_d{S}_{ID}` are both derived from `v_uv`, which is **y-up on both backends**
(`wgsl-assembler.ts:343-348`).

```glsl
// GLSL arm
vec2 rg_sampleUV{S}_{ID} = (gl_FragCoord.xy + rg_n_{ID} * ({OFFPX})) / u_viewport
                           + rg_d{S}_{ID};
```
```wgsl
// WGSL arm — TWO independent y negations on one line, for two different reasons
let rg_sampleUV{S}_{ID} = (in.position.xy + vec2f(rg_n_{ID}.x, -rg_n_{ID}.y) * ({OFFPX}))
                          / uniforms.u_viewport
                          + vec2f(rg_d{S}_{ID}.x, -rg_d{S}_{ID}.y);
```

Measured consequence of getting this wrong: dropping **one** of the two flips takes A3-class
supersampling at rot45 from 0.082 back to 0.380 codes — **97% of the benefit gone** — while still
issuing the extra fetches and still *looking* antialiased, with a max deviation of only 10 codes.
And it reads **exactly 0.000** at the defaults, because for straight unrotated vertical ribs
`rg_srt_scr.y` is never consumed. It is invisible in every configuration a developer would eyeball
first. Add a WGSL-vs-GLSL parity assertion at `rot45` to `validate-wgsl-multipass.ts`; the phase-10b
parity gate is structurally blind to it (the bench ran mirrored patterns per backend, so its
"0 of 494 cells over 1 code" was measuring two different sample patterns agreeing with each other).

**Step 4 — the blend.** Goes inside the **existing** two-argument `raw()` frost block
(`reeded-glass.ts:838-877`), replacing the `else` arm. Both arms are already hand-written twins
there, so this is an edit to existing hand-written WGSL, not a new one.

```glsl
// GLSL else-arm
} else if (rg_split_{ID}) {
  vec4 rg_A_{ID} = texture({SAMPLER}, rg_sampleUV_a_{ID});
  vec4 rg_B_{ID} = texture({SAMPLER}, rg_sampleUV_b_{ID});
  float rg_pa_{ID} = rg_A_{ID}.a * rg_wa_{ID};
  float rg_pb_{ID} = rg_B_{ID}.a * (1.0 - rg_wa_{ID});
  float rg_ao_{ID} = rg_pa_{ID} + rg_pb_{ID};
  {COLOR} = vec4((rg_A_{ID}.rgb * rg_pa_{ID} + rg_B_{ID}.rgb * rg_pb_{ID})
                 / max(rg_ao_{ID}, 1e-5), rg_ao_{ID});
} else {
  {COLOR} = texture({SAMPLER}, rg_sampleUV_{ID});
}
```
```wgsl
// WGSL else-arm — textureSampleLevel ONLY (legal under non-uniform control flow;
// plain textureSample is not, and Tint's rejection is silent — see :822-835)
} else if (rg_split_{ID}) {
  let rg_A_{ID} = textureSampleLevel({SAMPLER}_tex, {SAMPLER}_samp, rg_sampleUV_a_{ID}, 0.0);
  let rg_B_{ID} = textureSampleLevel({SAMPLER}_tex, {SAMPLER}_samp, rg_sampleUV_b_{ID}, 0.0);
  let rg_pa_{ID} = rg_A_{ID}.a * rg_wa_{ID};
  let rg_pb_{ID} = rg_B_{ID}.a * (1.0 - rg_wa_{ID});
  let rg_ao_{ID} = rg_pa_{ID} + rg_pb_{ID};
  {COLOR} = vec4f((rg_A_{ID}.rgb * rg_pa_{ID} + rg_B_{ID}.rgb * rg_pb_{ID})
                  / vec3f(max(rg_ao_{ID}, 1e-5)), rg_ao_{ID});
} else {
  {COLOR} = textureSampleLevel({SAMPLER}_tex, {SAMPLER}_samp, rg_sampleUV_{ID}, 0.0);
}
```

**The blend is premultiplied**, matching the frost accumulator and the node's own comment at
`:516-518` / `:816-818`. Measured: straight-alpha averaging vs premultiplied differs by up to
**191 codes** in RGB on a transparent-edge sprite, and **0 codes** on opaque content. Every one of
the 26 sweep stimuli is fully opaque, so all 988 rows are unaffected *and the alpha path was never
exercised* — this needs its own gate before merge.

### 2.3 Things that must NOT be done

Each is measured, and each fails **silently on WebGPU only** while passing on WebGL2:

- **Do not hoist the body into a helper `fn`.** `wgsl-assembler.ts:275-276` runs `rewriteFragCoord`
  and `rewriteVaryingReferences` over `functionsCode`, so a helper touching `gl_FragCoord`/`v_uv`
  emits `in.position` at module scope → real Tint: `L26:39 unresolved value 'in'`. Inline the three
  sub-samples with suffixed declaration names instead.
- **Do not use an offset array.** `const vec2 rk[2] = vec2[2](…)` translates to
  `const vec2f rk[2] = vec2f[2](…)`, which is not valid WGSL (needs `array<vec2f,2>`). Unroll.
- **Do not hand-write the `rg_srt_scr` or `rg_n` lines.** They are y-up on both backends and
  translate correctly; hand-writing them is precisely how a sign flips.
- **Do not add `diagnostic(off, derivative_uniformity)`.** It works on Tint (measured), and it
  re-opens the `b56c19c` silent-frame-drop class while returning helper-lane garbage.
- **Note the ternary rule:** any hand-written WGSL arm must spell `select(falseVal, trueVal, cond)`
  itself (argument order reversed vs GLSL), and `mod` as `sombra_mod`.

### 2.4 Fetch count and cost

| | fetches/fragment | GPU µs @1200×800, WebGPU, AMD RDNA-2 |
|---|---:|---:|
| A0 today, straight ribs | 1.000 | 8.0 |
| **A4, straight ribs** | **1.004 – 1.020** (2 worst case) | **12.7** (+4.7 µs, **+59%**) |
| A4, wave-sine | 1.020 | 21.7 (A0 11.6) |
| A4, circular | 1.017 | 26.9 (A0 15.1) |
| A4, **noise ribs** | 1.016 | 253.1 (A0 118.4) |
| A3 for comparison, straight / noise | 4.000 | 21.3 / **460.5** |

+4.7 µs at 1200×800 is 0.028% of a 16.7 ms frame. At 1920×1080 CSS × dpr 2 (8.6× the pixels) it is
~40 µs.

**Caveat, stated plainly:** those A4 figures are for the *benched* A4, which evaluates the truncated
node body 5 extra times for a central-difference gradient. The shipped form in §2.2 reuses
`rg_gm`/`rg_gp`/`rg_den` and first-order-extrapolates `wm`, so it evaluates the wave field **once**
instead of five times. The numbers above are therefore an **upper bound**, and the gap is largest
exactly where it matters — on noise ribs, ~110 µs of A0's 118 µs is noise ALU. **One re-measure is
required before merge** (§9). Cost is not fetch-driven on this node; the sweep ranked on
`fetchesMeasured`, which cannot see this at all.

---

## 3. How it combines with the frost gather

Frost is `connectable: true`, so `frost > 0.001` may be data-dependent. The branch already exists
and already uses `textureSampleLevel` in both arms. The plan:

| path | scheme | fetches |
|---|---|---|
| **AA on, frost off** | 2-tap coverage blend inside the seam band, 1 tap outside | **1.004 – 1.020 average, 2 worst case** |
| **AA on, frost on (today, 8 taps)** | per-tap coverage *selection*: tap *j* uses base `rg_sampleUV_a` when `reedHash(...).y < rg_wa`, else `rg_sampleUV_b` | **8.000 exactly — no increase** |
| **AA on, frost on (phase-9 winner, 16 taps)** | same | **16.000 exactly — no increase** |

**The product never forms.** The coverage split is a choice of *base position* per tap, not an extra
tap: it reuses the second component of the hash the gather already computes, costs zero fetches, and
is unbiased — the N-tap average converges on the exact coverage blend.

Why the split is needed at all rather than "frost already covers it": measured, at frost 0.3 the
gather radius is 7.2 device px and A0's seam-band error is already **0.32 codes** — the gather does
subsume the seam once the radius exceeds a pixel. The gap is `0.001 < frost < ~0.05`, where the
radius is sub-pixel (at frost 0.0011 it is 0.026 device px and all taps collapse to one point).

**Explicitly rejected fallback:** "gate the AA on `frost <= 0.001`". At frost 0.0011 that
discontinuously loses all AA while the gather is still a point sample — and `frost` is connectable,
so an animated input crosses that threshold every frame. Do not ship it.

Residual risk, quantified: the split is stochastic, so on band fragments it adds variance
≈ step·√(wa·wb/N) ≈ 10 codes at N=16 for a 50/50 split — as noise, not a staircase, and strictly
better than today (all N taps on one side → the full 80–124-code error). **Not benched** (the sweep
measured A3×frost = 32 fetches, and A9 tested a different scheme entirely). Gate before merge:
`frost0p3` band p95 must not regress from 1, and a new sub-pixel-radius config (`frost0p02`) must
reach the frost-off A4 numbers.

Two frost details this touches:
- The gather's per-tap mirror fold (`:535` / `:849` / `:867`) is applied on the frost path but not
  to `sampleUV` on the frost-off path (`:542` / `:874`), which uses `CLAMP_TO_EDGE`. Crossing
  frost 0 → 0.001 pops the frame border from clamp-smear to mirror. Pre-existing; the two new
  `rg_sampleUV_a/_b` must follow the frost-off convention (no fold) to stay consistent.
- The tap count `8` is hardcoded in **six** places across three hand-maintained copies:
  `:532`/`:540` (`glsl()`), `:846`/`:854` (IR GLSL arm), `:864`/`:872` (IR WGSL arm). Any shared
  change touches all six.

---

## 4. What it costs

**+4.7 µs at 1200×800 on straight ribs (upper bound; the shipped form should be less).** 0.028% of
a 16.7 ms frame. Worst measured rib type is `noise` at +134.7 µs upper bound — that figure is the
one most inflated by the bench's redundant gradient evaluations and is the reason §2.2 reuses
`gm`/`gp` rather than re-differencing.

**Zero softening away from the seam — and zero improvement there either.** A4 is *bit-identical* to
A0 outside the seam band: the zone table reads A0 0.4448 / A4 0.4448 in the rib interior (76.5% of
frame) and 0.482 / 0.482 in the caustic ring. hfLoss is unchanged from A0 on every config.

That is a deliberate trade. A3 would have removed the 0.44-code interior term at 4× the fetches —
but that term is the 1-px box prefilter, and the measurement says A0 is **3–19% sharper** than the
box-filtered reference, not aliased. Matching a box filter would make the node softer everywhere to
fix something the user did not complain about. If the user *does* want that, it is a separate,
explicit decision (§8, open question 3).

**A4 is a no-op on 15 of the 26 sweep configs** (measured, to 2 decimals): `default`, `rib20`,
`rib200`, `ior1p2`, `curv0p4`, `bow0`, `horizontal`, `dpr2`, `noise`, `lines`, `frost0p3`,
`stair-rot0`, `step`, plus `ior2p5` and `curv1p5`. The first thirteen are correct behaviour — no
pixel straddles a seam, so there is nothing to blend, and gate R9 confirmed the branch is genuinely
adaptive (mean 1.0117 fetches, min 1, max 2). The last two are the real limitation:

**A4 does nothing in the minification / mirror-fold regime.** At ior 2.5 it is exactly A0
(11.26 / 53); at curvature 1.5 it improves the seam band by 9% (10.315 → 9.406). Its model is one
clean step per pixel, and past `curvature = 0.8095` / `ior = 1.540` there are additional creases
inside the rib it has no term for. That is a separate defect with a separate fix (§8).

**Branch cost.** The blend is a per-fragment non-uniform branch. Measured on real hardware it costs
+4.7 µs at 1.012 fetches — the branch does not eat the saving. It contains only
`textureSampleLevel`, no derivatives, so it introduces no new WGSL uniformity exposure.

---

## 5. Blast radius

- **No default changes. No new param.** This is a correctness fix and it is a no-op wherever no
  pixel straddles a seam.
- **Byte-identical output** for any graph with straight ribs, `srt_rotate = 0`, and an integer
  device seam period (`ribWidth × u_dpr × srt_scale` ∈ ℤ) — which is the shipped default at
  ribWidth 80 on an even-width canvas at dpr 1 or 2. Those users see nothing change.
- **Visibly different** for: any `srt_rotate ≠ 0`, any `srt_scale ≠ 1`, any wave / circular / noise
  rib type, any non-integer `ribWidth × u_dpr`, and any window resize that lands the seam mid-pixel.
  On those, the ~0.5% of pixels on the seam go from 90–124 codes of error to 21–30 max. The seam
  stops staircasing (measured: 0.25932 px → 0.09272 px at rot 7°, 0.26892 → 0.05980 on noise ribs; ground
  truth is 0.086 / 0.055 — **A4 is at or below GT on the staircase metric**).
- **`coords` output unchanged** — still evaluated at the pixel centre. Only `color` is filtered.
- **Frozen-ref / non-texture path unchanged.**
- **Frost look unchanged** at frost ≥ ~0.05; at 0.001 < frost < 0.05 the gather now straddles the
  seam correctly instead of putting all taps on one side.
- **Alpha behaviour changes on transparent sources** — from a single straight-alpha tap to a
  premultiplied 2-tap blend. Correct, but untested by any existing stimulus; needs a new gate.
- **Preview thumbnails** go through the same emitted shader, so they pick this up automatically.
- Serialised `.sombra` files and share URLs are unaffected — no schema change.

---

## 6. Rejected alternatives

### A3 — 2×2 rotated-grid supersample (the sweep's winner)

Ranked first on the sweep's headline metric, rejected by all three verification passes. Three
independent defects in that ranking:

1. **The band is 6× wider than the feature.** The metric averages over a geometric ±3 px seam band
   = 7.9% of the frame, but the error-bearing pixels are **0.5–0.6%** — so 5 of every 6 pixels in
   the band carry only the box-prefilter floor. A3 *is* a 4-tap box prefilter and removes that
   floor; A4 point-samples away from seams and keeps it. **The floor is what separates rank 1 from
   rank 10.** Direct evidence: `bandMean − globalMean` ≤ 0.2 codes on 12 of 26 configs and is
   *negative* on six (`lines` −0.742, `noise` −0.427). A3's two largest headline wins
   (`noise` 11.59 → 2.08, `lines` 3.38 → 0.63) are both on negative-excess configs.
2. **The reference is an unjittered 16×16 midpoint grid**, whose own quadrature error is a
   systematic sawtooth of mean C/(4N). Simulated over all sub-pixel phases at C = 60 codes: A4's
   error vs *true* coverage is **0.0000** and vs the 16×16 GT is **0.9375** — 100% of it is the
   reference's error. A3's is 3.7500 either way. Truth says A4 ≫ A3; the bench says A3 is 4× better.
3. **An undisclosed `|hfLoss| ≤ 0.06` tie-break** on a metric whose denominator is near zero on 8 of
   26 configs (`ramp-x` hfEnergy 0.4264, `step` 0.3428, vs `noise` 205.2). Controlled: perturbing
   1.03% of `ramp-x` pixels by **one code** yields hfLoss −0.142, 2.4× the threshold. The clause
   kills 0 of A3's configs and 7 of A4's — it rewards *having the same form as the reference*. It
   alone drops A4 from 13/26 to 6/26.

A3 also loses on band-max in **9 of 11** straddling-seam configs (sign test p = 0.033), leaves a
coherent dark terrace on the seam pixel (§2), and costs **4.000 fetches / +13.3 µs straight and
+342.1 µs (3.89×) on noise ribs** — 25.7× the advertised increment, because it re-runs the entire
node body including 5 noise evaluations per sub-sample.

**Keep A3 in the drawer** for the minification regime (§8, Q5), where it is genuinely the best
shippable candidate (`ior2p5` 11.26 → 1.07, `curv1p5` 18.20 → 3.72).

### A1 — 1-D supersampling along the seam normal (K = 2/3/4/8)

**A3 at 4 taps beats A1-8 at 8 taps on every oblique config** (rot45 0.88 vs 1.19; wave-sine 0.73 vs
0.86; lines 0.63 vs 2.10; noise 2.08 vs 6.61), and 1-D saturates — 4 → 8 taps buys 0.11 codes on
rot45. `bow0` is the proof: 1-D supersampling is a total no-op there (1.03 → 1.02 at 8 taps) while
2-D at 4 taps reaches 0.01, because the residual lies in the axis the 1-D box never samples.
**1-D does not suffice, and the 2-D version is half the cost.**

### A2 — adaptive 1-D (full K near a seam, 1 tap elsewhere)

Worse than A4 at comparable cost: `misaligned` 0.84 (A2-4) / 0.66 (A2-8) vs A4's 0.61, at 1.03–1.70
fetches vs 1.012. Dominated.

### A5 — jittered / stochastic supersampling

Dominated by A3 at equal tap count on every config (`misaligned` A5-4 1.06 vs A3 0.54; `noise` 8.64
vs 2.08). No config where the noise-instead-of-staircase trade wins.

### A6 — prefilter the map: coordinate taper / `smoothFract`

**The single most decisive rejection.** Measured **10.35 codes vs A0's 2.85 — a 3.6× regression**,
independently reproduced on CPU at 2.9–3.0× and at three rotations. Worst config `lines`: p95 125 vs
A0's 26.

Why, precisely: averaging the sampled *position* over a pixel equals averaging the *colour* only if
the image is locally affine, and it is not across a 52–107 device-px jump. The correct object is the
pushforward interval `[f(x−½), f(x+½)]`, and integrating over that still needs mips or taps. The
displacement reaches ±0.333·ribW = ±53 device px; tapering it to zero over a 1 px band is a 53:1
minification streak, and to get the ramp under 1 source px/screen px you would need to spread it over
a third of the rib, destroying the effect. **There is no width setting at which this works.**

This is what Paper Design's Fluted Glass shader ships (`smoothFract` + a `fwidth`-widened highlight
line over the seam). Their own docs describe the highlight as *"useful for antialiasing"* — i.e. the
industry answer masks the seam cosmetically rather than resolving it. A6 is rejected; the highlight
half is a legitimate separate look feature (§8, Q4).

### A7 — render the pass at 2× and downsample

Dominated on measurement *and* blocked on prerequisite. Same 4 fetches as A3, **1.5× the time**
(31.8 vs 21.3 µs), worse on every config, and positive hfLoss (softer than GT). Prerequisite does
not exist: `RenderPass` (`src/compiler/glsl-generator.ts:51-61`) has **no `resolution` field at
all** — `PHASE6-MULTIPASS.md:368`'s claim that it is "supported in the data structure" is stale.
See §7.

### A9 — share the frost taps by moving the jitter to screen space, pre-lens

**15.08 codes on `frost0p3` vs A0's 0.32**, hfLoss +0.57, and worse than A0 on 9 frost-off configs
(`default` 1.52 vs 0.56, `rib200` 2.63 vs 0.74). Replacing the node's post-lens source-space disc
with a pre-lens screen-space disc is a *different image*, not a cheaper one. Rejected — §3's per-tap
base *selection* is the correct way to share.

### `textureSampleGrad` / LOD-biased sampling

Dominated by construction. Pass textures are created with no `mipLevelCount`
(`src/webgpu/renderer.ts:469-482`) and no `generateMipmap` (`src/webgl/renderer.ts:351-356`), so any
computed LOD clamps to 0 and it degenerates to exactly A0's bilinear tap. Also conceptually wrong:
mips are an *isotropic* prefilter and the seam is a step — mipping it would go soft, not clean.

### Any `fwidth`-based footprint

Measured, not assumed. `fwidth(rg_sampleUV.x)` at the seam returns **52.6 px/px** — the jump, not
the slope — and only on ~50% of sub-pixel phases (a 2×2 quad can only see a discontinuity strictly
inside it), so a derivative-driven detector *blinks on and off* as translate or canvas size changes.
That is a new temporal artifact worse than the one being fixed. The analytic rate reads exactly
1.000 at every phase. There is also **zero precedent** for a hardware derivative anywhere in the
43-node library.

### `diagnostic(off, derivative_uniformity)`

Works on real Tint (measured, module-scope and attribute forms both). Rejected: WGSL-only syntax the
mechanical translator has no concept of, it silences the exact diagnostic that caught `b56c19c`, and
suppression does not make the value correct — inactive quad lanes supply garbage.

---

## 7. Engine-level options

**None of these should displace the node fix, but one of them should be checked first.**

| option | verdict | cost |
|---|---|---|
| **Render Quality = Medium/Low** | **Check with the user before anything else.** Not an engine *change* — an existing dropdown. `medium` sets `STATIC_DPR_SCALE = 0.75`, `low` sets 0.5, statically, with no animation required (`src/nodes/output/fragment-output.ts:88-98`). Measured: a 0.75 static downscale costs **4.568 codes vs 3.571 for the entire aliasing error**. A user on Medium sees more roughness from that dropdown than any node fix can remove. | zero |
| **`ANIMATED_DPR_SCALE = 0.75`** | Real, and it dominates — **but only on time-live graphs.** `setAnimated()` has one caller (`src/App.tsx:82-83`, `isTimeLiveAtOutput`); `notifyChange()` early-returns when not animated. Slider drags do **not** trigger it. On an animated graph a node fix recovers only **16.0%** of the error; 77.3% is a floor no node change crosses. Raising it to 1.0 is a one-line perf/quality trade, not a correctness fix, and it should be the user's call. | one line + a perf decision |
| **Implement `RenderPass.resolution` (A7)** | **Does not dominate.** Benched as a real candidate and it *lost* to a 4-tap node fix on every config at 1.5× the time. Would unlock true SSAA for every effect pass, and at k=2 fixes seam + minification + fold at once — but at 4× the pass cost. | Medium. New field on the plan type, `resizeIntermediateTextures()` in **both** renderers, a box-downsample or resolve blit on the consuming pass, pass scheduling. |
| **Generate mips for pass textures** | Not worth it for this defect (§6). Only pays off for the ior ≥ 1.8 minification regime, and even there anisotropic filtering is the thing that would help, not mips alone. WebGPU has no `generateMipmap` — needs a manual blit chain, log₂(n) extra passes per intermediate per frame. | Medium-large |
| **`dFdx`/`dFdy` → `dpdx`/`dpdy` in `mechanicalGlslToWgsl`** | Not needed by this fix; A4 uses no derivatives. Worth adding anyway as a **guard**: today they pass through unmapped and fail at Tint as `unresolved call target`, which given the missing `compilationInfo` check is a silent frame drop. | 2 lines in `wgsl-backend.ts` |
| **Check `createShaderModule` compilation info** | **Recommended independently of this work.** `src/webgpu/renderer.ts:309` and `:364` call `createShaderModule` with no `compilationInfo()` check and no error scope anywhere in the file. That is the `b56c19c` failure mode: reported success, whole frame silently dropped at draw. Every WGSL-only bug in this file has hidden behind it. | Small |

---

## 8. Open questions

1. **Which configuration was the user actually looking at?** This is the highest-value unknown. At
   the shipped defaults with an integer device seam period there is *no* seam error to speak of —
   A0 band max 17 codes, 0.06% of pixels. The complaint requires a straddling seam: non-integer
   `ribWidth × u_dpr × srt_scale`, any `srt_rotate ≠ 0`, or a wave/circular/noise rib type. Two
   different symptoms point at two different remedies: a *staircase* → coverage AA (this fix); a
   *noisy, broken, sparkling* line → curvature past 0.81 (Q5). **Ask for the graph or a screenshot.**
2. **What is Render Quality set to?** Medium (0.75) or Low (0.5) silently downscales the whole frame
   with no animation involved (§7). One dropdown, larger effect than the fix.
3. **Perceptual call: is the 0.44-code box-prefilter term a defect or a feature?** A0 is measurably
   **3–19% sharper** than a box-filtered reference in the far field. A3 removes that (making the
   node match a box filter everywhere, 4× fetches); A4 leaves it. The measurements cannot say which
   the user prefers — this needs their eye on an A0-vs-A3 pair.
4. **Should the seam get a highlight/shadow line?** Zero fetches, physically real (two adjacent
   cylinder surfaces meet at a genuine cusp, and real reeded panes show a bright line there), and it
   is what the leading competitor ships. Sombra has no highlight term at all today. A look feature
   that happens to mask the residual — worth proposing separately, never as *the* AA fix.
5. **Curvature ≥ 0.8095 and ior ≥ 1.540 are a separate, worse defect.** The `min(c, 0.99)` cap
   bounds the *shape* parameter but leaves the profile *slope* unbounded — `(1 − x²c₂²)^(−3/2)`
   reaches ~10³ near the rib edge. Consequences: |L′| = 52 one device px from the seam at
   curvature 1.0 (85 at half a pixel), caustics per rib 2 → 4 → 8 → 28, and even 16 taps leaves
   RMSE 3.0–6.1/255. The top 60% of the curvature slider's travel is a broken regime. The fix is a
   **slope clamp**, not more samples. Separate ticket — and it should probably land *before* this
   one, since it changes what the AA has to cover.
6. **Two measurements are owed before merge.** (a) The shipped A4 form (gm/gp reuse + first-order
   `wm` extrapolation) was not benched — only the 5-φ-evaluation bench proxy was. (b) The per-tap
   frost coverage selection (§3) was not benched at all. Both need a run before the PR.
7. **A4 was not run in the DPR arm.** The animated-0.75 experiment covered A0/A3/A8 only, so "a node
   fix recovers 16% while animating" is A3's number, not A4's.
8. **Two incidental defects found while reading, both out of scope.** (a) The chevron wave field
   differs between the frozen-ref path (`:405`, bounded `abs(perp·2−1)`) and the screen path
   (`:161`, unbounded `abs(perp·resPerp/wlPx)`) — so `coords` and `color` render *different*
   chevron patterns. (b) For circular/noise ribs `rg_den → 0` when `amplitude/wavelength > 0.1592`
   (e.g. amplitude 32 at wavelength 200, both inside slider range), amplifying the delta by
   `1/(1−G)` and eventually inverting its sign.

---

## 9. Repro

All headless. No dev server, no browser tab, no commits. Run from the repo root.

```bash
# Analytic characterisation: closed forms, seam jump, derivative sweep, footprint tables
npx tsx scripts/blur-bakeoff/phase10-analytic.ts
#   -> reports/blur-bakeoff/phase10/analytic.json

# Dump the node's ACTUAL emitted shaders (both backends, uniform + wired frost)
npx tsx scripts/blur-bakeoff/phase10-emit-dump.ts
#   -> reports/blur-bakeoff/phase10/{uniform,wired}-frost.{glsl,wgsl}.pass*.{frag,wgsl}

# WGSL/GLSL derivative legality on real Tint + real ANGLE (25 + 10 cases, 6 controls)
npx tsx scripts/blur-bakeoff/phase10-derivative-legality.ts
npx tsx scripts/blur-bakeoff/phase10-derivative-values.ts
#   -> reports/blur-bakeoff/phase10/derivative-{legality,values}.json

# Rig smoke tests (bypass byte-exactness, identity lens, ssaa wrapper vs native 2x)
npx tsx scripts/blur-bakeoff/phase10-smoke.ts

# Reproduce the complaint: 256 PNGs across the config matrix, hard-cut vs staircase
npx tsx scripts/blur-bakeoff/phase10-repro.ts
#   -> reports/blur-bakeoff/phase10/{phase10-repro.json,repro/}

# THE BENCH. Default mode is --validate (31 calibration gates, ~2 min).
npx tsx scripts/blur-bakeoff/phase10-reed-aa.ts
npx tsx scripts/blur-bakeoff/phase10-reed-aa.ts --sweep       # 988 rows, 26 cfg x 19 cand x 2 backends
npx tsx scripts/blur-bakeoff/phase10-reed-aa.ts --apportion   # zones, ablation ladder, DPR arms
#   -> reports/blur-bakeoff/phase10/{phase10-validation,phase10,phase10-apportion}.{json,md}
#   -> reports/blur-bakeoff/phase10/aa/*.png

# Look pass: error-bearing-pixel stats + 14x crops at the winner's worst window
npx tsx scripts/blur-bakeoff/phase10-look-worst.ts
#   -> reports/blur-bakeoff/phase10/worst/{look-worst.json,worstA3-*.png,full-*-A3.png}

# Transfer probe: y-sign desync, function-hoist failure, alpha, array translation
npx tsx scripts/blur-bakeoff/phase10-transfer-probe.ts
#   -> reports/blur-bakeoff/phase10/phase10-transfer.json
```

Decisive images:

| file | shows |
|---|---|
| `reports/blur-bakeoff/phase10/worst/worstA3-rot45.png` | A0 │ A4 │ A3 │ A8 at 14× — A0 staircase, **A4 indistinguishable from GT, A3 visibly terraced** |
| `.../worst/worstA3-wave-sine.png`, `worstA3-rot15.png` | same, curved and shallow-oblique seams |
| `.../aa/seam4x-lines.png` | A0 ≡ A4 (pixel-aligned, branch never fires) with hard breaks; A3/A8 smooth |
| `.../aa/seam4x-misaligned.png` | the straddling-seam case, A0 max 94 → A4 24 → A3 30 |
| `.../aa/validate-stair-rot7-A0-vs-A8.png` | the staircase itself: stepped left, smooth right |
| `.../repro/cmp8x-seam-1tap-vs-ssaa-A01-default.png` | identical halves = the artifact is a **hard cut**, not undersampling |

Before merge, add: a WGSL-vs-GLSL parity assertion at `srt_rotate = 45` to
`scripts/validate-wgsl-multipass.ts` (the phase-10b parity gate is blind to the y-sign desync — §2.2),
and an alpha gate on `transparentEdgeSprite` (no existing stimulus has alpha — §2.2).
