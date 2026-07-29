# Frost: WebGPU/WebGL2 divergence — root cause and decision

**Date:** 2026-07-29 · **Status:** ACCEPTED, not fixed · **Node:** `src/nodes/transform/reeded-glass.ts`

Reeded Glass with `frost > 0` renders differently on WebGPU and WebGL2. Root cause is
**hardware bilinear filtering**, which is fixed-function and outside the shader. The
decision is to accept and document rather than pay 4× the fetches for cosmetic parity.

---

## The number

Cross-backend max |Δ| on `frost0p3` (ribWidth 73, srt_rotate 15, frost 0.3, photo):

| kernel | max codes | px > 1 code |
|---|---:|---:|
| pre-rewrite (8 white-noise taps) | 179 | 737,800 (77%) |
| post-rewrite (16 stratified taps) | 27 | 302,525 (31%) |
| post-linear-light | 56 | 339,121 (35%) |

The frost rewrite cut it 6.6×. Linear light then roughly doubled it again — not a new
defect, but because the sRGB encode is steep near black and amplifies an existing
difference. `frost0p3` is the **only** config of 26 that diverges; every other reads
max 1 with zero pixels above. The rewrite incidentally fixed three smaller ones
(`wave-sine` 88 → 1, `stair-rot23` 9 → 1, `stair-wave` 8 → 1).

## How it was found

Two false conclusions on the way, both recorded because the reasoning was wrong in an
instructive way.

**Bisect by gather radius** (`phase12 --stage=frostgap`). Parity scales monotonically
with the tap radius: 1 code at radius 0, 3 at 0.24 px, 14 at 0.96 px, 31 at 1.9 px, 51
at 7.2 px. That looked like a lever arm — an angular error times a radius — so the
conclusion was "tap positions".

**Wrong.** `phase15-hash-parity.ts` isolated placement with no node, no lens and no
texture: `reedPcg` is identical on positive AND negative input, and the golden-angle
`cos/sin` differs by 1/255 on 3 of 65,536 pixels. A 1-ULP angular difference moves a
tap by `Δcos · r / viewport` ≈ 7e-7 px at radius 7.2 — six orders short of 51 codes.

**Second guess: the mirror fold**, where a 1-ULP difference at a `fract` boundary
sends a tap to the far side of the texture, and whose hit rate grows with radius.
Also wrong: the fold can only fire within (radius + max lens delta) of the frame
border, and **90–100% of differing pixels are interior**. At frost 0.3 the border band
is 13.3% of the frame but carries only 9.2% of the diffs — under-represented.

**Third guess: FMA contraction** in `acc = acc + toLin(rgb) * a`, ANGLE and Tint
lowering to different native ISA. Wrong too: three texture-free 16-tap sums — near-equal
summands, summands spanning 0..1, and one through linear light — are all sub-1/255,
high byte identical.

## Elimination table

Every component testable in a shader is backend-stable:

| component | result |
|---|---|
| `reedPcg`, positive input | identical |
| `reedPcg`, negative input | identical |
| golden-angle `cos`/`sin` | 1/255 on 3 of 65,536 px |
| `pow(x, 2.4)` / `pow(x, 1/2.4)` | identical |
| 16-tap sum, low variance | sub-1/255 |
| 16-tap sum, high variance | sub-1/255 |
| 16-tap sum through linear light | sub-1/255 |
| mirror fold | ruled out spatially (diffs are interior) |
| filter mode | both renderers default pass textures to LINEAR |
| **one bilinear fetch, sub-texel offset** | **DIFFERS — 109/255 on 100% of pixels** |
| same gather on a FLAT field (control) | identical |

A single `sampleSrc(uv + vec2(0.37, 0.21)/res)` on a 1px checkerboard differs by up to
109 codes on every pixel. No loop, no hash, no summation. The flat-field control is
identical, so the probe is sound: it is the interpolation, not the plumbing.

This also explains the radius scaling that misled the bisect. Bilinear error is
`weight-error × local gradient`, so it vanishes on flat content and grows as taps reach
further into varied content — the same monotonic curve an angular lever arm would
produce, from a completely different mechanism.

## Why it is not fixed

The interpolation is fixed-function silicon reached through two different drivers
(ANGLE for WebGL2, Tint for WebGPU). Nothing in the shader can make them agree.

| option | cost | verdict |
|---|---|---|
| **Accept** | none | **chosen** |
| Sample `nearest`, interpolate in-shader | 4× fetches — 64 per fragment at 16 taps | exact and backend-identical, but steep for cosmetic parity |
| Declare `textureFilter: 'nearest'` on the node | none | rejected: the lens depends on smooth resampling, so it wrecks the look for everyone |

Scale of the accepted difference: 51 codes needs a photograph AND frost 0.3 (a 7.2 px
gather). The 109-code probe figure is a 1px checkerboard, deliberately the worst
possible stimulus, and is not representative. WebGPU is the primary backend; WebGL2 is
the fallback, so most users never see both.

## Repro

```bash
npx tsx scripts/blur-bakeoff/phase15-hash-parity.ts              # the elimination table
npx tsx scripts/blur-bakeoff/phase12-shipped-aa.ts --stage=frostgap   # radius bisect + spatial split
npx tsx scripts/blur-bakeoff/phase12-shipped-aa.ts --stage=regress    # the 26-config parity column
```

Two harness notes, both of which produced confidently wrong readings first:

- The probe packs floats as hi/lo bytes; the LOW byte is `fract(v*255)`, which **wraps**.
  A 1-ULP difference at a 1/255 boundary flips it 254 → 0 and reads as full-scale. The
  first `rot-trig` run reported "DIFFERS max 255/255" for what is a 3-pixel wobble.
  `diff()` splits hi from lo for this reason.
- The rig aliases `vec2` to `vec2f`, so the node's `vec2<u32>` spelling becomes
  `vec2f<u32>` inside the harness. The probe uses `vec2u`/`vec2i`. Harness artifact
  only — the node's own WGSL has no such alias.

## If this is revisited

The manual-bilinear option is the only real fix. It would need `textureFilter: 'nearest'`
on the node plus a 4-tap `textureLoad`-style fetch and lerp per tap, and it should be
measured against the accepted baseline before shipping — 64 fetches per fragment is a
real cost on a node that already supersamples.
