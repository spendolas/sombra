# Scope: standalone Grain node

**Date:** 2026-08-19 · **Status:** PLAN — not implemented · **Implement on its own branch/PR** (a new feature, separate from the entanglement-fix branch).

Goal: a reusable film-grain post-effect that adds grain to *any* colour stream — the reeded_glass grain generalised. Reuses the proven math from `reeded-glass.ts` (`reedPcg` hash + Box–Muller Gaussian + frozen-ref seed + flat additive overlay).

## Node shape
- **type** `grain`, **category** Effect (file `src/nodes/effect/grain.ts`).
- **Pointwise / single-pass** — grain is per-fragment, samples no neighbours, so `source` is a plain `color` input (NOT `textureInput`), output `color`. No pass boundary — same class as brightness/contrast, not blur. Simplest possible integration.
- **conditionalPreview: true** (show once wired).

## Params (with the "cooler" features you asked for)
| id | type | default | notes |
|---|---|---|---|
| `amount` | float 0–1 | 0.08 | Gaussian std-dev (luminance units). The reeded strength constant becomes a knob. |
| `size` | float 0–16 | 0 | Grain cell size (CSS px); 0 = per-device-pixel. |
| `roughness` | float 0–1 | 0 | Two-octave mix: blends a coarse (`size`) and fine (`size/3`) grain so it doesn't sit at one frequency. 0 = single octave. |
| `chroma` | float 0–1 | 0 | 0 = pure luminance grain; 1 = independent per-channel normals (filmic colour grain). Lerp between. |
| `softness` | float 0–1 | 0 | Smooth-interpolate the cell hash (value-noise style) so large `size` doesn't hard-edge. |
| `mode` | enum | additive | additive / multiplicative / overlay — how grain combines with the source. |
| `animate` | bool | false | false = static screen-locked (the reeded default). true = reseed per frame from `u_time` (folded into the hash) for moving film grain. |
| `speed` | float | 1 | `showWhen animate=true`. |
| `seed` | float | 0 | Offsets the hash so two Grain nodes differ. |

`amount` connectable + `updateMode: 'uniform'` (animatable); enums/bool are `recompile`.

## Grain math (single-emitter helper, both backends)
- Seed from frozen-ref auto_uv (resolution/DPR-stable), same as reeded.
- Per cell: `reedPcg` → two uniforms → Box–Muller → N(0,1), clamp ±3σ (done, from reeded).
- `roughness`: sample a second octave at `size/3`, `mix(coarse, fine, roughness)`.
- `chroma`: three independent normals; `mix(vec3(lumaGrain), vec3(rGrain,gGrain,bGrain), chroma)`.
- `softness`: replace `floor(cell)` with a smoothstep blend of the four surrounding cell hashes.
- `animate`: add `floor(u_time*speed)` (or a continuous term) into the hash seed. Default off.
- Combine per `mode`; **rgb only, alpha passed through** (never write alpha — memory: dont-invent-alpha).

## Shared-helper hoist (do this first, as its OWN commit)
Extract `reedPcg` + the Box–Muller grain sampler out of `reeded-glass.ts` into `src/nodes/shared/grain.ts` as a single-emitter helper, and have BOTH reeded_glass and the Grain node call it. Per the CLAUDE.md guardrail, hoisting is a separate, behaviour-preserving commit — land it before the node so reeded parity is verified unchanged (verify-ir-poc / wgsl-multipass byte-identical), then build the node on top.

## System-Wide Change Checklist (new node)
- `src/nodes/effect/grain.ts` with `glsl()` + `ir()`; register in `src/nodes/index.ts` ALL_NODES.
- `BROWSER-AUTOMATION.md` node tables; Figma node template + `.figma/wiki/templates/node-templates.md`.
- Node count in `CLAUDE.md` / `ROADMAP.md` (45 → 46).
- Test preset in `src/utils/test-graph.ts` (shows grain on a gradient).
- Ports are existing color→color; no new port type.

## Verification
- Parity: `verify:ir-poc` + `verify:wgsl-multipass` (GPU) green; hoist step byte-identical for reeded.
- Mechanism-engaged gate (extend `verify-stream-fixes.ts` or a node gate): grain emitted, Gaussian (Box–Muller present), amount scales the term, alpha passed through, static-by-default (no `u_time` unless animate), roughness/chroma/softness each change the emitted code when toggled.
- Visual: grain on a flat gradient at various size/roughness/chroma.

## Risk / effort
- **Risk: low–moderate.** The grain math is proven in reeded; the node is a pointwise single-pass effect (no multi-pass/texture complexity). Main work is the param surface + the shared hoist + the new-node checklist propagation.
- **Effort:** hoist (small) + node (moderate) + checklist propagation (moderate). One to two focused sessions.
