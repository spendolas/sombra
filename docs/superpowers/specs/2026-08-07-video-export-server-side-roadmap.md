# Video Export — Server-Side Encoding (roadmap idea, parked)

**Date:** 2026-08-07 · **Status:** idea only — *no recommendation, not committed.*
**Trigger:** a real need for transparent **MP4/MOV** output (ProRes for editors, HEVC for Safari),
or any format the browser can't encode. Until then, v1 stays pure client-side (see the video
export design spec, `2026-08-07-video-export-design.md`).

This doc records **where the client-side ceiling is today** and **what a server would unlock**,
so a future agent/decision has the full picture without re-doing the research. All the codec
findings below were **verified live in-browser** (Chrome 151) during the render-test spike, not
assumed.

---

## Where we are now (client-side, GitHub Pages, no backend)

Everything here runs in the user's browser and ships on static Pages. MediaBunny is the
encoder/mux layer.

- **Opaque video:** MP4 / **H.264** via WebCodecs (hardware). ✅ proven end-to-end.
- **Transparent video (real alpha in the file):** **Matroska family only** — **WebM / MKV**,
  codecs **VP8 / VP9 / AV1**, via MediaBunny's `alpha:'keep'`. Verified round-trip
  (`canBeTransparent()===true`, decoded `I420A`, edge α=0 / centre α=255, plays transparent in a
  bare `<video>` in Chrome/Firefox). **AV1-alpha WebM** gives the best compression.
- **Editor hand-off:** **PNG (/EXR) sequence** — lossless, full alpha, universal import.
- Formats are runtime feature-detected (`VideoEncoder.isConfigSupported`).

**Client-side transparency ceiling: WebM/MKV only.** That covers Chrome/Firefox web + editor
sequences. It does **not** cover Safari transparent video or a transparent MP4/MOV file.

## Why the rest needs a server or native tooling (the hard limits)

- **WebCodecs cannot encode alpha for any codec** (vp9/vp8/av1/hevc all `isConfigSupported:
  false`; `configure` throws `NotSupportedError`). MediaBunny sidesteps this **only for
  Matroska** by encoding two opaque streams (colour + alpha-as-luma) and muxing the alpha into
  `BlockAdditional`. MP4 has no equivalent the browser + players honour.
- **MP4/MOV alpha in MediaBunny = ProRes 4444 only** (release v1.52.0: *"Fixed ISOBMFF muxer not
  labeling video tracks as containing an alpha track (e.g. with ProRes 4444)"*), and **the
  browser build cannot encode ProRes** — `getEncodableVideoCodecs()` = `[avc, hevc, vp9, av1,
  vp8]`, no ProRes. ProRes encode lives in **`@mediabunny/server`** (Node.js).
- **Safari transparent = HEVC-alpha MOV**, produced only by **native macOS VideoToolbox**
  (`hevc_videotoolbox -alpha_quality`, or Finder "Encode → Preserve Transparency"). Safari
  ignores WebM/MKV alpha entirely (renders on black).
- **AV1-alpha-MP4 is not a real, browser-playable format** — AV1's bitstream has no alpha; the
  "AV1 alpha" that works is a *container* trick (Matroska `BlockAdditional`), which MP4 lacks. No
  browser renders AV1-alpha-MP4 transparent.
- **GitHub Pages is static** — no server-side compute. So none of the above (Node, VideoToolbox)
  can run on the current setup. Confirmed with the user 2026-08-07.

## What a backend would unlock (options — no recommendation)

Each introduces server compute the current Pages model doesn't have. Listed to capture the
space, not to pick one.

1. **`@mediabunny/server` (Node)** — full ProRes decode/encode incl. **transparency** →
   real **ProRes 4444 alpha MOV**, editor-grade. Same MediaBunny API surface as the client.
2. **macOS VideoToolbox transcode** (a Mac worker / cloud-mac) → **HEVC-alpha MOV** for Safari
   web playback; also HEVC/ProRes generally. The only route to a Safari-native transparent file.
3. **Generic cloud/serverless FFmpeg** → any format server-side (ProRes, HEVC-alpha, VP9-alpha,
   image sequences at scale). Most flexible; most infra.
4. **Custom in-browser encoder ("SombraRes")** — the *other* parked exploration: a purpose-built
   Zig/WASM/GPU encoder for a ProRes-class format, which would keep things client-side. Large
   R&D; see the separate ProRes/GPU-encode findings handoff (delivered to the user's Downloads,
   `browser-video-export-findings-2026-08-07.md`). Not a server path, but the alternative to one.
5. **Stacked-alpha via Sombra's embed player** — *avoids* a server for the **web-embed** case:
   export an opaque double-height (colour+alpha) file + Sombra's recombine shader in the embed
   snippet → renders transparent cross-browser **including Safari**, client-side. Caveat: it is
   not a naked transparent `<video>` file a third party can drop in — it needs Sombra's player.

## Trade-offs to weigh when the trigger fires

- Breaks the **no-backend / static-Pages** model (hosting, cost, ops, maintenance).
- **Privacy:** frames or the graph leave the browser to be encoded server-side.
- **Latency:** upload frames (or re-render server-side) vs instant client encode.
- **Which output actually justifies it:** ProRes-alpha MOV (editors) and HEVC-alpha (Safari web)
  are the only things a server buys that the client can't already do.

## Cross-references

- Video export design spec — `docs/superpowers/specs/2026-08-07-video-export-design.md`
- Approved export-modal mockup — `docs/superpowers/specs/2026-08-07-export-modal-mockup.html`
- ProRes / GPU-encode findings ("SombraRes") — delivered to the user's Downloads
- MediaBunny — https://mediabunny.dev · `@mediabunny/server` (Node, ProRes+alpha)
