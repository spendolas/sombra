# Security findings — WP1 (hostile input) + WP2 (embed player), 2026-11-16

Method: code read + local probes with `tsx`/`node` against the real decoders and compilers. Nothing run against any hosted site. No GPU-hang payload was executed. Probe scripts were temporary and removed; each repro below is small enough to rewrite.

## F1 — Shader injection through node ids — MEDIUM, confirmed

`ir-compiler.ts:144` (and the GLSL path) does `nodeId.replace(/-/g, '_')` and splices the result into shader identifiers (`node_${id}_${port}`). Node ids come from the decoded share-URL hash, `.sombra` file, and artifact, i.e. attacker JSON.

Repro: compact-hash graph `noise → fragment_output` with noise id `x; } void INJECTED(){ for(;;){} } void y(){ //`. Result on **both** GLSL and WGSL: the string appears verbatim in the generated shader. Clean id: absent.

Impact: attacker-chosen shader text from a shared link. A shader cannot read other origins or the DOM, so this is not code execution in the page. It is: GPU hang / lost context (denial of service on the visitor's machine), and it bypasses every per-node safety limit (loop caps, size caps) because the attacker writes the shader directly instead of using nodes.

Fix: (a) at decode, reject ids not matching `^[A-Za-z0-9_-]{1,64}$`; (b) in the compilers, replace `[^A-Za-z0-9_]` instead of only `-`, and make sure two ids cannot collapse to the same identifier. Check the subgraph/preview compilers use the same helper.

## F2 — Inflate bomb, no output cap — MEDIUM, confirmed

Four inflate sites have no size limit: `sombra-file.ts` (package, hash, compact hash) and `artifact.ts:157`.

Measured: 204 KB compressed → 200 MB in 1.16 s, +424 MB RSS (1029× ratio). A 2 MB URL hash or a 1 MB hosted embed file is a ~1 GB allocation: tab crash. Worth noting for embeds: whoever can change the file at a `data-sombra-src` URL (or a compromised host) can crash every page that embeds it.

Fix: one shared `safeInflate(bytes, maxBytes)` using pako's streaming `Inflate` that aborts past a limit (suggest 64 MB for files, 8 MB for hashes). Also cap the base64 input length before `atob`.

## F3 — No structural validation at decode — LOW–MEDIUM, confirmed

- `decodeArtifactBytes` casts parsed JSON to `SceneArtifact` with no checks; the player feeds `plan` straight to the renderer.
- `decodeCompactHash` does `Object.assign(params, cn.p)`: any keys, any value types. Verified: a string or object in a float param is accepted (it did **not** reach shader text; it stays in uniforms). A `__proto__` key swaps the prototype of that one params object only. Global `Object.prototype` pollution: **tested, not possible** here.
- No cap on node/edge counts: 20,000 nodes decode in 102 ms with no complaint; compile and layout cost then falls on the app.

Fix: validate `v`/`kind`/array shapes and string lengths for artifacts; for graphs, drop unknown params, coerce each to its declared type (float → finite number, enum → one of its options), strip `__proto__`/`constructor`, cap nodes (e.g. 2,000) and edges.

## F4 — Player loads image URL unchecked — LOW, confirmed by reading

`player.ts:292-299`: `img.src = asset.dataUrl` with no check that it is a `data:` URL. A crafted artifact can make the visitor's browser request any URL (tracking beacon, mixed content). `javascript:` in `img.src` does not execute. Fix: require `^data:image/(png|jpeg|webp|gif);base64,` and cap the byte length.

## Checked and fine

- Enum params (trig `func`, `mode`, `interpolation`…): table lookups with a default, no string interpolation.
- Player never uses `innerHTML`; errors go through `textContent` in the player path.
- `Object.prototype` is not polluted via hash decode.
- `auto-init` reads only `data-sombra-*` attributes; fetch URL is chosen by the embedding page's own author.
- `npm audit --omit=dev`: 0 vulnerabilities.

## Accepted by design / not fixable by validation

A published scene **is** shader code. A hostile artifact can always contain a slow or looping shader; the browser's GPU watchdog (context loss, which the player already handles with a `contextlost` event) is the backstop. Mitigation is limits on pass count, texture size and uniform count at decode, not detection of "bad" shaders. Not tested on a real GPU.

## Not yet covered

- Image import: dimension bomb (a huge PNG header through `process-image.ts` / `createImageBitmap`) — untested.
- `.sombra` file path (`importFromFile` prune) — same pattern as the compact hash, expect same F1/F3 results; not run separately.
- `resolveRef` redirect behaviour, knob `set()` argument validation.

## Suggested fix order (one commit each)

1. F1 id validation + identifier sanitising (both backends, with a gate that fails when reverted).
2. F2 bounded inflate, one helper, four call sites.
3. F3 decode validation.
4. F4 image URL check.
