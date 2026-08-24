# Deterministic PNG encoder — report

## Why
PNG-sequence export encoded each frame with `OffscreenCanvas.convertToBlob('image/png')`,
which is non-deterministic across engines: Chrome's built-in PNG deflate is far
weaker than Safari's, so the SAME pixels produced ~2× larger files in Chrome
(measured 3.27 MB/frame vs 1.56 MB). Replaced with a pure-JS encoder (fflate zlib
+ hand-rolled CRC32) so file size is consistent cross-browser and controllable.
This does NOT change the inherent ~0.9% GPU dither-flip pixel differences — only
the encoding is made deterministic.

## Encoder design (`src/export/png-encode.ts`)
- **Signature:** `encodePng(rgba, width, height, opts?: { level?: number }): Uint8Array`.
  Input straight-alpha RGBA, row-major, top-down, length `w*h*4`. Output a complete
  PNG file (8-byte signature + IHDR + IDAT + IEND).
- **IHDR:** bit depth 8, colour type 6 (truecolour + alpha = RGBA), compression 0,
  filter 0, interlace 0. Straight (non-premultiplied) alpha preserved verbatim, so
  the transparent-background case round-trips losslessly.
- **Filtering:** ADAPTIVE per-line — for each row compute all five filters
  (None/Sub/Up/Average/Paeth) and pick the one with minimum sum of absolute
  *signed-byte* residuals (the standard PNG "minimum sum of absolute differences"
  heuristic). Chosen over single-fixed-Paeth because it is still a pure function of
  the pixels (fully deterministic) and compresses noticeably better on the mixed
  gradient/flat/noise content shaders produce, for a small per-row CPU cost. The
  filter-type byte prefixes each scanline; the whole filtered stream is then zlib-
  compressed as one IDAT.
- **Compression:** `fflate.zlibSync(filtered, { level })`. `zlibSync` emits a
  zlib-WRAPPED deflate stream (header + Adler32), which is exactly what PNG IDAT
  requires — raw `deflateSync` would be invalid. Default `level` = 6 (balanced),
  exposed via `opts.level`.
- **CRC32:** table-based standard reflected CRC32 (poly 0xEDB88320), built once.
  Every chunk's CRC is computed over (type + data). No new dependency (fflate
  exports no usable public CRC helper).
- **Determinism:** `zlibSync` is deterministic pure JS, so `encodePng` is
  byte-identical for identical input on every engine — the whole point.

## Sink change (`src/export/sinks/png-sequence.ts`)
- `addFrame` now: `drawImage` → `ctx.getImageData(0,0,w,h).data` (non-premultiplied
  RGBA = PNG colour type 6, so alpha round-trips without premultiply error) →
  `encodePng(imageData, w, h, { level: 6 })`. Result pushed into the streaming Zip
  exactly as before (`ZipPassThrough`, level 0 — our PNG is already deflate-
  compressed, no zip recompression).
- Streaming / backpressure (`await queue`) / abort teardown untouched.
- Docstring updated: removed the `convertToBlob` line; now describes the
  deterministic encoder and the cross-engine size motivation.

## Gate (`scripts/verify-png-encode.ts`, registered `verify:png-encode`)
Pure Node/tsx (encoder is pure JS — no browser). Independent in-script decoder
(inflate via `unzlibSync` + unfilter) plus a separate CRC32 reimplementation, so
the gate never trusts the encoder's own helpers. Assertions:
1. `roundtrip-dims` / `roundtrip-lossless` — 32×24 fixture (gradient + pure black
   + pure white + alpha-128 + fully-transparent-with-colour) decodes to the input
   EXACTLY, alpha included.
2. `roundtrip-ffmpeg` — independent decode via `ffmpeg -f rawvideo -pix_fmt rgba`
   (at /usr/local/bin) equals input exactly.
3. `determinism-bytes` — two `encodePng` calls byte-identical. `sink-adopts-encoder`
   — greps sink source: `convertToBlob` absent, `encodePng()` present (mechanism-
   engaged: proves the sink actually adopted the encoder).
4. `crc-correct` — walk chunks, recompute each CRC, compare; assert IHDR…IDAT…IEND.
5. `odd-dims-lossless` — 3×5 varied-alpha image valid + lossless + CRCs ok (level 9).
6. `fail-proof-idat-flip` — flip one IDAT byte → round-trip breaks (or inflate
   throws). `fail-proof-crc` — corrupt one CRC byte → CRC check trips.

### Fail-proof output (observed)
Both fail-proof assertions PASS, i.e. the corruption is detected:
```
[PASS] fail-proof-idat-flip — flipping one IDAT byte breaks the round-trip (idat was 1506 bytes) — the lossless gate CAN fail
[PASS] fail-proof-crc — corrupting one CRC byte trips the CRC check — the CRC gate CAN fail
```
Additionally, before the docstring reword the `sink-adopts-encoder` check FAILED
(the word `convertToBlob` lingered in the docstring), demonstrating that grep-based
mechanism check is live — fixed by rewording, then green.

## Perf note
JS adaptive-filter + zlib encode runs on the MAIN thread (in the sink's
`addFrame`), unlike the native `convertToBlob`. For typical export sizes this is
acceptable, but it is a per-frame CPU cost proportional to pixel count × 5 filter
passes + deflate. A Web Worker offload of the encode is a sensible follow-up — out
of scope here. Backpressure already throttles the frame loop, so it does not race
ahead and buffer.

## Verify counts (all green)
- `npm run lint` — clean
- `npx tsc -b` — exit 0
- `npx tsx scripts/verify-png-encode.ts` — 9 passed, 0 failed (fail-proof demonstrated)
- `npx tsx scripts/verify-export-streaming.ts` — 6 passed, 0 failed
- `npx tsx scripts/verify-export-abort.ts` — 7 passed, 0 failed
- `npx tsx scripts/verify-video-export.ts` — 8 passed, 0 failed, 0 skipped
  (includes its own cross-run determinism check: "all 12 PNG payloads byte-identical
   across two exports" — now passing through our encoder in the real sink path)

## Commit
`feat(export): deterministic PNG encoder (fflate) for consistent cross-browser PNG sizes`
(this report + all code land in that single commit on branch worktree-deterministic-png)
