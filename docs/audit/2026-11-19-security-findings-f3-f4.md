# Security findings — F3, F4 and the image-size gap, 2026-11-19

Follow-up to `2026-11-16-security-findings-wp1-wp2.md`. All fixed in one change; gate `npm run verify:decode-validation` (in `verify:ci`).

## F3 — No structural validation of decoded graphs/artifacts — FIXED
- **Graphs** (share link and `.sombra` file) now pass `sanitizeGraph` after the id check: at most 2,000 nodes / 8,000 edges; `__proto__`/`constructor`/`prototype` keys are never copied; a *visible* param whose value plainly mismatches its declared type (string/null in a float, wrong shape in a vec/bool) falls back to its default.
- **Deliberately not touched:** hidden storage params (the image node keeps its picture and filename in `float`-typed hidden slots), unknown keys, enums, structured params. My first version reset image data because of exactly that; the gate's "image survives" control caught it before it shipped.
- **Artifacts** get a shape check at decode: object root, no `__proto__`, 1–64 passes each an object, manifest and images arrays within bounds.
- **Compatibility proof:** all 41 `.sombra` files in the repo (529 nodes) were run through the importer with and without the sanitizer: the sanitizer changes **zero** values.

## F4 — Player trusted `img.src` — FIXED
`src/embed/image-guard.ts`: only base64 `png/jpeg/webp/gif` data URLs. The player and `viewer.ts` skip any other image (remote URL, `javascript:`, SVG). On sombra.sh the CSP already blocked remote images; the embed player runs on third-party pages where it does not.

## Image-size bomb — FIXED
Small data URLs skipped the editor's downscale and reached the GPU at full size; a tiny file could declare enormous dimensions. The guard reads the declared size from the PNG/JPEG/WebP/GIF header **before any decode** and refuses an edge over 16,384 px or over 8192² pixels; unreadable headers are refused. Image params that fail are dropped at decode.

## Limits chosen from real data
`shaders/underwear.sombra` embeds a 5504×3072 PNG as a 67.7M-character data URL (legacy JSON). My first character cap (32M) would have dropped it. Raised to 96M characters (dimension limits are what stop a decode bomb), and the file-level inflate cap from 64 MB to 128 MB so a packaged copy of such a file still opens. A GB-scale bomb is still refused.

## Verified
- Gate: 50+ checks, each hostile input paired with a legitimate control and the refusal *reason* asserted; 13 protections reverted one at a time, each turns the gate red (one initially did not: the `__proto__` filter was untestable via share links because `Object.assign` swallows the key; now tested through file import).
- Lint, build, full `verify:ci`, `verify:embed`, embed bundle boundary: pass.

## Still not covered
GPU-time DoS from a hostile shader inside an artifact (inherent: an artifact *is* shader code; the browser's GPU watchdog is the backstop), `resolveRef` redirects (page-author's own URL choice), SRI for embed snippets, dev-dependency upgrades.
