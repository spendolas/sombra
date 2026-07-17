# Gradient anchor + resize — solution candidates

**Problem.** A *positioned* gradient feature must satisfy two things at once:
1. **No jump on anchor switch** — changing the Fragment Output anchor must not move the gradient on screen.
2. **Resize respects anchoring** — on resize, the gradient pins per the anchor (fixed pixel size, revealed/hidden edges).

**Why it's hard.** For a positioned feature, "centre ignores the anchor" (req 1) and "centre tracks the anchor" (req 2) are directly opposed. They can only coexist if *something* stores a reference or actively compensates. Tiling nodes (checkerboard, reeded-glass ribs) sidestep it — they're periodic, so the anchor shift is invisible; a single gradient can't hide it.

**Shared primitive (from reeded glass, "beyond SRT").** The clean way to render fixed-pixel content pinned to the anchor is screen-space with *live* resolution:
```
centre_screen_px = anchor·u_resolution  +  p_px·u_dpr        // p_px = offset from anchor, CSS px
```
`anchor·u_resolution` tracks the anchor on resize; `p_px·u_dpr` is a fixed pixel offset. This replaces the Pinned mode's frozen-`u_ref_size` `grad_center` trickery and is what makes reeded glass "align properly." All four candidates below use this for req 2; they differ only in **where req 1's reconciliation lives.**

Notation: `res` = live physical resolution, `dpr`, `a` = anchor ∈ [0,1], `REF` = `u_ref_size` (constant 512), `p` = pixel offset.

---

## Candidate A — App compensates offsets (reeded-glass shader + param rewrite)

**Mechanism.** Shader renders anchor-relative (the shared primitive). When the user changes the **output anchor** `a: A→B`, the app rewrites every positioned node's `p` so the on-screen centre is unchanged.

**Math.** Hold `A·res + p_A·dpr = B·res + p_B·dpr` ⟹ `p_B = p_A + (A−B)·res/dpr`.

- **No jump:** ✅ at **all** sizes (compensation uses the live `res`).
- **Resize:** ✅ pins (`a·res` tracks; `p·dpr` fixed size).
- **Ties to output anchor:** ✅ yes (its stated intent).

**Files.** `gradient.ts` (rewrite Pinned field to anchor-relative screen-space, both backends) · `PreviewGizmoOverlay.tsx` (mirror mapping) · a store/effect hook: on `fragment_output.anchor` change → rewrite all positioned nodes' `p` params, **as one undo step**.

**Risk.** Cross-node reactive rewriting is the fragile part: must ride undo/redo atomically, handle N positioned nodes, and not double-fire on load. Medium-high.
**Effort.** Medium-high.

---

## Candidate B — Shader snapshot reference (self-contained)

**Mechanism.** Keep the `grad_center` formula but feed it a **frozen reference resolution** `REF_RES` (canvas size when authored), captured once, instead of live `u_resolution`.

**Math.** `grad_center = a + (0.5−a)·REF_RES/(dpr·REF)` ⟹ `centre_screen = (0.5−a)·REF_RES + res·a`.
- @ `res = REF_RES`: `= 0.5·REF_RES` — anchor cancels ⟹ **no jump**.
- resized: `d/d(res) = a` ⟹ pins.
- resize **then** switch: `d/d(a) = res − REF_RES ≠ 0` ⟹ shifts by the resize delta.

- **No jump:** ⚠️ only at the reference/authoring size.
- **Resize:** ✅ pins.
- **Ties to output anchor:** ✅ yes.

**Files.** Capture `REF_RES` (a uniform, or two hidden node params the app writes on first render) · `gradient.ts` `grad_center` (both backends) · gizmo mirrors it. **No cross-node app logic.**

**Risk.** Low-medium. Main weakness is the partial no-jump guarantee + a capture-timing decision ("first render" is a little ambiguous).
**Effort.** Low-medium.

---

## Candidate C — Per-feature pin / constraints (Figma model)  ★ most robust

**Mechanism.** The gradient owns its **own pin** (a node param, per-axis L/C/R × T/C/B), defaulting to the output anchor but independent. Rendering is anchor-relative to *this node's* pin. Changing the pin holds the screen position — but the compensation is **scoped to this one node** (no global rewrite). This is exactly how design tools do object constraints.

- **No jump:** ✅ all sizes (compensation is deliberate + local).
- **Resize:** ✅ pins per the node's pin.
- **Ties to output anchor:** ⚠️ decoupled — defaults to it, but becomes the node's own control (a model change).

**Files.** Add `pin` param(s) + a small gizmo pin control to the gradient · shader uses the node's pin instead of `u_anchor` · scoped hold-screen-pos when the pin changes (self-contained to the node — no `fragment_output` coupling, no global rewrite).

**Risk.** Medium — it's a model shift, but each node is self-contained (the safest kind). Scales cleanly to any future positioned node.
**Effort.** Medium.

**Why it's compelling.** It removes *both* pain points of A and B: no global cross-node coupling (A), no reference-capture ambiguity or partial guarantee (B). The cost is conceptual — the gradient's pin is its own thing.

---

## Candidate D — Fixed design-resolution reference (B, disambiguated)

**Mechanism.** Same math as B, but `REF_RES` is a **canonical design resolution** (an explicit project setting — the size you author at), not "whatever the canvas was on first render." (`u_ref_size = 512` hints such a reference was originally intended.)

- **No jump:** ⚠️ at the design size; visually holds when the preview matches it.
- **Resize:** ✅ pins away from it.
- **Ties to output anchor:** ✅ yes.

**Files.** Add a `designResolution` project/setting concept · plumb as `REF_RES` · `gradient.ts` + gizmo (same as B).

**Risk.** Low-medium. Cleaner than B (stable, defined reference) but introduces a project-level concept; if the preview isn't at the design size, the no-jump isn't visible in the preview.
**Effort.** Low-medium (+ the design-resolution concept).

---

## Comparison

| | No-jump | Resize pin | Coupling | Output-anchor intent | Effort | Risk |
|---|---|---|---|---|---|---|
| **A** app-compensate | all sizes | ✅ | global cross-node | ✅ | med-high | med-high |
| **B** shader snapshot | ref size only | ✅ | none (self-contained) | ✅ | low-med | low-med |
| **C** per-feature pin | all sizes | ✅ | none (per-node) | reframed | med | med |
| **D** fixed design-res | design size | ✅ | none | ✅ | low-med | low-med |

## Recommendation

- **If you want to keep "the gradient obeys the global output anchor" exactly** → **A** is the faithful full fix (all-sizes no-jump), accepting the cross-node-rewrite plumbing.
- **If you're open to the cleaner model** → **C** is the most robust and future-proof (per-feature constraints, self-contained, no ambiguity) — the way mature tools solve this. It can still *default* to the output anchor, so day-to-day it feels like "respects output anchoring."
- **B / D** are the low-risk shader-only fallbacks; **D** ≥ **B** because its reference is defined rather than captured.

**Hybrid worth noting:** C's per-feature pin **defaulting to and re-syncing with** the output anchor — you get C's robustness while it still tracks the global anchor unless deliberately overridden. Likely the best end state.

All four use the same reeded-glass screen-space primitive for req 2, so that groundwork is shared regardless of which req-1 path we choose.
