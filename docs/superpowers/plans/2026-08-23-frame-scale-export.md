# Frame Scale + Export Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix the mangled export preview, split the overloaded `u_dpr` uniform into `u_frame_scale` (layout) + `u_dpr` (device density), and improve video-export fidelity (HEVC + universal H.264-High fallback).

**Architecture:** Today `u_dpr` does two jobs — spatial framing (auto_uv denominator) *and* feature-size density (dither/blur/reeded). They cancel for single-pass scene-locked content, which is why the PNG/export already match live. This plan (a) formally splits the two so framing and density are independent (unblocking the `framing.ts:58` TODO, Reveal-mode correctness, and future supersampled-AA exports), and (b) fixes the two user-visible defects: the preview blowout (a resolution/quantization problem) and video codec fidelity.

**Tech Stack:** Vite, React 19 + TS strict, WebGPU (WGSL) + WebGL2 (GLSL ES 3.0) dual codegen, mediabunny 1.53.1 (video), Zustand.

**Spec:** This conversation's investigation. Key measured facts:
- Export at 2048×1280 Fit renders mean-L **16.5** == live (dark). PNG faithful. ✓
- Preview at 480px renders mean-L **79** (blown out) because `uDpr = framing.uDpr × 480/2048 = 0.18` → dither cell `max(1.0, floor(3.7×0.18+0.5)) = 1px` → triangle-SDF coverage collapses.
- Rendering at export res then downscaling → mean-L **16.4** (correct). This is the ONLY preview fix; no uniform trick shows 1px-at-2048 detail in a 480px canvas.
- Video ≠ live + browser-variant = lossy H.264/VP9 4:2:0 shredding the fine dither. PNG (lossless) is faithful. All sinks share the same `VideoFrame`.

## Global Constraints

- **Both backends, always.** Every codegen change lands in `glsl-generator.ts`/GLSL nodes AND `ir-compiler.ts`/IR nodes + WGSL. Keep parity.
- **No hand-written `raw(glsl, wgsl)`** two-arg shader text (budget is 0). Use structured IR builders or single-emitter splits.
- **Verification is scripts**, not unit tests: `npx tsx scripts/verify-ir-poc.ts`, `scripts/validate-wgsl-multipass.ts`, `npm run verify:pass-resolution`, `npm run lint`, `tsc -b`.
- **Mechanism-engaged gates.** Every gate must assert the code path ran and be shown to FAIL when the mechanism is disabled (repo rule; memory: `gate-needs-mechanism-engaged-assertion`).
- `u_ref_size` = 512 constant (`src/renderer/constants.ts`).
- WGSL `u_*` names auto-map to `uniforms.u_*` (`wgsl-assembler.ts:154-165`), so a new `u_frame_scale` maps for free.

---

## Semantic contract (the split)

| Uniform | Meaning | Live value | Export value |
|---|---|---|---|
| `u_frame_scale` (NEW) | device-px per reference-unit for **layout/zoom**. Used by auto_uv + every scene-locked feature. | `min(dpr,2)×dprScale` (≈2) | framing scale (`computeFraming`, e.g. 0.78 Fit) |
| `u_dpr` (repurposed) | true device **sample density / supersample** factor. Used only where device-pixel sampling quality matters (blur texel oversampling, dither/pixelate rounding granularity). | same ≈2 | 1 for 1:1, N for N× supersample |

**Invariant (the gate):** a scene-locked feature's size in *reference units* is constant across live and all export framing modes/sizes. Currently satisfied by cancellation; the split must PRESERVE it. Phase 1 keeps `u_frame_scale == u_dpr` (pure rename, byte-identical output). Phase 2 sets them independently and proves the invariant still holds.

**CORRECTED after Task 1 (verified: algebra + numeric sim + cross-check, see `task-1-report.md` §2).** There are TWO node conventions, but BOTH use `u_dpr` purely as the **reference-pixel ↔ device-pixel conversion ratio**, so renaming ALL of them to `u_frame_scale` *consistently* preserves every cancellation:
- **Device-pixel-locked patterns** (`stripes`, `checkerboard`, `dots`): feature `÷ (u_dpr·ref)` cancels against `auto_uv`'s `÷ (u_dpr·ref)` → net period = `width+gap` device px, dpr-independent. Renaming coords+period together keeps them EXACTLY device-pixel-locked (unchanged). These are NOT "scene-locked" — my earlier label was wrong — but they migrate anyway to preserve the cancellation.
- **Scene-locked effects** (`dither` cell, `pixelate` cell, `reeded` geometry, `image` fit-UV): feature `× u_dpr` on raw `gl_FragCoord`, giving reference-space size `pixelSize/ref` (dpr-invariant). These already match live; renaming keeps them matching.

**Phase-1 rule (crisp):** rename EVERY `u_dpr` occurrence in `auto_uv` + all nodes below → `u_frame_scale`. Renderers set `u_frame_scale` = the exact value they currently set `u_dpr` to → behavior-identical on live (fs==dpr) AND export (fs takes the old u_dpr value). `u_dpr` is repurposed to a pure device-density knob with NO node consumers in Phase 1 (renderers still write it; Phase 2 wires consumers).

**Nodes to rename (→ `u_frame_scale`):** auto_uv (both `glsl-generator.ts:334` & `:581`, `ir-compiler.ts:388-391` & `:296`), checkerboard, dots, stripes, gradient, image fit-UV, pixelate UV + cell, dither cell, reeded-glass geometry (resMain/resPerp/toPx/amp/wl/ribWidth/bow), AND blur/kawase/pyramid sigma (`* u_dpr` is radius-ref→texel conversion = a frame-scale ratio; Phase 1 renames for behavior-preservation).

**Phase 2 (`u_dpr` = density) consumers:** blur/kawase/pyramid may reintroduce a *density* factor on `u_dpr` for supersample AA (reach stays on `u_frame_scale`); the `floor(...+0.5)` rounding granularity in dither/pixelate may use `u_dpr` for finer steps at supersample. Two-step by design.

---

## Phase 0 — Baseline + invariance harness

### Task 1: Clean baseline + scene-locked invariance gate

**Files:**
- Create: `scripts/verify-frame-scale-invariance.ts`

**Steps:**
- [ ] **Baseline:** run `npm run lint`, `npx tsx scripts/verify-ir-poc.ts`, `npx tsx scripts/validate-wgsl-multipass.ts`, `npm run verify:pass-resolution`. Record pass counts. If any fail at baseline, STOP and report.
- [ ] **Write the gate** `scripts/verify-frame-scale-invariance.ts`: headless GPU (or reuse the pass-resolution:gpu harness pattern) that compiles a fixture graph containing a scene-locked feature with a *measurable period* (e.g. `stripes` or `checkerboard`, NOT noise — deterministic), renders it at several (size, frameScale, dpr) configs, and asserts the feature's measured period in reference units is equal (±tolerance) across configs. Include: live-equiv (1754×3280, fs=2), Match (877×1640, fs=1), Fit (2048×1280, fs=0.78), Reveal (2048×1280, fs=1), and a 2× supersample (fs same, dpr=2). MECHANISM CHECK: also assert the feature is actually present (period detector returns non-zero amplitude) — a blank render must FAIL, not pass.
- [ ] **Prove it can fail:** temporarily perturb the fixture (e.g. multiply frameScale into the feature twice) and confirm the gate FAILS. Revert.
- [ ] **Run against current code** — it must PASS (current cancellation already invariant). Commit the gate.

```bash
git add scripts/verify-frame-scale-invariance.ts && git commit -m "test: add scene-locked frame-scale invariance gate"
```

---

## Phase 1 — `u_frame_scale` uniform, behavior-preserving rename

Throughout Phase 1, renderers set `u_frame_scale` to the SAME value they currently pass as `u_dpr`. Output must stay byte-identical. Run the Phase-0 gate + verify-ir-poc after each task.

### Task 2: Declare `u_frame_scale` in both codegen layouts

**Files:**
- Modify: `src/compiler/ir/wgsl-assembler.ts:91-92` (after the `u_dpr` field)
- Modify: `src/compiler/glsl-generator.ts:1038-1039` (after `u_dpr` decl)

- [ ] WGSL: add field, f32, matching `u_dpr`:
```ts
if (standardUniforms.has('u_frame_scale'))
  fields.push({ name: 'u_frame_scale', wgslType: 'f32', size: 4, align: 4 })
```
- [ ] GLSL:
```ts
if (uniforms.has('u_frame_scale')) {
  uniformDeclarations.push('uniform float u_frame_scale;')
}
```
- [ ] `tsc -b`, commit.

### Task 3: Write `u_frame_scale` in all renderers (== current dpr)

**Files:**
- Modify: `src/webgpu/renderer.ts:874-881` (single) & `:904-911` (multi) — add `set('u_frame_scale', dpr)` / `set('u_frame_scale', tdpr)`.
- Modify: `src/webgpu/preview-renderer.ts:490` — add `set('u_frame_scale', tdpr)`.
- Modify: `src/webgl/renderer.ts:981` region & the single/multi write paths — add `u_frame_scale` uniform1f = same dpr.
- Modify: `src/webgl/preview-renderer.ts:214` (=1.0) & `:387` (=tdpr) — add `u_frame_scale`.
- Modify: `src/export/export-renderer.ts:578-585` (`writeBuiltinUniforms`) — add `set1('u_frame_scale', passDpr)` for now (Phase 2 will decouple).
- Modify: `src/renderer/pass-size.ts` — if it returns per-pass dpr, ensure frame_scale mirrors it (Phase 1: identical).

- [ ] Add writes; every site sets `u_frame_scale` to the exact value it sets `u_dpr`.
- [ ] Run gate + verify-ir-poc (still byte-identical, nothing consumes u_frame_scale yet). Commit.

### Task 4: Migrate auto_uv to `u_frame_scale` (both backends)

**Files:**
- Modify: `src/compiler/glsl-generator.ts:334, 337, 580-581` — replace `u_dpr` with `u_frame_scale` in the auto_uv / own-uv formula and `uniforms.add`.
- Modify: `src/compiler/ir-compiler.ts:280-296, 388-397` — replace `variable('u_dpr')` with `variable('u_frame_scale')` in the auto_uv / SRT-translate denominators and `standardUniforms.add`.

- [ ] Change both. auto_uv becomes `… / (u_frame_scale * u_ref_size) …`.
- [ ] Run gate (PASS, since frame_scale==dpr) + verify-ir-poc + validate-wgsl-multipass. Commit.

### Task 5: Migrate scene-locked nodes to `u_frame_scale` (both backends)

**Files (each: swap `u_dpr`→`u_frame_scale` in the scene-placement math + the uniform-set, GLSL and IR):**
- `src/nodes/pattern/checkerboard.ts` (`:66, :102, :164`)
- `src/nodes/pattern/dots.ts` (`:47, :49, :83, :107, :138`)
- `src/nodes/pattern/stripes.ts` (`:48, :90, :137`)
- `src/nodes/pattern/gradient.ts` (grep `u_dpr`)
- `src/nodes/input/image.ts` (`:125-126, :203-204, :252`) — fit-UV
- `src/nodes/distort/pixelate.ts` (`:59, :65, :94, :122, :132`) — UV denom AND the `floor(pixelSize*…)` cell (Phase 1: both → frame_scale, look preserved)
- `src/nodes/postprocess/pixel-grid.ts` (`:162,:168,:199` GLSL; `:298-304,:378,:390-394` IR) — the `px` uses `u_resolution*u_anchor` (unchanged); the cell `floor(pixelSize*u_dpr+0.5)` → `u_frame_scale`; cell-centre resample uses `u_resolution*u_anchor` (unchanged)
- `src/nodes/transform/reeded-glass.ts` (`:399,:451,:546,:701,:765,:959,:968,:1001,:1003,:1005,:1060-1066,:1253,:1281-1285,:1334-1342,:1533`) — all geometry `u_dpr` → `u_frame_scale`
- `src/nodes/effect/blur.ts` (`:125,:248,:271`), `src/nodes/effect/kawase-blur.ts` (`:109,:197,:235`), `src/nodes/effect/pyramid-blur.ts` (`:223,:301,:333`) — sigma reach `* u_dpr` is a radius-ref→texel conversion → `u_frame_scale` (behavior-preserving; T8 later adds any density factor back on `u_dpr`)

NOTE (per Task 1 ruling): this is a CONSISTENT rename that preserves BOTH conventions — device-pixel-locked patterns (stripes/checkerboard/dots) stay device-locked because coords+period rename together; scene-locked effects stay scene-locked. No behavior change on live OR export (renderers set `u_frame_scale` to the same value they set `u_dpr`).

- [ ] Migrate one node at a time; after each, run verify-ir-poc + gate. Keep GLSL/IR parity per node.
- [ ] After all: run `validate-wgsl-multipass.ts` (167 tests) + `verify:pass-resolution` + `verify:raw-budget` (must stay 0) + `lint`. Commit per node or per small group.

### Task 6: Confirm Phase 1 is a true no-op

- [ ] Re-run the full suite. Load the lnv4 graph in the app (dev bridge) and compare export-render mean-L to the pre-Phase-1 baseline (≈16.5). Must be unchanged. Commit a checkpoint message: "Phase 1 complete: u_frame_scale rename, output unchanged".

---

## Phase 2 — Decouple density

### Task 7: `computeFraming` returns `{ frameScale, dpr, anchor }`

**Files:**
- Modify: `src/export/framing.ts` (`FramingChoice`, `computeFraming`)
- Modify: `src/export/export-engine.ts` (`ExportJob.framing`, the `renderFrame` call `:95-99`)
- Modify: `src/export/export-renderer.ts` (`ExportFrameUniforms`: add `frameScale`; `writeBuiltinUniforms` sets `u_frame_scale`=frameScale, `u_dpr`=dpr)
- Modify: `src/export/ExportModal.tsx` (`:487, :601, :615-616, :655`) — consume `frameScale` (guide overlay uses frameScale, not dpr)
- Modify: `src/export/use-export-preview.ts` (Phase 3 will rewrite; here just pass frameScale through)

- [ ] `FramingChoice = { frameScale: number; dpr: number; anchor: [number,number] }`.
  - Fit/Fill: `frameScale = min/max(scaleX, scaleY)` (as today's uDpr); `dpr = 1` (1:1 export; supersample hook later).
  - Reveal: `frameScale = 1`; `dpr = 1`.
  - (Live is unaffected — main renderer keeps frame_scale=dpr=deviceDpr.)
- [ ] `ExportFrameUniforms { timeSec; frameScale; uDpr; anchor }`; `writeBuiltinUniforms` sets both uniforms independently.
- [ ] **Add the deferred 5th config** to `scripts/verify-frame-scale-invariance.ts` `CONFIGS` array (per Task 1 ruling / report §8): 2× supersample = frameScale held fixed while `dpr=2` as a pure density axis. Now buildable because `ExportFrameUniforms` gained `frameScale`. Run gate across ALL configs — invariant must hold. Commit.

### Task 8: Wire genuine density consumers to `u_dpr`

**Files:**
- Modify: `src/nodes/effect/blur.ts:125`, `src/nodes/effect/kawase-blur.ts:109`, `src/nodes/effect/pyramid-blur.ts:223` — sigma reach stays scene-locked (`u_frame_scale`); the *texel oversampling* correction (the device-sampling part) uses `u_dpr`. Decide the exact factor with the gate: blur reach in ref units must stay constant across dpr, while higher dpr yields smoother (more-sampled) result, not larger reach.
- Optional: `pixel-grid.ts`/`pixelate.ts` rounding `floor(...+0.5)` granularity may use `u_dpr` for finer steps at supersample; default behavior at dpr=1 unchanged.

- [ ] Add a blur fixture to the invariance gate: reach constant across (fs, dpr); assert dpr=2 reduces high-freq error vs dpr=1 (mechanism engaged). Prove it can fail.
- [ ] Commit.

---

## Phase 3 — Preview fix (Bug A)

### Task 9: Preview renders at export resolution, downscales

**Files:**
- Modify: `src/export/use-export-preview.ts`

- [ ] Replace the `uDpr = s.framing.uDpr * (pw/exportW)` logic. Instead: render the export target at the ACTUAL export size (capped to a max backing dimension, e.g. `min(exportLongEdge, 1600)` for perf) using the REAL `frameScale` + `dpr`, read back, then `drawImage`-downscale into the display canvas (`PREVIEW_LONG_EDGE`). Throttle the rAF (e.g. ~20–30fps) since full-size readback is heavier.
- [ ] Keep the `onHasAlpha` scan on the full-res readback.
- [ ] Live-verify in browser: load lnv4, open export modal → preview mean-L ≈ export (dark ~16), not blown out. Screenshot for the user. Commit.

---

## Phase 4 — Video fidelity (HEVC + universal H.264-High)

### Task 10: HEVC sink + robust codec selection

**Files:**
- Modify: `src/export/sinks/webcodecs-mp4.ts` (or add `mp4-hevc.ts` + registry entry)
- Modify: `src/export/sinks/index.ts`, `src/export/registry.ts`
- Modify: `src/export/ExportModal.tsx` (format list / labels)
- Reference: mediabunny `getFirstEncodableVideoCodec`, `VideoSampleSource`, `Mp4OutputFormat`.

- [ ] Codec pick (per research): `const codec = await getFirstEncodableVideoCodec(['hevc','avc'], { width, height, bitrate })`. `null` → surface error. This auto-fixes the false-negative: AVC resolves to **High** (`avc1.6400XX`), never baseline `avc1.42001f`.
- [ ] `new VideoSampleSource({ codec, bitrate })` into `Mp4OutputFormat`. Raise default bitrate for High/Max quality (detail preservation; no 4:4:4 lever exists).
- [ ] **Even dimensions:** clamp export W/H to even (odd → mediabunny reports not-encodable and silently falls through). Do this in the engine/modal size resolution.
- [ ] `isSupported()` uses `getFirstEncodableVideoCodec` (not a hardcoded `avc1.42001f` probe).
- [ ] Label HEVC honestly (Apple-ecosystem/high-quality; `hev1` tag caveat for some editors). Keep AVC-High as the universal default MP4 option; HEVC as gated option (only shown when encodable).
- [ ] Add an honest hint in the modal for high-freq/dither shaders: "fine dither → prefer PNG sequence or a larger export".
- [ ] `verify:embed`/build sanity + live smoke (export a short clip in-browser, confirm plays). Commit.

---

## Phase 5 — Full verification + live check

### Task 11: Suite + live A/B

- [ ] Run: `lint`, `tsc -b`, `verify-ir-poc`, `validate-wgsl-multipass`, `verify:pass-resolution`, `verify:raw-budget` (==0), `verify-frame-scale-invariance`.
- [ ] Live: load lnv4, verify live canvas unchanged, export preview dark/correct, PNG unchanged, MP4 (AVC-High) closer to live than before, HEVC option present when encodable. Screenshots for the user.
- [ ] Update `framing.ts` comment (remove the parked-TODO note), `PHASE6`/`ROADMAP`/`BROWSER-AUTOMATION` if uniforms/sinks documented there, and `CLAUDE.md` uniform list (add `u_frame_scale`).
- [ ] Final commit; use finishing-a-development-branch to integrate.

## Self-review notes
- Type consistency: `FramingChoice.frameScale`/`.dpr` used identically in framing.ts, export-engine.ts, export-renderer.ts, ExportModal.tsx, use-export-preview.ts.
- Spec coverage: preview (Ph3), video (Ph4), split (Ph1-2), gate (Ph0) all mapped.
- Risk: Phase 1 is byte-identical (guarded); Phase 2/3 are where behavior changes — both gated by the invariance harness + live A/B.
