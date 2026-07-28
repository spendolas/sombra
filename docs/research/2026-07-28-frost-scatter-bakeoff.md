# Frost scatter bake-off — diagnosis and recommendation

**Subject:** the `frost` parameter of `src/nodes/transform/reeded-glass.ts` "looks like pixelation".
**Status:** decision only. Nothing in `src/` was changed, nothing was committed.
**Scope of evidence:** headless Chrome on a real GPU, both backends, `scripts/blur-bakeoff/`.
All figures are 8-bit codes on sRGB output unless stated. Radii are given in CSS px (the shipped
half-extent is `frost * 24` CSS px = `frost * 24 * u_dpr` device px).

---

## 1. Diagnosis

The complaint is the **product of two defects**, not a sum. The seed lattice supplies the *structure*
and the tap count supplies the *amplitude*; fixing either alone fails. The footprint shape is a real
but third-order error. A fourth cause — the hash itself — was not in the original suspect list and
is the one that ambushed the first proposed fix.

### 1.1 The seed lattice — 100% of the block structure, 0% of the error

`rg_gc = floor(rg_coords * (u_ref_size * 0.25))` quantises the seed to **4.00 CSS px in every
configuration** (`u_dpr` cancels): 4×4 = 16 device px share one 8-tap set at DPR 1, **8×8 = 64 at
DPR 2**. Inside a cell the output is continuous (the sample centre still moves); at the cell
boundary the kernel jumps to an independent draw. Hard seams on a 4-CSS-px grid — the block period
lands at ~5.7 cycles/degree at 110 ppi / 600 mm, the peak of the contrast sensitivity function.

Ablation: **same 8 taps, same square footprint, lattice removed** (C0 → C1), photo-street,
frost 1, DPR 2, R = 48 device px:

| metric | C0 (ships) | C1 (lattice removed) |
|---|---|---|
| block-edge excess | **15.13 codes** | **0.10** |
| residual ACF at lag 4 | 0.418 | 0.012 |
| ACF shoulder lag | 6 | 0 |
| dominant period / amplitude | 8 px / **3.617 codes** | — / 0.089 |
| coherence drop (phase 9a) | 1.403 | 0.016 |
| **mean deviation from the 256-tap disc** | **10.34** | **9.96** |
| speckle excess | 5.35 | **13.66** |

The lattice is the entire block signature and removes **no error at all** — 10.34 → 9.96 codes. It
only *redistributes* the 8-tap estimator's variance from per-pixel grain onto a 4-px grid, which is
why deleting it doubles the speckle. Block-quantising a *converged* result is visually mild
(1.48–1.95 codes mean from target); the shipped shader is 5.86–9.94, i.e. **3–4× the amplitude on
the same grid**.

The lattice's stated purpose — invariance under resize / DPR flip / param drag — is achieved by
`rg_coords` being frozen-ref (`u_dpr` cancels identically), **not** by the `* 0.25` coarseness. A
1-CSS-px lattice would be exactly as invariant.

### 1.2 Eight taps — 100% of the error amplitude

A plain Monte-Carlo mean: `σ_out = σ_tap/√N`. At a hard edge of contrast 255 the estimator noise is
**45.1 codes at N = 8** (63.8 across a tile boundary). Consequences that are not statistical
subtleties:

- **Ghosting.** For an opaque source the output is literally 8 rigidly shifted copies at
  255/8 = **31.9 codes each**; mean tap spacing 33.9 device px at R = 48, so any feature under
  ~34 px reads as 8 discrete ghosts.
- **Alpha staircase.** `rg_aacc / 8.0` takes **9 values** — 31.9-code steps. Measured max alpha
  deviation from the converged disc on the transparent-edge sprite: **164 codes** (C0), 199 (C1).
- **Clumping.** 8 iid points in a square: one duplicated pair on average.

Convergence with iid taps is hopeless: even 256 iid taps sit at 1.36 codes speckle against a
target of 0.27, and reaching 2 codes at a step edge needs **N ≈ 8100**. Stratification is what
buys the win, not raw N — 16 *stratified* taps reach 2.95 codes mean where 8 iid taps sit at 10.34.

### 1.3 Footprint shape — real, third-order, and fixed for free

The suspicion had two halves. **The anisotropy half is refuted:** `vec2(...) / u_viewport` is
exactly isotropic in device px (24.00 × 24.00 at both 1200×800 and 1920×1080); the existing comment
is correct. **The square half is confirmed but small:** corner reach is √2 = 1.414× the axis reach,
`squareness` 1.195 vs 1.000 for a disc, and a 256-tap square vs a 256-tap disc differ by
**2.26 codes mean / 3.5 worst** — against a total blur effect of 6–23 codes. Fixing shape alone
makes things *worse*: C2 (8 disc taps, per-pixel) reads vsGT 10.18 and the worst speckle excess in
the entire set, 16.39.

Verdict: shape is not the pixelation. It comes free with the recommended kernel; it would not be
worth a change on its own.

### 1.4 The hash — the fourth cause, found only by the adversarial look pass

`reedHash` is a single-round LCG + xor-shift over the raw float bits. On an integer pixel grid the
bitcast input is itself a linear ramp, so the output inherits the LCG lattice. Autocorrelation of
the derived field over a 384² grid:

| field | peak abs ACF | lag |
|---|---|---|
| iid control (chance floor) | 0.0089 | — |
| pcg2d `.y` (known-good) | 0.0078 | — |
| **`reedHash.x` used as a rotation** | **0.6467** | **(0,5)** |
| **`reedHash.y` used as radial jitter** | **0.8431** | **(7,0)** |
| deliberately near-linear (known-bad) | 1.0000 | — |

Consequences measured in the image: "just delete the lattice" (C1) produces a **diagonal moiré** —
residual ACF peak 0.386 at lag (7,0), grain anisotropy up to 2.87 against 0.04–0.06 for the
converged control. No block gate can see it: they probe adjacent rows and columns, and this
structure lives seven pixels out. And the first bake-off winner, C3j-16 with a `reedHash` rotation, carries a
**regular diagonal cross-hatch over the whole frame, visible at 1:1** — peak ACF 0.250 at frost 1,
0.387 at frost 0.25, against a C7-vs-C7 floor of 0.209 / 0.154. A halftone screen instead of a
block grid: finer, and just as ordered.

**Apportionment, one line:** lattice = the blocks; 8 taps = the amplitude; hash = a second ordered
pattern that appears the moment the lattice is removed; square footprint = 2.3 codes and no
percept.

---

## 2. Recommendation

**Radially-jittered Vogel disc, 16 taps, per-device-pixel rotation from a pcg2d hash, seeded from
`rg_coords`.** (Bench name: C3j-16 with `rot = pcg`, i.e. the `pcgRot` ablation — **not** the
candidate as originally benched.)

> **The bake-off winner as benched is unsound and must not be pasted in.** The adversarial look pass
> returned **BROKEN** on it: its rotation source is `reedHash`, which weaves the cross-hatch above.
> The adversarial transfer pass returned **QUALIFIED**: the kernel transfers cleanly (52/52 live
> compile checks, both positive controls firing) but its seed as benched — `floor(gl_FragCoord.xy)` —
> is backend-asymmetric, because `wgsl-assembler.ts:183-185` rewrites `gl_FragCoord` → `in.position`
> *unconditionally, including inside a hand-written WGSL arm*, and those two have opposite y origins.
> Both defects are fixed below, each at zero fetch cost, and the fix for the first is measured.

The rotation swap is free and complete (photo-street, DPR 2, 16 taps, everything else identical):

| frost | R (dev px) | variant | residual rms | peak ACF | aniso |
|---|---|---|---|---|---|
| 1.0 | 48 | rot = `reedHash` (as benched) | 4.670 | 0.250 | 1.27 |
| 1.0 | 48 | **rot = pcg2d** | **4.675** | **0.014** | **1.03** |
| 0.25 | 12 | rot = `reedHash` | 1.266 | 0.387 | 1.24 |
| 0.25 | 12 | **rot = pcg2d** | **1.246** | **0.015** | **1.04** |
| 0.125 | 6 | rot = `reedHash` | 0.719 | 0.354 | 1.49 |
| 0.125 | 6 | **rot = pcg2d** | **0.707** | **0.014** | **1.02** |

Accuracy unchanged to 0.1%; ordered structure collapses **below the 256-tap ground truth's own
floor as measured in the same run** (0.043–0.062). WebGL2 leg: rms 4.683, peak 0.015,
cross-backend mean |Δ| < 0.001 codes. Zero extra fetches — ALU only.

### 2.1 Tap count: 16

16 is the cheapest point at which every shape and structure metric is at its floor:
`squareness` 1.003, `ringiness` 0.062, `L1 vs disc` 0.069, `holeDeficit` 0.011, `massCaptured` 1.012,
block-edge excess 0.00, dominant amplitude 0.029 codes, ACF lag 4 −0.011. Mean deviation from the
256-tap disc **2.95 codes / p99 14** against C0's 10.34 / 55.

24 taps buys 2.02 / p99 10 and a calmer resize (§3) for +50% fetches. It is a Quality enum away
(`updateMode: 'recompile'` — the semantic-key tier already handles it, no engine change) but is not
part of this recommendation.

### 2.2 The replacement block

Two shared functions. `reedHash` is unchanged and stays (it still supplies the radial jitter, which
is the configuration that was measured); `reedRand` is new. Both need a **two-argument `raw()`** —
`uvec2`/`vec2<u32>`, `floatBitsToUint`/`bitcast`, and the WGSL vector-shift shape rule
(`q >> 16u` is a shape error on a `vec2u`; it must be `q >> vec2<u32>(16u)`).

```glsl
// GLSL ES 3.00 — addFunction(ctx, 'reedRand', ...) in glsl(), IRFunction in ir()
float reedRand(vec2 p) {
  uvec2 v = uvec2(ivec2(floor(p) + vec2(4096.0)));
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v = v ^ (v >> 16u);
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v = v ^ (v >> 16u);
  return float(v.y) * 2.3283064e-10;   // v.y / 2^32  ->  [0,1)
}
```

```wgsl
// WGSL arm — the .y lane, MEASURED: pcg2d's .x lane is itself correlated at
// lag (11,0) (peak |acf| 0.187 vs 0.008 for iid) because the last round updates
// v.y from the already-updated v.x but not the reverse. The .y lane reads 0.0078.
fn reedRand(p: vec2f) -> f32 {
  var v: vec2<u32> = vec2<u32>(vec2<i32>(floor(p) + vec2f(4096.0)));
  v = v * vec2<u32>(1664525u) + vec2<u32>(1013904223u);
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v = v ^ (v >> vec2<u32>(16u));
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v = v ^ (v >> vec2<u32>(16u));
  return f32(v.y) * 2.3283064e-10;
}
```

The frost block itself. Emit `FROST_TAPS` from **one** module-level constant into both arms — today
the tap count `8` and the divisor `8.0` are written at six separate sites
(`reeded-glass.ts:532, 540, 846, 854, 864, 872`), and a divisor left at `8.0` over 16 taps makes
alpha reach 2.0, straight through the "never invent alpha" rule.

```ts
const FROST_TAPS = 16
const FROST_INV_N = (1 / FROST_TAPS).toFixed(8)   // 0.06250000
// Golden angle 2.399963230 rad, pre-rotated as a 2x2 so the loop needs no per-tap sincos.
const GA_C = '-0.737368878'   // cos
const GA_S = '0.675490294'    // sin
```

**GLSL arm** — identical text in `glsl()` (pushed line by line) and in the *first* argument of the
`ir()` `raw()`:

```glsl
vec4 ${outputs.color};
if (rg_frost_${id} > 0.001) {
  vec3 rg_acc_${id} = vec3(0.0);
  float rg_aacc_${id} = 0.0;
  vec2 rg_frad_${id} = vec2(rg_frost_${id} * 24.0 * u_dpr) / u_viewport;
  // Per-device-pixel seed taken in the glass's own frozen-ref frame. NOT
  // gl_FragCoord: the assembler rewrites it to in.position unconditionally, even
  // inside a hand-written WGSL arm, and gl_FragCoord.y is bottom-up while
  // in.position.y is top-down -> the two backends would seed from mirrored grids.
  // rg_coords is y-DOWN in both arms, so this expression is backend-symmetric.
  vec2 rg_gc_${id} = floor(rg_coords_${id} * (u_dpr * u_ref_size));
  // Per-pixel rotation from pcg2d, NOT reedHash: reedHash's rotation field is
  // autocorrelated at 0.647 (iid floor 0.009) and weaves a visible cross-hatch.
  float rg_rot_${id} = reedRand(rg_gc_${id} + vec2(11.7, -23.9)) * 6.28318530718;
  vec2 rg_dir_${id} = vec2(cos(rg_rot_${id}), sin(rg_rot_${id}));
  for (int rg_i_${id} = 0; rg_i_${id} < ${FROST_TAPS}; rg_i_${id}++) {
    float rg_fi_${id} = float(rg_i_${id});
    // Radius jittered inside its own annulus. Rotation preserves radius, so it can
    // fill neither the sqrt(0.5/N)*R centre hole nor the concentric shells of a
    // plain sunflower; radial jitter does. PSF ringiness 0.879 -> 0.062 measured.
    float rg_jr_${id} = reedHash(rg_gc_${id} + vec2(rg_fi_${id} * 3.17 + 0.5, rg_fi_${id} * -5.41 - 0.5)).y * 0.5 + 0.5;
    float rg_rr_${id} = sqrt((rg_fi_${id} + rg_jr_${id}) * ${FROST_INV_N});
    vec2 rg_tap_${id} = rg_sampleUV_${id} + rg_dir_${id} * rg_rr_${id} * rg_frad_${id};
    rg_tap_${id} = 1.0 - abs(fract(rg_tap_${id} * 0.5) * 2.0 - 1.0);
    vec4 rg_s_${id} = texture(${samplerName}, rg_tap_${id});
    rg_acc_${id} += rg_s_${id}.rgb * rg_s_${id}.a;
    rg_aacc_${id} += rg_s_${id}.a;
    // Advance by the golden angle: one 2x2 rotate, no transcendentals in the loop.
    rg_dir_${id} = vec2(rg_dir_${id}.x * ${GA_C} - rg_dir_${id}.y * ${GA_S},
                        rg_dir_${id}.x * ${GA_S} + rg_dir_${id}.y * ${GA_C});
  }
  ${outputs.color} = vec4(rg_acc_${id} / max(rg_aacc_${id}, 1e-5), rg_aacc_${id} / ${FROST_TAPS}.0);
} else {
  ${outputs.color} = texture(${samplerName}, rg_sampleUV_${id});
}
```

**WGSL arm** — the *second* argument of the same `raw()`:

```wgsl
var ${outputs.color}: vec4f;
if (rg_frost_${id} > 0.001) {
  var rg_acc_${id}: vec3f = vec3f(0.0);
  var rg_aacc_${id}: f32 = 0.0;
  let rg_frad_${id} = vec2f(rg_frost_${id} * 24.0 * uniforms.u_dpr) / uniforms.u_viewport;
  let rg_gc_${id} = floor(rg_coords_${id} * (uniforms.u_dpr * uniforms.u_ref_size));
  let rg_rot_${id} = reedRand(rg_gc_${id} + vec2f(11.7, -23.9)) * 6.28318530718;
  var rg_dir_${id} = vec2f(cos(rg_rot_${id}), sin(rg_rot_${id}));
  for (var rg_i_${id}: i32 = 0; rg_i_${id} < ${FROST_TAPS}; rg_i_${id}++) {
    let rg_fi_${id} = f32(rg_i_${id});
    let rg_jr_${id} = reedHash(rg_gc_${id} + vec2f(rg_fi_${id} * 3.17 + 0.5, rg_fi_${id} * -5.41 - 0.5)).y * 0.5 + 0.5;
    let rg_rr_${id} = sqrt((rg_fi_${id} + rg_jr_${id}) * ${FROST_INV_N});
    var rg_tap_${id} = rg_sampleUV_${id} + rg_dir_${id} * rg_rr_${id} * rg_frad_${id};
    rg_tap_${id} = vec2f(1.0) - abs(fract(rg_tap_${id} * vec2f(0.5)) * vec2f(2.0) - vec2f(1.0));
    let rg_s_${id} = textureSampleLevel(${samplerName}_tex, ${samplerName}_samp, rg_tap_${id}, 0.0);
    rg_acc_${id} = rg_acc_${id} + rg_s_${id}.rgb * rg_s_${id}.a;
    rg_aacc_${id} = rg_aacc_${id} + rg_s_${id}.a;
    rg_dir_${id} = vec2f(rg_dir_${id}.x * ${GA_C} - rg_dir_${id}.y * ${GA_S},
                         rg_dir_${id}.x * ${GA_S} + rg_dir_${id}.y * ${GA_C});
  }
  ${outputs.color} = vec4f(rg_acc_${id} / vec3f(max(rg_aacc_${id}, 1e-5)), rg_aacc_${id} / ${FROST_TAPS}.0);
} else {
  ${outputs.color} = textureSampleLevel(${samplerName}_tex, ${samplerName}_samp, rg_sampleUV_${id}, 0.0);
}
```

### 2.3 Which lines need a two-argument `raw()`, and why

| site | needs hand-written WGSL? | reason |
|---|---|---|
| the whole frost `if` block | **yes** (already is) | `frost` is `connectable`, so the branch can be non-uniform; mechanical translation emits `textureSample`, which WGSL forbids there. **Verified live this session:** the mechanical form is rejected with `WGSL: L22 'textureSample' must only be called from uniform control flow`. The failure mode if it slips through is silent and total — `createRenderPipeline` does not throw on an already-invalid module, then the invalid pipeline drops the entire frame including `loadOp:'clear'` (this is the bug fixed by `b56c19c`). |
| `reedRand`, `reedHash` bodies | **yes** | `uvec2` vs `vec2<u32>`, `floatBitsToUint` vs `bitcast`, and `q >> 16u` is a shape error on a `vec2u`. |
| the seed line | no *(now)* | it uses `rg_coords_<id>`, which is y-down in both arms, so it is textually symmetric. It lives inside the block's hand-written arm anyway. **This is the D1 fix — had it stayed `floor(gl_FragCoord.xy)`, the two backends would seed from mirrored grids.** |
| loop header, `float x =`, `vec2(`, bare `u_dpr`/`u_viewport`/`u_ref_size` | no | verified mechanical-safe: `wgsl-backend.ts:71-74, 79-82, 109` and `wgsl-assembler.ts:167` (lookbehind prevents double-qualifying). |

### 2.4 Verified this session

The exact text above was compiled and rendered on a real GPU through `lib/gpu-rig.ts`
(`scripts/blur-bakeoff/phase9-final-block.ts`, 256×256, linear-light rgba16float intermediate,
frost made non-uniform by deriving it from a texture fetch, half-extent 48 device px):

```
webgpu  mean 138.17384  sd 53.5569   ok
webgl2  mean 138.17383  sd 53.5569   ok
uniformity positive control (plain textureSample under the branch): REJECTED
```

Both arms compile, both render non-black and non-constant, the two backends agree to 1e-5 codes on
this stimulus, and the control that must fail does fail. Separately, the incremental golden-angle
rotation was checked against exact per-tap `cos`/`sin` in fp32 over 2000 random start angles:
**max direction error 7.9e-7, i.e. 3.8e-5 device px of tap displacement at R = 48** — algebraically
and numerically identical to the benched baked form, at 2 transcendentals per fragment instead of 32.

---

## 3. What it costs

**Tap count: 8 → 16 dependent bilinear fetches per fragment in the main pass.**

Marginal fetch rate measured on this GPU by an interleaved tap ladder (1/128/512/2048 at 1024²,
15 reps, min-per-point, least-squares slope): **38.01 Gfetch/s**, split-half disagreement 5.9%. A
second invocation of the identical probe read **46.82 Gfetch/s** — the between-run spread is **23%**
and the split-half test does not catch it, so treat the ms figures as a band.

| device resolution | 8 taps (today) | 16 taps | delta | % of a 16.7 ms frame |
|---|---|---|---|---|
| 1920×1080 | 0.44 ms | 0.87 ms | **+0.44** | +2.6% |
| 3840×2160 (1080p CSS @ DPR 2, static tier) | 1.75 ms | 3.49 ms | **+1.75** | +10.5% |
| same, animated tier (`dprScale` 0.75 → 2160×1215×… = 0.5625× the pixels) | 0.98 ms | 1.96 ms | +0.98 | +5.9% |

At 46.82 Gfetch/s those become +0.35 / +1.41 / +0.79 ms. ALU delta: +2 transcendentals, +16 `sqrt`,
+16 2×2 rotations, 17 hash evaluations instead of 8. The pass is fetch-bound; these are noise
against the fetches, but they are not zero and the bench's ms column counts fetches only.

### Grain identity on the DPR tier flip — better than feared

`u_dpr` cancels in `rg_coords`, so the footprint is `24 · frost` CSS px at every tier and the seed
field is defined in the glass's frame. What changes on a 1.0 ↔ 0.75 flip is which device pixels
exist. Excess over the pure-resample floor, frost 1, DPR 2 → 1.5:

| candidate | flip Δ | resample floor | **excess** |
|---|---|---|---|
| C0 (ships) | 0.49 | 0.46 | **0.03** |
| **16 taps, per-pixel seed** | 1.60–1.62 | 1.03 | **0.58–0.59** |
| 24 taps | 1.11 | 0.68 | 0.44 |
| C7, 256 taps | 0.13 | 0.07 | 0.06 |

0.59 codes. The brief's hypothesis — a converged estimator barely changes when its sample pattern is
re-rolled — holds here. The tier flip happens on every animation start/stop and is not a problem.

### Grain identity on resize — this is the real cost, and the bake-off never scored it

A canvas resize moves content by a non-integer number of device px (`u_resolution * u_anchor` shifts
by 0.5 device px per 1 device px of width), so **any** per-device-pixel seed re-rolls. Measured on
`stuff/2013-03-12 00.48.07.jpg`, DPR 2, null control (identical shader, dy = 0) reads exactly
0.00 codes / 0.00% of pixels in every row:

| R (CSS px) | candidate | resize +1 device px | resize +8 | full re-roll (upper bound) |
|---|---|---|---|---|
| 24 | C0 (ships) | 1.63 / 12.0% | 6.55 / 47.9% | 13.32 / 96.4% |
| 24 | **16 taps, per-pixel** | **4.20 / 85.4%** | 4.34 / 86.3% | 4.07 / 84.1% |
| 24 | 24 taps | 3.01 / 78.0% | 3.06 / 78.6% | 2.85 / 76.0% |
| 24 | C7, 256 taps | 0.26 / 0.94% | 0.26 / 0.95% | 0.25 / 0.81% |
| 12 | C0 | 0.98 / 10.7% | 3.91 / 42.8% | 7.84 / 85.3% |
| 12 | **16 taps, per-pixel** | **1.97 / 54.7%** | 2.03 / 55.1% | 1.87 / 53.0% |

Read the winner's row: 4.20 ≈ its own full re-roll of 4.07. **One device pixel of window drag
re-rolls the whole grain.** The trade is explicit: today the blocks stay put and only re-register
at their seams (1.63 codes / 12%); afterwards the fine grain boils for the duration of a drag
(4.20 codes / 85%), then settles. The amplitude is 3.3× smaller than C0's own full re-roll, and
only convergence removes it — C7 reads 0.26 codes.

The same mechanism applies to an `srt_translate` / `srt_scale` drag on the glass: sub-pixel steps
re-roll instead of sliding. Bounded by the same 4.07-code full-re-roll figure.

---

## 4. Blast radius

Every graph with `frost > 0` changes visibly. This is not a subtle refinement.

- **Accuracy.** Mean deviation from a converged 256-tap disc of the same radius drops
  **10.34 → 2.95 codes, p99 55 → 14** (photo, frost 1, DPR 2). Residual rms at frost 1:
  15.05 → 4.67 codes (DPR 2), 12.12 → 2.46 (DPR 1).
- **The 4-CSS-px grid disappears** on all content: block-edge excess 15.13 → 0.00, dominant period
  amplitude 3.617 → 0.029 codes, ACF lag 4 0.418 → −0.011, shoulder lag 6 → 0.
- **Slightly tighter blur at the same `frost` value.** A square of half-extent *h* has RMS radius
  0.816*h*; a disc of radius *h* has 0.707*h* — **13.4% narrower**, and the corner reach drops from
  1.414*h* to 1.000*h*. Scenes tuned by eye will read as marginally less frosted. Measured proxy at
  256 taps: square vs disc = 2.26 codes mean / 3.5 worst. Raising `frost` by ~15% restores the RMS
  (see open question 5).
- **Alpha improves 4×, is not solved.** The staircase goes from 9 levels (31.9-code steps) to 17
  (15.9-code steps); max deviation from the converged disc on the transparent-edge sprite
  **164 → 41 codes**. Soft-alpha sprites behind frost will still band. 24 taps reads 27.
- **Speckle.** Excess over the converged reference 5.35 → 4.97 worst / 4.27 on the photo. Note it
  goes *down* despite the blocks being gone, because 16 stratified taps beat 8 iid ones by more than
  the lattice's artificial neighbour-correlation was hiding. (C1 — lattice removed, 8 taps — is
  13.66. That is the trap.)
- **Character.** From frozen 4-CSS-px patches to fine isotropic grain measured at or below the
  ground truth's own structure floor in the same run (peak ACF 0.014 against 0.043–0.062,
  anisotropy 1.03 against 1.20).
- **Preview thumbnails** (80×80 offscreen) get a different grain realisation from the main canvas.
  Unchanged in kind from today.
- **Embed player:** no impact. No new binding, no asset, no new import. One extra shader function.
- **Verification scripts:** `scripts/verify-ir-poc.ts` lines **1742** and **1770** hard-assert
  `rg_aacc_reed_rrr889 / 8.0` and must become `/ 16.0`. Lines **1735** and **1764** (the tap-fetch
  assertions) **survive unchanged** because the loop form keeps `rg_s_<id>` / `rg_tap_<id>` — an
  unrolled emitter would break both, which is one more reason to keep the loop. Baseline today is
  85 passed / 0 failed; re-run `validate-wgsl-multipass.ts` (167/167) as well.
- **Parity gate must stay statistical, never byte-exact.** `rg_sampleUV` is y-UP on GLSL and y-DOWN
  on WGSL while the jitter is added with `+` on both, so the frost kernel is y-mirrored between
  backends. With a per-pixel random rotation that is a no-op in distribution, but a pixel-diff gate
  will flag it. Independently, `rg_coords` reaches the hash through a `cos`/`sin`/division chain
  where a 1-ULP backend difference completely changes a bitcast hash.
- **Not fixed by this change:** the accumulation runs in stored gamma. Pass textures are
  `rgba8unorm`, not `-srgb`, so averaging 0 and 255 yields 127.5 codes where the linear-correct
  answer is 187.5 — a **60-code error** at a black/white boundary, present today and afterwards.
  See open question 6.

---

## 5. Rejected alternatives

Each with the measurement that killed it. Numbers are photo-street unless stated, frost 1, DPR 2.

| candidate | killed by |
|---|---|
| **C1 — delete the lattice, keep 8 square white-hash taps** | Removes the blocks (excess 15.13 → 0.10) and nothing else: vsGT **9.96 vs C0's 10.34**, speckle excess **13.66** (nearly 3× C0's), alpha max deviation **199**. And it substitutes a *diagonal* moiré — residual ACF peak 0.386 at lag (7,0), grain anisotropy up to 2.87. The bench's own ranking put it #1 purely because its only structure gate is `blocky?`, which probes adjacent rows and columns and is blind to structure seven pixels out; that ranking is wrong. |
| **C2 — 8 taps, uniform disc, per-pixel** | Isolates footprint shape at identical cost: vsGT **10.18** (no better than C0), **worst speckle excess in the set, 16.39**, ACF lag 4 0.298. Shape is not the defect. |
| **C3-16 — un-jittered Vogel (Sterna's operating point)** | The PSF is a ring stack: `ringiness` **0.879** and `L1 vs disc` **0.175** against 0.062 / 0.069 for the radially-jittered form, at identical cost. Rotation preserves radius, so per-pixel rotation can fill neither the `sqrt(0.5/N)·R` centre hole nor the concentric shells. C3-8 reads 1.039. |
| **C4 / C4j — Gaussian radial weight** | Not wrong, just a different target: `L1 vs disc` **0.474–0.526** and `holeDeficit` **−1.045** (strongly centre-peaked). vsGT against the disc anchor 5.03–5.08; against a *Gaussian* anchor 2.76–2.80. This is a look preference, not an error — see open question 3. |
| **C5* — interleaved gradient noise for the rotation (the brief's own hypothesis)** | **Refuted, hard.** IGN's rotation field has peak abs ACF **0.9989 at lag (−2,2)** — level with the deliberately-broken known-bad (1.0000) and 112× the iid floor. Image domain agrees: C5j-16 peak ACF **0.618** vs 0.250 for the same kernel with a white hash, grain anisotropy **2.93** vs 1.58 on the confound-free `iso-smooth` stimulus. IGN is a temporal-accumulation dither; as a spatial-only per-pixel rotation it is a weave generator. Dropped explicitly. |
| **C5f-16 — a 1-CSS-px frozen-ref lattice** (the "keep a lattice, just make it finer" escape) | Still blocky at DPR 2: dominant amplitude **4.163 codes at period 2** and block-edge excess **2.51**, against gates of 0.25 and 0.5. Its DPR-flip excess is excellent (0.06, C0-like) but the block is simply 2 device px instead of 8. **Caveat: confounded** — it also used the IGN rotation, so a 1-CSS-px lattice with a pcg2d rotation is untested (open question 7). |
| **C6 — dual-filter pyramid prefilter + a 4-tap gather** | vsGT **18.18 mean / 25.88 worst**, `holeDeficit` −1.49, `L1 vs disc` 0.767 at its current radius fit — it does not reproduce a disc at the nominal radius without a radius refit. And it needs a compiler concept that does not exist: pass boundaries today come only from `textureInput: true` on an input port, so a node owning *auxiliary internal passes* plus pyramid-level pool allocation and ping-pong aliasing would have to be built first (compiler + RenderPlan + both renderers). Priced, not proposed. It remains the only formulation whose cost is independent of radius. |
| **C7 — 256-tap stratified disc (the anchor)** | 256 fetches/px = **13.97 ms/frame at 1080p, 55.9 ms at 4K**. Also not the desired look: it has *zero* grain character and reads as a plain blur, which the brief names as the other failure mode. It is the accuracy anchor, not a target. |
| **More taps alone (no stratification)** | 256 *iid* taps still sit at 1.36 codes speckle against a target of 0.27; converging a step edge to 2 codes needs **N ≈ 8100**. |
| **Blue-noise / STBN texture for the rotation** | Not needed — pcg2d already reaches the iid floor (0.0078 vs 0.0089). Would cost a new global sampler binding in both renderers, the asset riding in `src/embed/artifact.ts` (the player half may not import compiler/nodes), and a hit against `verify:embed:bundle`. |
| **Anything mip-assisted** | WGSL forbids `textureSample` under the non-uniform `frost` branch and pass textures are single-mip, so LOD 0 is the only level. WebGPU has no `generateMipmap`; you would author a downsample pipeline and run it per pass per frame, interacting badly with the ping-pong pool. Verified live by a positive control that must fail to compile — and does. |

**Dominated but not rejected:** C3j-24 and C5-24/C3-24 are strictly better on accuracy (vsGT 2.02–2.11)
and resize (3.01 vs 4.20) for +50% fetches. They are the same algorithm with N changed. C3-16 /
C3j-16 / C5-16 / C5j-16 all read vsGT 2.92–2.95 — the sweep cannot separate them on that metric,
which is exactly why the PSF and look measurements had to break the tie.

---

## 6. Open questions

1. **How much grain is "frosted glass"?** This is the one genuine perceptual call and no metric can
   make it. The frost texture *is* the estimator residual, so `vsGT` monotonically rewards erasing
   the look: it ranks 24 taps (2.02) above 16 (2.95) above 8 (5.41), straight toward the plain blur
   the brief also calls a failure. Residual rms at frost 1, DPR 2: 8 taps **8.71** →
   **16 taps 4.67** → 24 taps 3.15 → 256 taps **0.46** (that is C7 against an independently seeded
   C7 — i.e. no character left at all). Look at panels 3 and 4 of
   `reports/blur-bakeoff/phase9/look-hash/compare-1to1-f1000.png` at 1:1 and pick.
2. **Resize boil vs block seams.** 4.20 codes over 85% of pixels during a window drag, versus
   1.63 codes over 12% today. Both are transients; which is less objectionable needs a live drag,
   not a number.
3. **Uniform disc vs Gaussian radial profile.** 0.7–2.7 codes apart at these radii. The disc is flat
   (reads "etched"), the Gaussian is centre-peaked (reads "soft focus") and is arguably the more
   physical model — real forward scatter is a peaked lobe with a low-amplitude wide tail, not a
   pillbox. The phase-9a anchor is a disc, so the disc is recommended by default. User's eye.
4. **Should the radial jitter also come from pcg2d?** The `reedHash.y` lane used for it is
   measurably non-white (field ACF **0.843 at lag (7,0)**) but did not surface in the image once the
   rotation was fixed. The `pcgBoth` variant was captured — images exist at
   `reports/blur-bakeoff/phase9/look-hash/tilen-f1000-pcgBoth.png` — but its numbers were **not
   retained**: `phase9-look-hash.json`'s `partB` array is empty after a later `--cpu` rerun. The
   recommendation therefore ships the configuration that *was* measured (`pcgRot`). Re-measure
   before switching.
5. **Re-scale `frost` by ~1.155 to preserve perceived strength?** The square→disc change narrows the
   RMS radius by 13.4%. Compensating keeps existing scenes looking the same but breaks the
   phase-9a ground-truth anchor (which is defined at radius `frost · 24 · u_dpr`). No metric can
   choose; it depends on whether existing saved graphs matter more than a clean definition.
6. **Gamma.** The average runs in stored sRGB, off by up to 60 codes at a black/white boundary
   (§4). Fixing it means either `-srgb` pass textures or an explicit linearise/re-encode around the
   accumulation — a change whose blast radius is every multi-pass effect, not just frost. Out of
   scope here, but it means the bench's *absolute* codes are optimistic: the bench gathered in
   linear light on `rgba16float`, the engine gathers in gamma on `rgba8unorm`. **Rankings are
   common-mode and transfer; absolute code values do not.**
7. **A 1-CSS-px frozen-ref lattice with a pcg2d rotation is untested.** It is the only structure that
   could give per-pixel-class decorrelation *and* resize invariance (`u_dpr` cancels, so the field
   is fixed in CSS space). The one measured attempt (C5f-16) failed the block gate at
   domAmp 4.163 / blockExcess 2.51 — but it also carried the discredited IGN rotation, so the
   result is confounded. If the resize boil (open question 2) turns out to be unacceptable, this is
   the first thing to measure, not more taps.
8. **Metric reliability — from the adversarial measurement audit (verdict: QUALIFIED).** The case
   against C0 survives every attack (blockExcess 15.13, domAmp 3.617 at its true peak, ACF lag 1
   0.858, and 0.346 on the alpha sprite even after masking). But three shape gates and all five ROI
   correlation metrics are broken in ways that specifically corrupt comparisons *between the good
   candidates*:
   - **No alpha-coverage mask** on `residualAcf` / `blockPeriodSpectrum` / `speckleRms` /
     `blockEdgeExcess` / `directionalCorr`. On the alpha-sprite stimulus 10.8% of ROI pixels have
     α < 8 and disagree by up to 255 codes while being invisible. **Consequence: the recommended
     candidate's "blocky = YES" flag in the ranking table is a metric artifact** — its alpha-sprite
     ACF lag 4 reads 0.170 unmasked and **0.016 masked**, and on the photo it reads −0.011. Eleven
     of nineteen candidates trip the gate on invisible pixels.
   - **`psf.ringiness` is bin-limited.** An ideal 24-shell ring set scores 0.191, *under* the 0.20
     gate, and the known-good floor moves 5× with radius. The N = 8 and N = 16 comparisons quoted
     above are inside its valid range and are corroborated by `profileL1Disc` (monotone
     0.715/0.468/0.221/0.204/0.128 for N = 4/8/12/16/24); **nothing at N ≥ 24 can be read from it.**
   - **`psf.holeDeficit`'s known-bad is mislabelled** (analytic un-jittered Vogel N=8 reads −0.506,
     not the +0.845 annulus it is calibrated against) and the metric only fires at N = 4.
   - `residualAcf.shoulderLag` saturates silently; `blockPeriodSpectrum.dominantAmplitude` can
     under-report the true peak by 0.53×; two gates are anchored on a self-comparison; three of 21
     rows per cell are ground-truth self-comparisons reading 0 by construction; the cost gate's
     reproducibility is within-run only (23% between runs); `phase9-report.ts:360-361` contains two
     comparisons against non-existent `GATES` keys that evaluate to `false` unconditionally.
9. **The full sweep never ran.** Everything here is the `--quick` matrix (frost 1, DPR 2, WebGPU,
   2 stimuli, 259 captures) plus the look sweep (frost 0.125 / 0.25 / 1 at DPR 1 and 2, 5 stimuli)
   and the phase-9a target sweep (R = 6/12/18/24 CSS at DPR 1 and 2, 4 stimuli). **The wide end —
   the decisive case — is covered.** The middle of the frost range crossed with DPR 1 on WebGL2 is
   not. `--sweep` is ~3000 captures / 25–45 min if that gap matters before merge.
10. **Nothing has been seen on a real display.** All of this is headless Chrome on one GPU. The
    per-frost look verdicts (fail at 1.0, qualified fail at 0.25, pass at 0.125 — all *before* the
    hash fix) came from 1:1 PNG inspection, not from the app.

---

## 7. Repro

From the repo root.

```bash
# The exact GLSL + WGSL of section 2.2, compiled and rendered on a real GPU on both
# backends, with the uniformity positive control that must fail. ~10 s.
npx tsx scripts/blur-bakeoff/phase9-final-block.ts

# Metric calibration + the C0-vs-target decomposition (phase 9a). ~204 s.
npx tsx scripts/blur-bakeoff/phase9-target.ts

# Bench self-validation: 25 gates, known-good and known-bad for every metric. ~50 s.
npx tsx scripts/blur-bakeoff/phase9-frost.ts --validate

# The candidate sweep. --quick is the matrix every number in §1-§5 comes from (~80 s,
# 259 captures); bare --sweep is 21 candidates x 5 frost x 2 DPR x 2 backends x 5 stimuli
# (~3000 captures, 25-45 min).
npx tsx scripts/blur-bakeoff/phase9-frost.ts --sweep --quick
npx tsx scripts/blur-bakeoff/phase9-report.ts

# Off-axis / ordered-structure look pass across the frost range at both DPRs. ~2 min.
npx tsx scripts/blur-bakeoff/phase9-look.ts

# THE decisive one: hash-field autocorrelation (part A, CPU, ~3 s) + the GPU ablation that
# swaps only the rotation hash (part B, ~90 s). This is what turns the benched winner from
# BROKEN into shippable.
npx tsx scripts/blur-bakeoff/phase9-look-hash.ts
npx tsx scripts/blur-bakeoff/phase9-look-hash.ts --cpu   # part A only

# Transfer into the real node: registers clones of reededGlassNode with only the frost
# statement swapped, runs the real compileGraph + compileGraphIR + assembleWGSL, then real
# Tint and a real WebGL2 driver. 52/52 with both positive controls firing.
npx tsx scripts/blur-bakeoff/phase9-transfer-verify.ts

# Resize / DPR re-roll, the axis the bake-off never scored.
npx tsx scripts/blur-bakeoff/phase9-transfer-reroll.ts

# Harness audits (read these before trusting a new metric).
npx tsx scripts/blur-bakeoff/phase9-harness-probe.ts
npx tsx scripts/blur-bakeoff/phase9-detector-calibration.ts
npx tsx scripts/blur-bakeoff/phase9-webgl-filter-bug.ts
npx tsx scripts/blur-bakeoff/phase9-wgsl-uniformity.ts

# After implementing, the repo's own gates:
npx tsx scripts/verify-ir-poc.ts            # 85 passed / 0 failed today; lines 1742 + 1770 need 8.0 -> 16.0
npx tsx scripts/validate-wgsl-multipass.ts  # 167/167 today
npm run lint
```

Outputs land in `reports/blur-bakeoff/phase9/` (gitignored):
`phase9-target.json`, `phase9-validate.json`, `phase9-quick.{json,md}`, `phase9-reduced-quick.md`,
`phase9-look.json`, `phase9-look-hash.json`, `phase9-transfer.json`, `phase9-transfer-reroll.json`,
plus PNG proof packs in `target/`, `frost/`, `look/`, `look-hash/`.

**Two harness traps that will silently manufacture the artifact under investigation:**
`gpu-rig.ts:559-570` — on WebGL2, pass 0 silently ignores `filter: 'linear'` (the `origTex` bind at
TEXTURE1 overwrites the filter state on the same texture object), so every tap snaps to a texel
centre. Never make the gather pass 0. And `sampleOrig` is hard-wired to NEAREST on both backends —
never gather through it.
