# Security findings — WP3 (CSP, XSS sinks, clickjacking), 2026-11-18

## F5 — No Content-Security-Policy — LOW–MEDIUM, FIXED
Neither shipped page (`index.html`, `viewer.html`) had a CSP, so any future XSS or injected markup would run unrestricted and could read the user's localStorage. Fix: a build-only Vite plugin (`vite-csp.ts`) injects a `<meta>` policy: self-only scripts (+ `wasm-unsafe-eval` for the PNG wasm), no inline script, no eval, no plugins, no `<base>`, no form posts. Dev is excluded (HMR needs inline scripts).

Verified in a real browser against the production build: the app loads, the compile worker, blob workers and wasm work, zero violations from app code; a deliberately injected inline script and an `eval` were both blocked (proves the policy is live). `viewer.html` loads clean. Gate: `npm run verify:csp` (policy shape, injection mechanism, no inline scripts in built pages); perturbed two ways and it fails each time.

Export check (2026-11-18): a PNG-sequence export (worker pool + wasm encoder) on the production build ran to completion under the policy ("Exported, sombra.zip 4.8 MB") with zero violations. The browser's save-file picker was disabled for the test (it needs a real user gesture), so the in-memory path ran. Not tested under the policy: MP4/WebM export.

## Checked, no change needed
- **XSS sinks:** no `dangerouslySetInnerHTML`; the only `innerHTML` in shipped code is `EmbedModal` clearing with `''`. `embed-tester.ts` uses `innerHTML` but is a dev page outside the production build inputs.
- **Debug flags** (`?perf=1`, `?backend=webgl2`): expose nothing sensitive.

## Decided against
- **Frame-busting for the editor:** it holds no accounts or money, a framing attack gains little, and `viewer.html` must stay frameable (it is the embed target). `frame-ancestors` cannot be set via `<meta>` on GitHub Pages.
- **`style-src 'unsafe-inline'`** stays: React and React Flow set inline style attributes. Scripts are the real protection and are locked down.
