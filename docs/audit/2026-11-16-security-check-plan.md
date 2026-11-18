# Sombra security check — plan (2026-11-16)

Scope: our own code, our own deployments (sombra.sh, the embed player bundle), run locally. No third-party targets, no probing of GitHub Pages infrastructure.

Method: read-only code review first, then local exploit attempts against the dev server / built player using crafted inputs. Every finding gets a repro, a severity, and a fix. Fixes are separate commits (one concern per change).

## Why the shape of the threat is unusual

Sombra has no backend, no accounts, no server-side data. So the classic worst cases (SQLi, auth bypass, data breach) do not exist. The real risks are:

1. **Untrusted input executed in the viewer's browser/GPU.** A `.sombra` file, a share-URL hash, or a hosted embed artifact is attacker-controlled data that becomes shader code and image data on a victim's machine.
2. **Our player runs on other people's sites.** A bug in the embed bundle is a bug on every site that uses it, and `sombra.sh` is a supply-chain point for them.
3. **Our own origin holds user work** (localStorage, persisted images). Any XSS on sombra.sh reads all of it.

## Attack surface found (from a first grep, not yet verified as exploitable)

| Entry point | Where | Concern |
|---|---|---|
| URL hash → decode → compile → render | `src/viewer.ts:24` | crafted share link |
| `.sombra` file import | `src/utils/sombra-file.ts` | malformed/huge/hostile graph, prototype pollution via JSON |
| Embed artifact (deflate base64url) | `src/embed/artifact.ts`, `player.ts` | decompression bomb; hostile `RenderPlan` with raw shader strings |
| `data-sombra-src` → `fetch(url)` | `src/embed/player.ts:77`, `auto-init.ts` | arbitrary URL fetch by page author (low), redirect handling |
| `resolveRef` host shim | `src/embed/config.ts` | origin derivation, SSRF-ish redirect to attacker host |
| `innerHTML` | `src/embed-tester.ts:49` (`setEnvStatus(html)`) | XSS if any argument is data-derived |
| Image import / bitmaps / data URLs | `process-image.ts`, image node | decompression bombs, SVG, huge dimensions |
| Worker `postMessage` handlers | compiler / png / opfs workers | message shape not validated (same-origin only, low) |
| `?backend=` / `?perf=1` query flags | `create-renderer.ts`, `perf-enabled.ts` | debug surface reachable from a link |
| No CSP, no `frame-ancestors` | `index.html`, `viewer.html` | nothing limits script injection or clickjacking |
| `public/design-system.html`, sandbox/test pages | repo root | confirm none ship to prod (`verify:sandbox` covers sandbox only) |
| CI: `deploy.yml`, `ci.yml` | `.github/workflows` | action pinning (tags, not SHAs), token permissions |
| Dependencies | `npm audit --omit=dev`: **0 vulnerabilities** | also check dev deps and the `.wasm` oxipng blob |

## Work packages

**WP1 — Hostile input to the viewer/editor (highest priority)**
- Fuzz `.sombra` import and URL-hash decode: oversized, nested, cyclic graphs, `__proto__`/`constructor` keys, NaN/Infinity params, 10k nodes, huge strings.
- Does a node param ever reach shader text unescaped? Check every `glsl(ctx)`/`ir(ctx)` that interpolates a string param (enum values, labels, node names, ramp stops) into code. Shader-injection = attacker-chosen GPU code.
- GPU DoS: a graph with huge loop counts / resolution that hangs or crashes the GPU process (browser tab, possibly the whole machine's display). Check we cap loop bounds, texture sizes, pass counts.

**WP2 — Embed player and artifact format**
- Decompression bomb: pako inflate with no output cap on `decodeArtifactBytes`.
- Hand-crafted artifact with arbitrary shader strings: confirm what the player does with them (it must, it is a compiled plan) and what that buys an attacker beyond GPU hang. Decide whether to add a size/pass/uniform cap and a loop-bound sanity check at decode time.
- Embed on a hostile page: what can the page do to the player, and the reverse? Knob API (`set`, `get`) type validation; error text leaking into DOM.
- `resolveRef`: redirect target, open-redirect behaviour, CORS-on-redirect shim.

**WP3 — Web-app hardening (headers and XSS)**
- Audit every `innerHTML`; prove each argument is constant or escaped. Add a lint rule banning `innerHTML` / `dangerouslySetInnerHTML` outside an allowlist.
- Add a CSP via `<meta>` (GitHub Pages cannot set headers). Needs `wasm-unsafe-eval` for oxipng, `worker-src blob:`, and checks that WebGPU/WGSL still compiles. Test in Chrome, Firefox, Safari.
- Clickjacking: GitHub Pages cannot send `X-Frame-Options`; meta CSP ignores `frame-ancestors`. Decide: frame-busting script on the editor page only (the viewer/embed must stay frameable).
- Debug query flags: confirm `?perf=1` / `?backend=` expose nothing sensitive.

**WP4 — Data at rest and privacy**
- localStorage contents: persisted images (now budgeted), graph state. Anything sensitive? Anything an imported file can overwrite to break the app permanently (poisoned state that bricks load: needs a recovery path).
- Share URLs: do they embed images or anything personal.
- Export paths: filename handling in downloads (path-like or odd characters from node labels).

**WP5 — Supply chain and CI**
- Pin GitHub Actions to commit SHAs; confirm minimal `permissions:` in both workflows; no `pull_request_target`; no secrets in logs.
- `.env` / `FIGMA_TOKEN` and `.remember/` and `.claude/` not committed or served; grep git history for secrets (gitleaks-style, local).
- `npm audit` including dev deps; lockfile integrity; review install scripts of the 14 prod deps; wasm blob provenance.
- Dropbox-synced repo: `.env` and tokens synced across machines is a local exposure, worth noting.
- Embed bundle integrity: version-pinned UMD at `/embed/` can be swapped if the Pages deploy is compromised; offer SRI hashes in the generated snippet.

**WP6 — Report**
- One findings doc: severity, repro, fix, status. Add a `verify:security` script so the fixed items cannot silently regress (per the repo rule: each gate gets a mechanism-engaged assertion and must be shown to fail when the fix is reverted).

## Suggested order
WP2 + WP1 first (they are where attacker-controlled data meets code), then WP3 (cheap, broad win), then WP5, WP4, WP6.

## Out of scope
Attacks against GitHub, Dropbox, Figma, or sombra.sh DNS/registrar; anything against hosted infrastructure we do not own; social engineering. Registrar 2FA and DNS lock are worth a manual check by the owner.
