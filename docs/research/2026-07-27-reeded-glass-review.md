# Reeded Glass — symptom triage and findings

`src/nodes/transform/reeded-glass.ts`. Every claim below was re-derived against the file plus CPU replicas of the emitted GLSL/WGSL; where a number is quoted it was measured, not estimated.

Two structural facts that matter throughout:

- **The lens math is duplicated.** `reedLens` exists twice (`:64-83` GLSL, `:393-402` IR raw). `reedHash` exists three times (`:168-175` GLSL, `:414-419` IR-GLSL, `:421-426` IR-WGSL **override**). Every fix below must land on all copies or the backends silently diverge — nothing in the repo checks this.
- **`:3` is wrong.** "Snell's law refraction" — there is no `asin`, `refract`, `atan` or `reflect` anywhere in the file. `:79` `disp = -slope * (ior - 1.0) * 0.5 * amp` is a **linearised thin-prism deviation**. A real refraction deviation self-limits (bounded at `tan(θ − asin(sinθ/n))`, max 1.12 for n=1.5); this linear form diverges as the arc slope goes to infinity at the rib edge. That single fact is the root of S1.

---

## S1 — "curvature is nice, but odd at large IOR: straight lines at the rib's edge"

**Verdict: BUG** (primary), with a genuine EXPECTED caustic underneath it and two secondary contributors.

### Primary: `clamp(lensed, 0.0, 1.0)` clamps a *position*, freezing the sample coordinate

`:82` and `:402` (byte-identical):

```glsl
return (floor(coord / ribW) + clamp(lensed, 0.0, 1.0)) * ribW;
```

Once the clamp saturates, `reedLens` returns `floor(coord/ribW)*ribW` — independent of `coord`. `d(sample)/d(screen)` is **exactly zero** across the band, so every fragment in it samples one identical source column.

That it's *exactly* zero (not merely compressed) is provable, not approximate. `disp = lensedScreen − warpedMainScr` (`:337`), added to `gl_FragCoord.xy/u_viewport` (`:344`). `u_viewport == u_resolution` on every renderer path (`webgpu/renderer.ts:750`, `:771`; `webgl/renderer.ts:940`) and `v_uv == fragCoord/u_resolution` identically (`wgsl-assembler.ts:345`). With straight ribs and identity SRT, `warpedMainScr = v_uv.x − u_anchor.x` (`:276`), so `sampleUV.x = lensed_const + u_anchor.x` — analytically constant. `sampleUV.y` still varies, so the band renders as one source column stretched across it, with a hard discontinuity where the two bands flanking a seam meet (they clamp to *opposite* ends, sampling columns `2*ribWidth` apart — measured seam jump 160 px at ribWidth 80).

**Threshold, solved exactly:** saturation when `(ior−1)·0.5·amp·c2/sqrt(1−c2²) ≥ 1`.

| curvature | onset IOR | at default IOR 1.5 |
|---|---|---|
| 0.8 (default) | **2.500** | 0% clamped |
| 0.9 | 1.969 | 0% |
| 0.97 | 1.500 | onset |
| 1.0 | 1.285 | 2.1% of each rib |
| 2.0 | 1.142 | 10.7%, 11 px runs |

So the trigger is not really "large IOR" — it is **`(ior−1)·curvature`**, and the curvature slider reaches it much faster. At curvature 0.8 the slider max of 3.0 (`:110`) is reachable and gives 15.2% of every rib pinned. At curvature 2.0 (`:115`) the *default* IOR already pins 254 px of a 1200-px row.

### Underneath it: a real caustic that the fix will not remove

Independent of the clamp, `d(lensed)/d(local) = 1 − (ior−1)·amp·c2/(1−x²c2²)^1.5` crosses zero at `local ≈ 0.078 / 0.922` **at the shipped defaults** (ior 1.5, curvature 0.8) — measured 15.5% of each rib already non-monotonic with zero clamping, ~12 px of output showing ~2 px of source (6× smear) at each rib edge. That is physically correct for a cylindrical rim and is what `:54` advertises ("bright caustic lines at rib seams"). **EXPECTED.**

So the honest framing: the clamp does not create the phenomenon, it **widens a ~1 px caustic that reads as normal into a 5–12 px dead-flat band and adds a hard seam discontinuity.** Expect the fix to remove the flat stripes and leave a thin caustic line — S1 improves, it does not vanish.

### Secondary contributor: single-tap undersampling

One bilinear tap (`:359`/`:363`, IR `:682`/`:686`), no mipmaps (`webgl/renderer.ts:355`, `webgpu/renderer.ts:478-480`). `|f'| > 1` texel/px begins at **ior ≈ 1.58** at curvature 0.8 — a full IOR unit before the clamp. Realised (post-clamp) maxima are modest: 2.47 texels/px at ior 2.0, 2.91 at ior 3.0, worst case anywhere ~16.7. That reads as detail loss / moiré on high-frequency source content, **not as lines**. **TUNING**, low priority, and masked whenever `frost > 0`.

### Secondary contributor: canvas-border clamp band (frequently mistaken for S1)

`:344`/`:346` add `disp` to a screen UV where `[0,1]` is literally the canvas rect; taps past it clamp to edge. `max|disp| = f(ior,curvature)·ribWidth` — already **0.333·ribWidth at the defaults**. Whether any column escapes depends on the rib phase at the border, `frac(cssWidth/(2·ribWidth))`:

- W=1200 puts the border exactly on a rib *centre* — the single most favourable phase — hence 0 columns at defaults. That is why this looks like it never fires.
- Same defaults, other widths, ribWidth 80: W=1136 → 16 columns / 18.3 px off-canvas; W=1000 and W=1160 → 40 columns; W=1512 → 6. At ribWidth 400: W=1000 → 200 columns; W=900 → 100 columns / 82.9 px off-canvas.

So a dead-straight smear pops in and out at the left/right border **as the window is resized, at stock settings**. Different location, different fix from the clamp band. Also contributes to S4 (escaping fragments all read one source column, so horizontal input features render perfectly straight there).

### Ruled out — do not spend effort here

- **No missing total-internal-reflection branch.** Entering a denser medium always has a solution (`sin θt = sin θi/n ≤ 1` for n ≥ 1, and `ior` min is 1.0 at `:110`); `:73` caps `c2` at 0.99 so even a true `asin` would stay in domain.
- **Taps never leave their own rib** — `floor(coord/ribW)` + a `[0,1]` term confines the result by construction (measured `max|disp|` asymptotes to exactly 79.5 px at ribWidth 80). Caveat: only true at `srt_scale 1`, `srt_rotate 0`, `frost 0` — see S4 and S3.
- **`max(1.0 - x2, 0.001)` at `:75`/`:399` is dead code.** With `|x| ≤ 1` and `c2 ≤ 0.99` the argument is ≥ 0.0199, 20× the guard. The real limiter is the 0.99 cap. (Not unconditionally dead: `ribWidth` is connectable with no floor, so a wired `ribWidth ≤ 0` pushes `local` out of `[0,1)` — pre-existing, unrelated.)

### Curvature response — TUNING, related

`:73` `c2 = min(c, 0.99)` puts the arc asymptote where the derivative is steepest: edge slope 0.577 / 1.333 / 2.065 / **7.018** at curvature 0.5 / 0.8 / 0.9 / ≥0.99. That 5.3× jump happens across curvature 0.8→0.99, i.e. **the middle of the slider** — and the whole top half (1.0→2.0) leaves `c2` pinned and only scales `amp`. That is documented intent (`:69-70`), so it is tuning, not a bug, but two doc lines are wrong: `:61` promises curvature 1 = semicircle (it is slope 7.018, not infinite) and curvature 0 = flat (`:71` floors at 0.01 — residual 0.5% of a rib as a seam step at ior 1.5, 2.0% at ior 3.0; 2 px and 8 px at ribWidth 400, not sub-pixel).

---

## S2 — "the grain used to flicker (it's gone now, but still)"

**Verdict: BUG.** The mechanism is live; it is quiet only because nothing is currently animating a lens parameter.

`:358` (IR `:681`):

```glsl
vec2 rg_jit = reedHash(rg_sampleUV * 0.1 + float(rg_i) * 7.31) * rg_frad;
```

`reedHash` is an integer hash over raw float bits (`:169` `floatBitsToUint`, `:421` `bitcast<u32>`), so **any** mantissa change fully decorrelates the output. And `rg_sampleUV` is contaminated twice over:

**(a) Screen-pixel-locked.** Both numerator and denominator move on resize. Measured across the DPR quality-tier flip (`ANIMATED_DPR_SCALE 0.75` / `STATIC_DPR_SCALE 1.0`, `webgpu/renderer.ts:119-120`, folded in at `:844` → `:750`): 0/400 fragments keep their jitter, mean |Δ| 0.538. A 1-CSS-px widen: 0/400, mean |Δ| 0.652.

**(b) Distortion-locked.** `sampleUV` carries `disp` (`:337`), a function of `ribWidth`, `ior`, `curvature`, the SRT block, and (for non-straight ribs) `amplitude`/`wavelength` — all `updateMode: 'uniform'` and all `connectable: true` (`:106`, `:111`, `:116`, `:148`, `:154`). Nudging `ior` by 0.0005 — one twentieth of a slider step, moving `sampleUV` a mean 0.0100 texels, visually nothing — flips half the jitter components and changes output colour by mean |Δ| 0.0944 (~24/255). **351× the change a glass-space seed would give.** Wire a Time node into `ior` or `srt_translateX` and the whole grain field reseeds every frame. That is the flicker.

Physically, frost is etched on the glass, so the grain must be fixed in glass space. Note `frost` itself is **not** in the seed (it only scales the radius at `:356`), so dragging Frost never reseeds.

### Important correction to the obvious fix

Substituting `rg_coords_<id>` (`:186-198`) **alone does not fix it.** `rg_coords` is the right *space* — algebraically invariant for a fixed glass point under both resize and DPR flip, since `(fragXY − u_resolution·u_anchor)` and `(u_dpr·u_ref_size)` scale together — but it is a **continuous** function of the pixel centre, and a DPR flip relocates every pixel centre. Measured with continuous `rg_coords * 512`: **0/400 identical across the tier flip, mean |Δ| 0.6975** — statistically indistinguishable from what ships today.

The seed must be **quantised to a ref-space lattice**. Measured keep-rates:

| lattice pitch | 2.0→1.5 | 2.0→1.0 | 1.0→0.75 | 1200→1201 px @ dpr 1 |
|---|---|---|---|---|
| continuous | 0% | 0% | 0% | 0% |
| 1 CSS px | 83.4% | — | — | 51.5% |
| 2 CSS px | **100%** | 100% | 69.3% | 74.5% |
| 4 CSS px | 100% | 100% | **100%** | 87.0% |

2 CSS px is exact only for the `(2.0, 1.5)` dpr pair (4 and 3 whole device px). 4 CSS px covers a 1× display's own 1.0→0.75 flip. Pitch is a stability-vs-grain-size trade, not a solved constant. And note "exactly stable under pure resize" is false at any pitch: `u_resolution·u_anchor = W/2`, so an odd device width shifts the whole field by half a device pixel.

Two couplings:

- **Ship with the S3 radius fix or S2 is only half fixed.** `rg_frad` is a constant in *screen UV* (`:356`), so a bit-identical seed still lands on different texels after a resize.
- Where the S1 clamp saturates, `d(sampleUV)/d(frag) → 0`, so the seed goes stationary and runs of pixels get identical jitter — frost collapses into flat bands instead of dithering them. Nil at defaults (1200/1200 distinct); 61.8% duplicated with 27 px runs at ior 3 / curvature 2. Minor S1 aggravator.

---

## S3 — "the grain is stretched at edges"

**Verdict: BUG**, two independent causes that compound. Plus a tap-distribution issue.

### (a) The frost radius is the only un-normalised *length* in the node

`:356` (IR `:679`, character-identical):

```glsl
float rg_frad = frost * 0.02;
```

A **scalar** in per-axis screen UV, multiplied into the `vec2` hash at `:358` and added to `sampleUV` at `:359`. So the footprint is a rectangle with exactly the canvas aspect:

| viewport | radius (device texels) | aspect |
|---|---|---|
| 1200×800 | ±24 × ±16 | 1.50:1 |
| 1920×600 | ±38.4 × ±12.0 | 3.20:1 |
| 800×800 | ±16 × ±16 | 1.00:1 |

Every other px-space quantity in this same file **is** converted: `:209-210`, `:248` divide by `u_ref_size`; `:254`, `:298-299` do `* u_dpr / u_resolution.<axis>`.

Two calibrating notes:

- **The reach in CSS px is `0.02·frost·clientSize`** — the `dpr` cancels, since `fragCoord` and `u_viewport` both scale with it. So the tier flip does *not* change frost's extent. That cleanly isolates S2 to the seed and S3's global half to this line.
- **What is stretched is the *reach*, not the grain cells.** The interior grain is per-pixel white noise (measured lag-1 autocorrelation 0.025 in x, −0.146 in y) because the hash argument decorrelates completely between adjacent fragments. So detail and the grain halo smear 1.5× farther horizontally at 1200×800, 3.2× at 1920×600. Framing it as "the grain cells are stretched" would send you looking in the wrong place.

### (b) Border taps clamp to edge

Pass samplers are clamp-to-edge (`webgpu/renderer.ts:481-482`, `webgl/renderer.ts:352-353`). At frost=1, 1200×800, the share of the 8 taps that clamp: **49.0%** at x=0, 44.7% at 2 px, 36.4% at 6 px, 23.9% at 12 px, 11.4% at 18 px, **0.0% at 24 px** — exactly the radius. Bias test (black 1-texel border column, grey interior): the edge pixel reads 0.2443 instead of 0.500, decaying linearly to 0.4944 at 24 px. `blur.ts:196-201` documents the identical artifact in this repo's own words.

Three corrections to how this is usually described:

- **Not "one repeated texel."** The jitter is 2-D, so at the left edge x pins to column 0 while y still varies ±16 px — measured mean streak 16.7 px, both-axes clamping 0.00% away from corners. The 49% lands on the border **column/row**, so what bleeds inward is a border-parallel blur of the edge line.
- **The smear direction is border-NORMAL** (edge colour dragged inward), and **variance does not collapse** (sd 0.1499 at x=0 vs 0.1591 interior). The grain does get blotchier inside the band (detrended lag-1 0.495/0.451 vs 0.025/−0.146) — isotropically.
- The frame is uneven in *both* directions: band wider on left/right (24 vs 16 px), streak longer on top/bottom (21.9 px vs 16.7 px).

**Do not fix this with blur's gate-and-renormalise.** Blur can renormalise losslessly because its Gaussian weights are deterministic. Making the divisor a per-pixel random variable amplifies variance: measured edge sd 0.1029 → **0.1692 (+64%)**, i.e. you trade a smear band for a noisier speckle band in the same 24 px. **Mirror the tap instead** — measured 0.4794 vs the 0.500 ideal (gate gives 0.4705) with sd flat at 0.1051, no branch, no counter, and `abs`/`fract` need no translation rule.

### (c) Tap distribution — TUNING

8 iid taps over a uniform **square**: 21.5% land beyond r=1 (theory 1−π/4 = 21.46%), mean tap radius 0.7652 (disc ideal 0.6667), directional density deviating up to 17.4% over 16 bins. Worse, the 8 seeds differ only by `+ i*7.31` (`:358`), so pairs whose offsets fall in the same float32 binade get a *constant* integer input delta through an affine hash core — i=3,4 (both in [16,32)) and i=5,7 (both in [32,64)) measure **r = 0.832 and 0.835**. Effective tap count 5.7 of 8; peak-at-edge speckle **57.9 sRGB codes** against iid theory 45.1.

Decorrelating the per-index seed only reaches iid parity (57.9 → 45.4 codes; worst pair 0.83 → 0.44, sign-flipped rather than removed). A stratified disc — one hash for a per-pixel rotation, tap `i` at `rot + i·π/4`, radius `sqrt((i+0.5)/8)` — measures **9.5 codes (6.1×), 0.00% wasted taps, mean radius 0.6690, directional deviation 0.0%**. That is a deliberate look change, but it is the difference between "frost" and "speckle".

---

## S4 — "sometimes I can see that horizontal lines of the input aren't curved"

**Verdict: EXPECTED for the default configuration** (this is the "here is why it looks wrong to you" case), **BUG for three specific configurations** — which is exactly the "sometimes".

### The expected part

`:343-347` (IR `:655-667`) add the displacement to **exactly one component**:

```glsl
vec2 rg_sampleUV = gl_FragCoord.xy / u_viewport + vec2(rg_disp, 0.0);   // vertical
                                               + vec2(0.0, rg_disp);    // horizontal
```

For `direction: vertical`, `sampleUV.y` is *literally* the fragment's own row. A source row maps to that same output row, for any `ior`, `curvature`, `ribWidth`, `amplitude` or rib type. A horizontal line cannot bend — it can only slide along itself.

That is correct optics: a cylindrical lens array with a vertical axis has **zero optical power along the rib axis**. Real vertically-fluted glass does exactly this — verticals get chopped into laterally offset segments (which reads as a staircase, not a curve), diagonals staircase, horizontals stretch along themselves. So for `ribType: straight`, `srt_rotate: 0` there is nothing to fix. Worth one line in the description (`:90`): *"refracts perpendicular to the ribs — lines parallel to the ribs stay straight."*

(Two nits on the strict version of the claim: with `frost > 0` the jitter *is* 2-D (`:358`/`:681`), so rows do get resampled — randomly, so it blurs rather than bends. And chaining a vertical + a horizontal node is **not** the composition of two 1-D refractions — it superimposes a second independent rib array, i.e. plaid. Don't suggest it as "the intended composition".)

### BUG 1 — wave / circular / noise ribs discard the perpendicular deviation

`:330` (IR `:625`) sets the rib phase to `φ = main + w(perp)`. The ribs are therefore **tilted**, and refraction through `h = H(φ)` deviates along `∇φ = (1, +∂w/∂perp)` — which has a perp component. The node computes the scalar delta in φ-space (`:337`) and spends 100% of it on the screen main axis.

At the **default** amplitude 20 / wavelength 200, the pixel-space rib slope is `2π·20/200 = 0.628` → ribs tilt **32.1°**, so 53% of the true deviation magnitude is discarded and the horizontal displacement is simultaneously ~17.5% too large (`disp` is in warped-φ units, not perpendicular distance). At amplitude 200 / wavelength 10 the tilt is 89.5° — the node then applies the entire refraction *along* the rib axis, the one direction with zero power. Circular (`:324`/`:619`) is the same; noise (`:328`/`:623`) depends on both axes so its gradient is 2-D everywhere.

If you fix this, three traps:

- The normal is `normalize(vec2(1.0, +dw))`. `(1.0, -dw)` is not perpendicular to the tangent `(-dw, 1)` and roughly doubles the angular error vs doing nothing.
- Displacing by `disp` along the **unit** normal over-displaces by `|∇φ|`. The correct first-order inverse is `disp · ∇φ / |∇φ|²` = `disp * vec2(1.0, dw) / (1.0 + dw*dw)`, which collapses to `vec2(disp, 0.0)` at `dw = 0` — so straight ribs stay byte-identical by construction.
- A 1-texel finite difference is wrong for `square` (`:315`), `sawtooth` (`:317`) and `triangle` (`:313`): `dw ≈ 2·amp/eps` on the discontinuity rows, so the normal flips to ≈(0,±1) and you get a row of streaks. Gate `dw` to the continuous shapes or derive it analytically. `main`/`perp` are anisotropic v_uv units (`:576`), so do the gradient in pixel space (the node already does this at `:319`/`:324`/`:328`).

### BUG 2 — `srt_rotate` rotates the ribs but not the refraction

`:281-285` (IR `:578-582`) rotate the pattern basis; `:344` still applies the offset along screen x, never mapping it back through `R(−θ)`. Measured cosine between the true cross-rib direction and the applied offset: **1.000 / 0.866 / 0.707 / 0.000** at `srt_rotate` 0 / 30 / 45 / 90. At 90° with vertical ribs the ribs become horizontal bands and the displacement runs *parallel* to them: each band is shifted sideways by a constant → a venetian-blind shear, with zero cross-rib refraction. That is the most literal reading of "the ribs are clearly diagonal and my horizontal lines don't bend at all."

### BUG 3 — `srt_scale` up = weaker glass

`disp` is a delta measured in the pattern basis, which `:277` pre-divides by `srt_scale`, and it is added to unscaled screen UV. Every *other* pattern length co-scales (rib period `:254`, amplitude `:298`, wavelength `:299`); `disp` alone does not. Measured at ribWidth 80 / ior 1.5 / curvature 0.8:

| srt_scale | on-screen rib period | max &#124;disp&#124; | disp per rib |
|---|---|---|---|
| 0.5 | 40 px | 26.7 px | 0.667 |
| 1 | 80 px | 26.7 px | 0.333 |
| 2 | 160 px | 26.7 px | 0.167 |
| 4 | 320 px | 26.7 px | 0.083 |

Fix: `disp *= srt_scale` (single site — the rest of the pattern already co-scales). Also breaks the "taps stay in their rib" invariant: at scale 0.5 a tap reaches two ribs away.

**Fixing 2 and 3 requires one delta-transform:** `d.x *= asp; d = R(−rad)·d; d.x /= asp; d *= srt_scale`. Verified algebraically correct and isotropic (at θ=90 the offset magnitude comes out 26.67 px along y, matching 26.67 px along x at θ=0). **It must be emitted per-backend** — see divergence B below — because the moment the delta acquires a y component, WebGL2 and WebGPU refract in opposite y directions.

---

## Not reported by the user

### A. Wiring the **Frost** input kills WebGPU entirely — worst bug in the file

`frost` is `connectable: true` (`:118-122`). The frost raw block (`:676-687`, single-argument `raw()`, so mechanically translated) puts `texture(...)` inside `if (rg_frost > 0.001)` at `:677` and inside the loop at `:682`. `wgsl-backend.ts:99` rewrites `texture(` → `textureSample(`, which WGSL permits only from **uniform control flow**.

Compiled `noise → rg.frost` and ran the real module through Tint in headless Chrome:

```
error: 'textureSample' must only be called from uniform control flow
info: control flow depends on possibly non-uniform value
info: parameter 'in' of 'fs_main' may be non-uniform
```

The condition traces to `in.position.xy`, so it is provably non-uniform, not merely unprovably uniform. Unwired, the condition is `uniforms.u_rg_frost` and it compiles clean — which is why this has never been seen.

**The failure is quieter and wider than "the node goes blank."** `createRenderPipeline` does not throw on an already-invalid module, so the try/catch at `webgpu/renderer.ts:370-388` never fires and the renderer reports compile **success**. At draw time the invalid pipeline invalidates encoder → command buffer → `Queue.Submit`, so the **entire frame is dropped, including the pass's `loadOp: 'clear'`** (measured: first pixel `0,0,0,0` instead of the red clear). The only trace is a fire-and-forget `console.error` from `logCompilationErrors` (`:643-653`) that never reaches `compilerStore`. Node thumbnails fail identically. WebGL2 has no uniformity rule, so the graph works on the fallback backend and dies on the primary one.

I wired every connectable float on all 7 `textureInput` nodes and GPU-compiled: **only `reeded_glass` fails.** It is the only node with a texture fetch under a data-dependent branch, so this is not a floodgate.

**Fix:** give the frost `raw()` an explicit second (WGSL) argument using `textureSampleLevel(<s>_tex, <s>_samp, uv, 0.0)`, exactly as `blur.ts:153` does inside its two-argument `raw()` at `blur.ts:339`. This node already uses two-argument `raw()` twice (`:412-427`, `:438-466`) and the frost block interpolates only local var names, the sampler name and `ctx.outputs.color` — no port defaults — so the `blur.ts:333-337` caveat (which is scoped to blur's *no-sampler* branch, whose body interpolates GLSL-syntax port defaults) does not apply. Alternative: add a `textureLod` rule beside `wgsl-backend.ts:99` and change four tokens; smaller diff in this file, new shared-backend surface. Either way, LOD 0 is behaviourally free — no pass texture has mips (`webgpu/renderer.ts:479-480`, `webgl/renderer.ts:355`).

### B. GLSL↔WGSL divergence: `direction: horizontal` refracts the wrong way on WebGPU

`disp` is derived from `rg_srt_scr`, built from `v_uv` (`:276` / `:576`) — and `v_uv = a_position*0.5+0.5` in **both** backends (`glsl-generator.ts:110`, `wgsl-assembler.ts:345`), so it is y-**up** everywhere. But the sample base is `gl_FragCoord.xy/u_viewport` (`:344-346`, IR `:650-654`), and `wgsl-assembler.ts:184` rewrites `gl_FragCoord` → `in.position`, which is y-**down**. The node's own comment at `:338-340` relies on that for the *base*; the sign of `disp` was never propagated.

For horizontal the main axis *is* y, so a y-up delta is added to a y-down base. Measured at 1200×800, ribWidth 80, ior 1.5, curvature 0.8: the WGSL sample row differs from GLSL by exactly **2× the offset at every fragment** (51.54 px, offset 25.77 px) — a pure sign flip. Vertical control: 0.00 px.

Consequences, and this is worse than "mirrored":

- `disp` is odd about the rib centre, so the lens inverts: `d(sampled row)/d(screen y)` at the rib centre is **0.60 on GLSL** (magnification at centres — what `:4-5` and `:53` document) vs **1.40 on WGSL** (compression at centres, magnification at seams). Rib boundaries stay put, so it doesn't read as "the ribs moved."
- The negation is applied to the already-clamped delta, so the `:82` clamp no longer protects containment: GLSL maps each rib's local 0..1 onto source 0.333..0.667 (contained); WGSL maps it onto **−0.333..1.333**, so 32.4% of every rib samples across the seam into its neighbours at the defaults (62.7% at ior 3.0).
- WGSL also pushes edge fragments off-canvas at the **default** ior: at fragY=0, `sampleUV.y = −0.0316` where GLSL gives 0.967, so WebGPU grows a clamp-to-edge straight band along the top/bottom that WebGL2 never shows. That is a plausible S1/S4 contributor for horizontal graphs.

WebGPU is the default renderer, so this is what users see.

**Fix — and one tempting fix is wrong.** Negate only the y component on the WGSL side, in the `!isVert` IR branch (`:661-667`). Leave `glsl()` `:346` alone; it is the self-consistent reference. I simulated three variants across six configs (default SRT / rotate 15° / translateY 40, each direction), reporting max GLSL↔WGSL delta:

| variant | horiz | horiz+rot | vert | vert+rot |
|---|---|---|---|---|
| current | 51.54 | 53.33 | 0.00 | 0.00 |
| rebase `srtScr` to `in.position`-based | 0.00 | **52.04** | 0.00 | **52.77** |
| negate y of the offset only | 0.00 | 0.00 | 0.00 | 0.00 |

Rebasing `srtScr` mirrors y *ahead of* the rotate block (`:580-582`), which is `R(−θ)∘mirror` rather than the mirror of the correct result — it changes the rib *angle*, under-fixes horizontal+rotate, and **regresses vertical+rotate from pixel-identical to 52.77 px**. It also leaves `:583`'s bottom-up translate sign and `:619`'s bottom-up circular basis inconsistent with the new basis. Don't.

Note also: `reeded_glass` is the **only** `textureInput` node in the repo that adds a signed, frame-dependent delta to its sample base. `blur.ts:164-171` uses a symmetric ± kernel (sign-immune); `pixelate.ts:53-63` and `pixel-grid.ts:197-199` snap or identity-map within one frame. So there is no house "deltas are y-up" convention to appeal to, and nothing masks this.

### C. The frozen-ref SRT keeps the aspect conjugation the framework deliberately deleted

`:190-196` (IR `:449-453` GLSL **and** `:459-463` WGSL — an explicit override, so both halves must be edited):

```glsl
float rg_asp_ref = u_resolution.x / u_resolution.y;
coords.x *= rg_asp_ref;  ...rotate...  coords.x /= rg_asp_ref;
```

`rg_coords` is already isotropic — `:186` divides **both** axes by the same `(u_dpr * u_ref_size)`. Conjugating an isotropic frame by the live aspect turns the rotation into a shear-rotation. The framework's own SRT lowering forbids this in three places, verbatim: *"No aspect term — conjugating by the LIVE u_resolution aspect made the rendered angle drift as the canvas was resized"* (`glsl-generator.ts:559-562`, `ir/glsl-backend.ts:160-163`, `ir/wgsl-backend.ts:516-519`).

Measured coords-output rib angle at `srt_rotate = 45`: **45.00° at 800×800, 33.69° at 1200×800, 26.57° at 1600×800, 17.35° at 1920×600**, with rib spacing inflating 1.00/1.18/1.26/1.35×. At `srt_rotate = 60`: 60.00 / 49.11 / 40.89 / 28.43. The screen path (`:281-285` / `:578-582`) measures a stable 45.00° at every aspect — its conjugation is **required** there (v_uv genuinely is anisotropic) and must stay.

This is an unfinished fix, not a judgement call: commit `d87f2255` "fix: spatial rotation is resolution-invariant (aspect-free)" removed `srt_asp_*` from all four compiler files and its message names `reeded_glass` among the affected nodes — but the node declares no `spatial:` (only `getSpatialParams` at `:102`), so the gate at `glsl-generator.ts:539` never fires and the hand-rolled copy was never touched. `reeded_glass` is the one node in that commit's list that didn't get the fix.

Fix: delete `:190`, `:192`, `:194`, `:196` (keep the plain rotation at `:195`) plus **both** IR halves. Leaving `:190` in place fails lint as an unused variable. `srt_rotate` 0 and 180 are unchanged; 90/270 keep their angle but change rib *spacing*.

### D. The `coords` output does not describe the distortion `color` applies

Six independent divergences. Latent (nothing visible unless someone wires `coords`), but if anyone does, the two disagree by a measured **mean 12.9–15.0 CSS px / max 38–52 px in every configuration including the default**. Sanity check on the model: at ribWidth 64/128/256 with straight ribs and no SRT the delta is exactly 0.000, so this really is one field plus a fixed set of offsets.

1. **The wave term never cancels out of `coords`.** `:263`/`:265` (IR `:552-564`) emit `rg_lensed_ref` as an **absolute** coordinate, and it was computed from `rg_wm = main + waveVal` (`:242`). The color path takes a **difference** (`:337`), in which `waveValScr` cancels exactly. Measured max displacement at ribWidth 80 / ior 1.5 / curvature 0.8, sweeping amplitude 0→20→80→200: **coords 26.7 → 45.6 → 105.7 → 225.6 px; color 26.7 px throughout.** Color is amplitude-invariant by construction (the wave is meant to make rib *boundaries* wavy via `mod()`, not to shear the image); coords is linear in amplitude. At amplitude 200 that is an 8.4× magnitude error — larger than items 2–6 combined. Color is the correct side.
2. **Main-axis phase origin.** `coords += u_anchor` at `:198` so `main ≈ 0.5` at the anchor, while `mainScr = 0` there (`:276`). Both feed `mod()` inside `reedLens`, so the rib grids are out of phase by `u_anchor.main × 512` CSS px → misalignment `mod(512·anchor, ribWidth)`: **16 px at the default ribWidth 80**, 56 px at 100, 143 px at 400, exactly 0 at 16/32/64/128/256 and exactly 0 at a top/left anchor. Present at defaults, straight ribs, zero SRT — that is the entire 14.15 px mean in the simplest case.
3. **Opposite y handedness.** `coords` is y-DOWN (`:186` flips `gl_FragCoord.y`; IR `:442` uses `in.position.xy` raw); the screen path is y-UP (`:276` from `v_uv`). Same rotation matrix in opposite-handed frames → the two rib fields rotate opposite ways (measured ∓10.13° at `srt_rotate = 15`, the magnitude reduced from 15° by item C), `srt_translateY` slides them opposite ways, and every asymmetric shape (sawtooth, chevron, u_shape, noise) mirrors between the outputs. `:186` is byte-identical to the compiler's canonical `auto_uv` (`glsl-generator.ts:322`, `ir-compiler.ts:359`) and 10 of 12 `coords` ports in `src/nodes/` default to `auto_uv`, so **coords is the canonical side here** and the screen path is the deviant one — the opposite of item 1.
4. **`srt_translate` normalisation differs by a factor of `u_dpr`.** `:197` divides by `(u_dpr · u_ref_size)` (the framework convention, `ir/glsl-backend.ts:174`); `:287` multiplies by `u_dpr / u_resolution`. Residual 20 px at dpr 2 with `translateX 40`, 26.7 px at dpr 3.
5. **Circular.** Ref centres on a hardcoded `length(rg_coords - 0.5)` (`:234`/`:501`); screen centres on the anchor **and bypasses SRT entirely** — `:324`/`:619` read raw `v_uv`, while all five wave shapes and noise read the post-SRT `rg_srt_scr`. So `srt_scale`/`srt_translate` move the rib grid but leave the ring field pinned (measured mean 13.8 px / max 49.1 px at scale 2). Circular is the only rib type with this. Rotation is exempt (radial fields are rotation-invariant).
6. **Chevron is a different function, not a different space.** Ref `abs(perp*2 - 1)` (`:229`/`:496`) = |CSS px from anchor| / **256**, wavelength-independent. Screen `abs(perpScr*resPerp/wlPx)` (`:319`/`:614`) = |CSS px| / **wavelength**, and it is algebraically the *same expression as the sine's own phase argument* — the signature of a copy of the wrong subexpression. They disagree by `256/wavelength` at **every** setting: 5.12× at wl 10, **1.28× at the default wl 200**, 1.0× only at wl 256, 0.256× at wl 1000. Consequence in the *visible* path: chevron alone couples amplitude to wavelength — dragging Wavelength changes the chevron's bend rate, unlike every other shape. (It is *not* a resize instability: `perpScr·resPerp` is the device-px offset, so `u_resolution` cancels — measured identical at 1200/1600/2400 CSS wide and at dpr 0.75/1/2.)

**Do not fix these one at a time by patching the ref path.** They are one root cause — the pattern is computed twice — and several of the individual patches conflict (fixing 5's centre without fixing 5's SRT bypass trades one divergence for a scale-dependent one). The clean version: delete the ref-space duplicate of the pattern (`:204-243` + `:247-258`, IR `:471-548`) and derive `coords` from the screen displacement that already exists, converting units by `u_resolution.<main> / (u_dpr * u_ref_size)`. One edit per backend instead of ten, `color` stays byte-identical, and it also unifies the non-texture branch (`:365-367`), which today has no screen field at all. Blocked on divergence B for the horizontal case: "agree with color" is undefined while the two backends disagree on the sign.

### E. Frost averages gamma-encoded, straight-alpha texels

Both are real; both are latent; `blur.ts` is the in-repo precedent for both.

**Straight alpha (BUG).** `:359` accumulates the whole `vec4` including `.a` and `:361` divides by 8.0 (IR `:682`/`:684`). Intermediates hold **straight** alpha: a boundary pass emits `fragColor = <var>` unchanged for a color port (`glsl-generator.ts:951-953`, called at `ir-compiler.ts:667`), no blend state is set anywhere in `webgpu/renderer.ts`, targets clear to `a: 0` (`renderer.ts:871-873`), and image uploads are un-premultiplied on both backends (`webgpu/renderer.ts:797-800`, `webgl/renderer.ts:423-424`). `fragment-output.ts:123-125` then premultiplies again, so with footprint fraction `f` transparent the source contributes `(1−f)²C` where correct filtering gives `(1−f)C`. Concrete repro: Image (fit = contain) → Reeded Glass, frost = 1 — `image.ts:92` writes a literal `vec4(0.0)` outside the image rect, so the hard transparent-black boundary picks up a ~24 px dark fringe at 1200 px wide. Exactly the defect `blur.ts:19-21` was built to avoid.

Note the comments at `:350` and `:670` are **not** miscited — `rgba-node-audit.md:69` explicitly covers "both the frost-blur accumulation loop and the plain sample path". That doc settled a narrower question (don't *drop* alpha, which the node honours) and never mentions premultiplication. Leave them; at most append a clause.

**Gamma (correctness, against a standard that landed on this branch).** Nothing linearizes; intermediates are plain `rgba8unorm` (`webgpu/renderer.ts:471`) and the final target is never a `-srgb` variant (`:147`), so there is no hardware decode. Magnitude is variance-dependent, so state it carefully: a black/white footprint lands at 127.5 codes where linear-light gives 187.5 — **60 codes** — but 8 uniformly-distributed taps over a full-range footprint is ~26 codes, over a 60-code midtone span ~1.0 code. `blur.ts:66-68` records the same asymmetry ("~11 codes too dark on high-frequency content, while smooth content hid it"). In *this* node the high-variance case is exactly the bright caustic seams the lens creates, which is where it's most visible. "The frost slider reads as a brightness slider" would be overstating it; and drop "desaturates" — gamma averaging gives a dark/muddy midpoint, not lower saturation.

Two packaging traps if you port blur's accumulator:

- The function is `sombra_blur_toSrgb`, not `toGamma` (`blur.ts:79` GLSL, `:102` IR).
- `GLSL_HELPERS` (`blur.ts:76`) and `IR_HELPERS` (`blur.ts:88`) are **module-private** — only `blurNode` is exported. And the GLSL side is one three-function blob under a single registry key `sombra_blur_helpers` (`blur.ts:301`), registered unconditionally. If reeded-glass registers a *subset* under that key and emits after blur in topological order, it clobbers `sombra_blur_dither` and `blur.ts:227` fails to compile. Register the identical full blob, or hoist both to a shared module. On the IR side dedup is per-function by key (`wgsl-assembler.ts:239-244`), so push only the two you need.
- Ship the alpha fix and the gamma fix **separately**: alpha-only is an exact algebraic no-op when every tap has `a = 1` (so no saved graph without transparency shifts by one code), whereas linearizing changes every frosted graph.
- Residual the fix can't remove: the node declares no `textureFilter`, so the sampler is LINEAR and every jittered tap is a hardware bilinear blend performed in sRGB storage space. Small (~1 texel), same ceiling `blur.ts:70-74` documents.

Dither is **not** needed here — on smooth content (where 8-bit banding shows) the 8 taps land on near-equal texels, and whatever grain frost does produce acts as its own dither. Residual banding is inherited from the upstream pass's 8-bit write, which this node can't fix.

### F. Why A and B shipped: the offline gates can't see them

- `scripts/validate-wgsl-multipass.ts` is a **regex scan**, not a compiler — `WGSL_ISSUES` is 8 patterns (`:42-49`) applied per line (`:61-75`), with no `requestAdapter`/`createShaderModule` anywhere. Its only two reeded-glass entries (`:204-205`) pin `frost` to a literal (`0.0` and `0.5`) and leave `ribType: 'straight'`. A uniformity violation is syntactically clean WGSL; a y-convention sign flip is textually identical on both backends. Neither is reachable by construction.
- `scripts/self-validate/index.ts` **does** GPU-compile offline (`:405-462`: playwright-core → `requestAdapter` `:448` → `createShaderModule` `:452` → `getCompilationInfo`), and it does reach `direction: 'horizontal'`. It misses A for one reason: its wired case loops `def.inputs` (`:239`), and `frost` is a connectable **param**, not an input port — so the branch condition is always a uniform-buffer read. One loop over `def.params.filter(p => p.connectable)` turns it red.
- Second gap in the same file: `enumVariants` (`:112-131`) sees 144 combinations > cap 24 and falls back to one-at-a-time, which pairs `waveShape = triangle|square|sawtooth|chevron|u_shape` and `noiseType = value|worley` with the **default** `ribType: 'straight'` — so those bodies are never generated. Only `wave+sine` and `noise+simplex` are ever compiled.
- Nothing anywhere compares the two backends' *semantics*. A canonicalised line-set diff is viable as a cheap guard — I ran one across all 22 `direction × ribType/waveShape/noiseType` combinations and the residual set is stable at exactly three classes (the intentional `rg_coords` y-flip, the `rg_sampleBase`/`rg_sampleUV` pair, and the framework's `fragColor` → `return`), so the allowlist is tiny. But it cannot police `reedHash`: the rules needed to drive its three copies to zero residual are precisely the ones that normalise away the WGSL override's distinguishing content (`bitcast<u32>`↔`floatBitsToUint`, `vec2<u32>`↔`uvec2`, the vector shift RHS). For the duplicated bodies, compare **behaviour** — evaluate both over a fixed input set and assert bit-identical — not text.
- `CLAUDE.md:104`'s "167/167 WGSL GPU compilation tests" is the in-browser bridge's `validateAllWGSL`, not an offline suite (already noted at `docs/audit/2026-07-12-post-webgpu-audit.md:228`).

### G. Node thumbnails — EXPECTED, no fix

`:254` measures ribWidth in CSS px, and previews force `u_resolution = u_viewport = 80`, `u_dpr = 1` (`webgpu/preview-renderer.ts:17`, `:462-465`). At the default ribWidth 80 exactly **one rib period** spans the thumbnail — so what you see is a single hard rib seam down the centre with magnification toward both edges, not "no ribbing". House convention (`pixelate.ts:54-58` quantises in device px identically); a thumbnail is a small canvas, not a scaled-down view. Frost is 1.6 texels there, so it can't be judged from the preview — and because the preview target is square, S3's anisotropy is invisible in previews by construction.

Consequence to accept deliberately: the S3 radius fix takes preview frost from ±1.6 to ±24 of 80 texels, so `frost = 1` thumbnails go from near-sharp to mush. Physically consistent with the main canvas at dpr 1, but a real visible change. Do **not** "fix" it by reporting the canvas size as `u_resolution` in previews — `:186`/`:442` centre the frozen-ref coords by subtracting `u_resolution * u_anchor`, so an 80 px target told it is 1200 px renders a far-off-centre region, and `:192`/`:281` would apply the canvas aspect to a square target.

### H. Textual GLSL↔IR parity is clean today

Worth recording so it isn't re-derived: `reedLens`'s two copies are identical text; the hand-written `reedHash` WGSL override (`:421-426`) is bit-faithful to its GLSL twin (same multipliers, same shift, `0xFFFFFFFFu` is a valid u32 literal); the loop bound is the literal 8 in both; `curvature > 1.0 ? curvature : 1.0` translates correctly to `select(1.0, curvature, curvature > 1.0)` (right operand order — `wgsl-backend.ts:118-121`); `mod` → `sombra_mod` with the helper emitted and exact GLSL semantics including negative inputs (`wgsl-assembler.ts:320-324`); both `rg_frad` constants are `0.02`; both thresholds `0.001`; the `frost = 0` else branch is one identical `texture()` call. **The two real divergences (A, B) are semantic, not textual** — which is exactly why a text diff or the regex validator would never surface them.

---

## Prioritised fixes

### P0 — Frost uniformity (finding A)

Give the frost `raw()` at `:676-687` a second WGSL argument using `textureSampleLevel(<s>_tex, <s>_samp, uv, 0.0)`. **Blast radius: none.** With `frost` on a slider the condition stays uniform and LOD 0 is the only level that exists, so output is bit-identical. Graphs that wire `frost` go from "whole canvas silently frozen" to working. Gate with `validate-wgsl-multipass.ts` plus `window.__sombra.validateAllSubgraphWGSL()` since this is hand-written WGSL.

### P1 — S3 frost radius → per-axis px (`:356` and `:679`)

```glsl
vec2 rg_frad_<id> = vec2(<frostVar> * 24.0 * u_dpr) / u_viewport;
```

Leave `:358`/`:681` byte-identical — `vec2 * vec2` is componentwise in both languages. No new uniforms (`:182`, `:341`, `:700` already have them). GLSL-only edit in the IR raw: `mechanicalGlslToWgsl` rewrites `vec2 x =` → `var x: vec2f =` (`wgsl-backend.ts:80-82`) and `vec2(` → `vec2f(` (`:109`), and the assembler prefixes bare `u_dpr`/`u_viewport` (`wgsl-assembler.ts:160-171`) — the same path `:476`'s bare `u_ref_size` already relies on. **Do not** hand-write a WGSL override here.

**Blast radius:** every graph with `frost > 0` changes. Grain becomes isotropic and stops changing on resize; at 1200×800 the short axis coarsens 16 → 24 CSS px (~1.5×), so frost reads slightly stronger vertically. `K = 24` matches today's long-axis reach at 1200 px wide; 16–20 is the gentler landing. Node thumbnails change materially (see G). `frost = 0` byte-identical.

### P2 — S2 seed → quantised ref-space lattice (`:358` and `:681`) — ship with P1

Insert before the loop, then reseed:

```glsl
vec2 rg_gc_<id> = floor(rg_coords_<id> * (u_ref_size * 0.25));   // 4-CSS-px lattice
...
reedHash(rg_gc_<id> + vec2(float(rg_i_<id>) * 7.31, float(rg_i_<id>) * -11.13))
```

Note `float(rg_i_<id>)` — the loop variable is `int rg_i_<id>` (`:357`/`:680`). Drop the `* 0.1`. `u_ref_size` is already registered (`:246`, `:700`); `rg_coords_<id>` is in scope. Both backends agree on the lattice: GLSL flips y at `:440`, WGSL uses the already-top-down `in.position.xy` at `:442`, and `H−(k+0.5) == (H−1−k)+0.5`.

**Blast radius:** one-time different (statistically identical) grain field for every graph with `frost > 0`, and the grain coarsens from ~1 device px to the lattice pitch — at 4 CSS px on a 2× display, 8×8 device-px blocks share one 8-tap set. Every stable grain must be lattice-locked, so this is the price, not a bug. In exchange it stops re-randomising on resize, on the DPR tier flip, and on every lens-parameter drag or animation. `frost = 0` byte-identical.

### P3 — S1 clamp → mirror fold (`:82` **and** `:402`)

```glsl
  float lensed = local + disp;
  lensed = 1.0 - abs(fract(lensed * 0.5) * 2.0 - 1.0);
  return (floor(coord / ribW) + lensed) * ribW;
```

Exactly the identity on `[0,1]` (max |fold(l) − l| = 5.6e-17 in f64), stays inside the rib so the `floor` containment holds, continuous, and preserves |derivative| so it adds no new flat regions. Keep it as three lines — the declaration rewrite is anchored at line start, so it only rewrites the first declaration on a line. No `wgsl` override needed: `mechanicalGlslToWgsl` turns `float lensed = ...` into `var lensed: f32 = ...` (`wgsl-backend.ts:79-82`), which makes the reassignment legal, and `fract`/`abs` exist unchanged. (`1.0 - abs(mod(lensed, 2.0) - 1.0)` also works — `mod` → `sombra_mod` — and I confirmed `validate-wgsl-multipass.ts` stays 159/159 green with it applied.)

**Blast radius:** visually identical for every graph not already clamping — which includes all defaults. (Not *bit*-identical in f32: 33% of a 200k sweep differs, worst case 2.4e-6 px at ribWidth 80, orders below the 8-bit intermediate quantisation.) Graphs that *are* clamping — any curvature ≥ ~0.97 at default IOR, or IOR > 2.5 at curvature 0.8, or any curvature > 1 — change materially: max |Δ| 23.6 px at ior 3/curv 0.8, 13.5 px at ior 1.5/curv 1.0, **53.6 px at ior 1.5/curv 2.0**. The flat band becomes a mirrored sliver. Real reeded glass does not mirror, so this is BUG-fix-plus-tuning, not a free win. At curvature 2.0 it removes 90 of 254 flat px but leaves the longest run at 11 px, because at high curvature the derivative at the rib *centre* is ~0.01 — a genuine near-stationary caustic the fold can't touch.

*If you also want to tame the curvature response* (optional, separate decision): `min(c, 0.92)` at `:73` and `:397` gives slope 2.347 and pushes the curvature-1.0 threshold to ior 1.85 — **byte-identical for curvature ≤ 0.92, which covers the default**. It still leaves curvature 2.0 at threshold 1.426, so clearing S1 across the whole slider also needs an `amp` cap. Two rejected alternatives: normalising `slope` by its own maximum breaks the documented "0 = flat" contract (`c` is floored at 0.01, so curvature 0 would give full-strength refraction); `amp = min(curvature, 1.3)` moves the threshold only 1.142 → 1.219. Also `clamp(curvature, 0.0, 1.0)` at `:71`/`:395` is free (identical for all c ≥ 0.01) and makes curvature 0 a true passthrough — the only reachable value it changes is exactly 0.

### P4 — `direction: horizontal` WGSL sign (IR `:661-667` only)

Two-string `raw()` with the y component negated in the WGSL half. `glsl()` `:346` untouched. **Blast radius:** WebGL2 byte-identical. `direction: vertical` (the default) byte-identical on both. WebGPU + horizontal changes — from a sign-inverted, seam-crossing lens to the contained convex profile WebGL2 already renders, plus the top/bottom clamp band disappears. Users who tuned IOR against the inverted look will see a different image. Do **not** rebase `srtScr` (measured regressions above).

### P5 — S3 border taps: mirror into range (`:359` and `:682`)

```glsl
rg_tap = abs(rg_tap); rg_tap = 1.0 - abs(1.0 - rg_tap);
```

Two ops, no branch, no counter, no `/ 8.0` change, `abs` needs no translation rule. Note the excursion can exceed `[-1, 2]` when the target is narrower than `ribWidth` CSS px (i.e. 80×80 thumbnails) — use `1.0 - abs(fract(t * 0.5) * 2.0 - 1.0)` for the unbounded-safe form at the same instruction count. Apply to the *jittered* coordinate, not just the base — the base mirror alone leaves the taps clamping. **Blast radius:** nothing changes unless `frost > 0.001`, and then only within one radius of the border (24×16 px at 1200×800, frost 1). Interior bit-identical. Land P1 first — it collapses the band to the same width on all four edges and removes the resize growth, which is the larger share of S3.

### P6 — S4 delta transform: rotate + scale (needs your sign-off; do after P4)

One place that maps a pattern-space delta back to screen space: `d.x *= rg_asp_scr; d = R(−rad)·d; d.x /= rg_asp_scr; d *= srt_scale`, then `sampleUV = base + d`. `rg_asp_scr`/`rg_rad_scr` are already in scope (`:281-282`, IR `:578-579`). Fold `cos(-rad)/sin(-rad)` to `cos(rad)/-sin(rad)`. **Must be `raw(glsl, wgsl)`** with the delta's y negated on the WGSL side, or it re-creates divergence B for every rotated graph. **Blast radius:** `srt_rotate = 0` and `srt_scale = 1` (the defaults) byte-identical. Scaled graphs get proportional refraction; rotated graphs change substantially and should be eyeballed on both backends.

The wave/circular/noise normal (S4 BUG 1) belongs behind the same transform so there's one delta-mapping site. It is a larger feature change — `disp * vec2(1.0, dw) / (1.0 + dw*dw)`, `dw` from a two-tap finite difference in pixel space, gated off for the discontinuous shapes — and it changes every wave/circular/noise graph. Worth confirming with the user first; the zero-risk alternative is the `:90` doc line.

### P7 — Frozen-ref aspect conjugation (finding C)

Delete `:190`, `:192`, `:194`, `:196` and both IR halves (`:449`/`:451`/`:453` **and** `:459`/`:461`/`:463`). Keep the screen path. **Blast radius:** `color` output untouched. Only graphs that wire `coords` **and** have `srt_rotate ∉ {0, 180}` **and** a non-square canvas change — the rib angle snaps to the requested angle and stops drifting on resize. Note this does not make coords and color agree on rotation *direction* (item D3) — that's a separate decision.

### P8 — `coords` / `color` unification (finding D)

Needs a decision before code: `color` is authoritative for the wave-cancellation (D1), `coords` is authoritative for y handedness (D3, it's canonical `auto_uv`). The clean version deletes the ref-space pattern duplicate and derives `coords` from the screen `disp`, keeping `color` byte-identical — which resolves D1–D6 by construction. Blocked on P4. **Blast radius:** `color` unchanged; graphs wiring `coords` change, largest at high amplitude (up to 200 px of spurious shear removed), then rib phase (16 px at defaults).

### P9 — Frost premultiplied alpha (finding E), then linear light separately

Alpha first: `rg_acc += t.rgb * t.a; rg_aacc += t.a;` then `vec4(rg_acc / max(rg_aacc, 1e-5), rg_aacc / 8.0)`. Requires introducing a per-tap temp (there is no `rg_s` today — the fetch is inlined into the `+=`), so three edits × two paths. **Blast radius: none for any fully opaque source** — with every `a = 1` it reduces algebraically to today's `sum(rgb)/8, a = 1`. Transparent sources lose the fringe. Gamma is a second change, gated on exporting/hoisting blur's helpers, and it *does* shift every frosted graph (brighter at high-contrast detail and at the caustic seams, ~1 code on flat content).

### P10 — Tap distribution → stratified disc (optional look change)

One hash for a per-pixel rotation instead of eight seeds; tap `i` at `rot + i·π/4`, radius `sqrt((i+0.5)/8)`, in the px space P1 establishes. Measured 57.9 → 9.5 codes of speckle, 0% wasted taps, 0.0% directional deviation. Keep the loop bound as the literal 8 so the `for (int ...)` rewrite still applies. **Blast radius:** every `frost > 0` graph looks markedly smoother, rounder and lower-contrast. This supersedes the cheaper seed-decorrelation one-liner (which only reaches iid parity, 57.9 → 45.4), so don't ship both.

### P11 — Test coverage (finding F)

(a) Wire connectable params in `self-validate/index.ts:239-247` — one loop, turns the gate red on P0, adds exactly one failure repo-wide. (b) Pair `waveShape`/`noiseType` with their parent `ribType` so those bodies are generated at all. (c) Behavioural equality check across `reedLens`'s 2 copies and `reedHash`'s 3. Test-only.

### P12 — Docs (zero visual effect)

- `:3` "Snell's law refraction" and `:51-52` — it is a linearised thin-prism deviation valid only for small surface slopes. That misdescription is exactly what makes the `:82` clamp look like a safety net rather than the artifact source. (`:53-54` are accurate — the map derivative at the rib centre is 0.6 at defaults, a genuine 1.67× magnification, and the seam caustic is real.)
- `:61` — curvature 1 is not a semicircle (slope 7.018, capped at `:73`), and curvature 0 is not flat until `:71`'s floor is lowered.
- `:55` "at high IOR × curvature, image inversion" — inversion is present near the rib edges at **every** setting including the defaults.
- `:90` description — "refracts perpendicular to the ribs; lines parallel to the ribs stay straight" (add only after P6, or phrase it as "parallel to the screen axis selected by Direction", which is what the node does today).
- `:75`/`:399` — leave the dead `max(1.0 - x2, 0.001)` guard but comment that the 0.99 cap, not the guard, is the limiter; it becomes live again if anyone raises the cap or wires a negative `ribWidth`.
---

## What shipped (2026-07-28)

Landed in one change, all four reported symptoms plus the divergences found alongside.
Appearance changes were authorised, so nothing here was gated behind a compatibility flag.

**The S4 verdict was revised after review.** The report called horizontals-don't-bend EXPECTED
for straight vertical ribs, on the grounds that a cylindrical lens has zero optical power along
its axis. That reasoning is correct and it is still why cross-rib refraction alone cannot do it —
the refraction term (ηc₁−c₂)·n vanishes in y for a normal n = (nx, 0, nz), so no amount of Snell's
law fixes it. But it answered the wrong question. Cross-rib refraction is not the only way a rib
moves a ray: crossing a slab of *varying thickness* off-axis displaces laterally by
path-length × tanθ × (1 − 1/n), and a rib's path length is its own height profile — a function of
the cross-rib coordinate. That scallops parallel lines: bowed at rib centres, pinned at seams.

The node used the profile's *slope* and never its *height*. The height was two instructions away
from values already in scope.

| Fix | Site | Effect |
|---|---|---|
| **Bow** — new signed param, default 1 | `reedLens` returns `vec2(coord, sagitta)` | Horizontals bend with straight vertical ribs. Scales off ribWidth, curvature and (ior−1) — no new tuning surface. Peak ≈10 px per rib at node defaults |
| **S1** clamp → mirror fold | `REED_LENS_BODY` (now one shared constant) | Kills the frozen-coordinate band. Identity on [0,1], so only bands that were already clamping move |
| **S2** seed → quantised ref lattice | frost block, both paths | Grain stops re-randomising on resize, DPR flip and every param drag |
| **S3a** frost radius → px | frost block | Isotropic footprint; no more aspect-shaped reach |
| **S3b** border taps → mirror fold | frost block | No clamp band at the edges |
| **S4 BUG 1** rib gradient | `emitScreenDelta` | Wave/circular/noise refract along ∇φ. `disp·∇φ/|∇φ|²` collapses to `(disp, 0)` at ∇w = 0, so straight ribs are unchanged by construction |
| **S4 BUG 2** `srt_rotate` | `emitScreenDelta` | Offset mapped back through R(−θ); was a venetian shear at 90° |
| **S4 BUG 3** `srt_scale` | `emitScreenDelta` | Delta co-scales with every other pattern length |
| **Divergence B** horizontal y sign | two-argument `raw()` on `sampleUV` | Was WebGPU-only lens inversion. Latent while the delta was x-only; bow and the gradient expose it everywhere |
| **P9 (alpha half)** premultiplied frost | frost block | No fringe on transparent sources. Algebraically identical for opaque ones |
| Circular ribs read the SRT'd point | `screenWave` | Screen path used raw `v_uv`, so SRT moved the frozen-ref rings and not the rendered ones |

Two structural changes keep this from drifting: `REED_LENS_BODY` is one string shared by the GLSL
and IR copies (it was duplicated, and the report found `reedLens` in 2 copies and `reedHash` in 3),
and `screenWave` / `emitScreenDelta` are shared emitters, so the four rib types and the two backends
cannot each grow their own version. `screenWave` is templated on a *point* rather than emitting one
fixed expression specifically so the finite difference can evaluate w at p±ε without a third copy.

`square` and `sawtooth` keep cross-rib-only refraction: a central difference across a jump measures
the jump, not the slope. For `square` that is also the correct answer (piecewise constant → true
gradient is zero a.e.); for `sawtooth` it is the status quo.

**Verified:** IR parity 85/85 (the RGBA assertion was rewritten for the premultiplied form and
negative-controlled — reverting the alpha weighting makes it fail), WGSL multipass 159/159,
self-validate 0 FAIL / 0 WARN across 412 GPU-compiled shaders, wired-branch 51/51, lint + tsc clean.
Visually confirmed in-app on WebGPU: horizontals straight at bow 0 → scalloped at bow 1, and at
`srt_rotate: 45` the displacement now runs perpendicular to the ribs instead of staying horizontal.

**Still open** (each needs a decision, none is a correctness bug):

- **P7 / P8** — the `coords` output still disagrees with `color` on rotation handedness and carries a
  spurious shear. Needs a call on which output is authoritative before code.
- **P10** — stratified disc frost taps (57.9 → 9.5 codes of speckle). Pure look change.
- **P9 gamma half** — frost still averages gamma-encoded texels. Gated on hoisting blur's helpers.
- **P11b/c** — pair `waveShape`/`noiseType` with their parent `ribType` in self-validate so those
  bodies are generated at all. (P11a is superseded by `npm run verify:wired-branch`.)
