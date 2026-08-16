# Preview GPU "banding" — root cause & fix

**Date:** 2026-08-16 · **Branch:** `fix/preview-gpu-banding` · **Reporter GPU:** AMD RDNA-2, macOS, Chrome (WebGPU)

## Symptom

A faint darker stripe/band flickered across the preview canvas. Non-persistent; its
size/position changed with window size, hover, node positions, etc. Reproduced on the
Intel Mac Pro (AMD GPU); **not** reproducible on Apple Silicon. A brightness/contrast
debug filter on `#root` made it obvious. The user was (rightly) worried it could reach
exported video or embedded shaders.

## Root cause

The WebGPU canvas was configured `alphaMode: 'premultiplied'` (a *transparent* canvas)
in every background mode, so the browser composited the canvas over the page on every
frame. On AMD RDNA-2 + macOS Metal + Chrome, that per-frame premultiplied compositing
flickers — a hardware/driver compositor bug, not our rendering. Confirmed by flipping the
context to `alphaMode: 'opaque'`, which eliminated it entirely, and by its absence on
Apple Silicon.

**Not affected:** exports and offscreen readback. Those go through
`copyTextureToBuffer` on an offscreen target, never the presented swap-chain, so the
compositor is not involved.

## Fix — background mode drives the canvas alphaMode

The insight (from the user): checker/solid modes never need a transparent canvas — you
*want* to see that background, not the page behind. Only see-through needs true canvas
transparency. So `alphaMode` is now a pure function of the preview background mode, on
**all** hardware:

- **checker / solid → `alphaMode: 'opaque'`**, background painted *into* the canvas
  (solid = clear to the color; checker = a procedural checker draw). The compositor never
  sees a transparent canvas ⇒ no flicker anywhere. This replaced the previous
  transparent-canvas + DOM-`PreviewBackdrop` approach *for WebGPU*; the DOM backdrop is
  retained because the **WebGL2 fallback** still relies on it (it doesn't implement
  `setBackgroundComposite`).
- **see-through ('none') → `alphaMode: 'premultiplied'`** (transparent), so the UI shows
  through. On AMD this still flickers — **informed and accepted**; the editor shows an
  AMD-gated warning next to the mode switcher (see below). Non-AMD is clean.

Embeds (`src/embed/player.ts`) and share/viewer (`src/viewer.ts`) never call
`setBackgroundComposite`, so they stay `premultiplied` (true transparency). On AMD a
transparent embed will flicker — that is the correct trade-off for a genuinely
transparent embed, and matches the editor's see-through behaviour.

### Key implementation details (`src/webgpu/renderer.ts`)

- **`PREMULT_OVER` blend is baked into every final-pass pipeline unconditionally.** Over
  an opaque clear it composites the premultiplied shader; over a transparent clear it is
  mathematically identity (`src.rgb·1 + 0·(1−a) = src.rgb`), so see-through is
  pixel-identical to a plain transparent canvas. Because the blend is constant, flipping
  modes **never rebuilds a pipeline** — only the context `alphaMode` + clear/checker change.
- **`setBackgroundComposite` reconfigures the context eagerly** (not on the next render),
  so the alphaMode flip is deterministic and there's no one-frame flash at the wrong mode.
- **The WGSL checker is dpr-aware** (`squarePx = 10·dpr`), matching the DOM
  `PreviewBackdrop`'s 10 CSS-px tile exactly, so non-AMD WebGPU users see no change and
  the WebGPU/WebGL2 checkers look identical. This also fixed an interim regression where
  the checker didn't render at all under the earlier AMD-only opaque workaround.

## AMD warning UI

- New semantic token **`color/warning` #fbbf24** (Figma UI Colors `881:311` → DB →
  `--warning` / `text-warning` / `bg-warning`), sibling to the existing `color/error`.
- `src/components/AmdSeeThroughWarning.tsx`: a glass pill (surface-alt/60 + warning/10
  wash + backdrop-blur, `triangle-alert` icon + label), gated to `isAmd && mode === 'none'`.
  Expanded on the first see-through activation per session (auto-collapsing after a
  timeout), collapsed thereafter; hover re-expands, mouse-out collapses. Mirrors the
  user's Figma mock (`AMD Warning/expanded` 878:285, `/Collapsed` 878:294).
- AMD detection: `WebGPUShaderRenderer.isAmd` (`adapter.info.vendor === 'amd'`), surfaced
  to the UI via the runtime (non-persisted) `rendererStore`.

## Verification (on the AMD RDNA-2 machine)

- checker: `opaqueBackground=true`, `alphaMode='opaque'`, checker pipeline engaged; the
  checkerboard renders and the shader composites over it. No flicker.
- solid: opaque canvas cleared to the picked colour; shader composites over it. No flicker.
- see-through: transparent (`premultiplied`) canvas; UI shows through (flicker accepted).
- Warning pill: collapsed (icon) + expanded ("Unstable on this hardware", 164×32,
  matching the Figma 165×32); appears only in see-through on AMD.
- Icons: checker = `chess-knight`, solid = `paint-bucket` (owned icons; `grid`/`square`
  retired).

## Follow-ups

- `.claude/ds-queue.md`: the warning pill's composed glass classes await a first-class
  `amdWarning` DS component (the token generator has no opacity-fill/backdrop-blur/layered-
  fill support today).
- WebGL2 fallback keeps the DOM `PreviewBackdrop`; if it ever gains `setBackgroundComposite`
  the backdrop can be retired everywhere.
