# Security findings — WP5 (supply chain and CI), 2026-11-18

## F6 — Actions pinned to tags, not commits — LOW–MEDIUM, FIXED
All four actions (`checkout`, `setup-node`, `upload-pages-artifact`, `deploy-pages`) were referenced by moving tags. Whoever controls an action repo (or compromises it) could change what runs in the deploy that publishes sombra.sh. Now pinned to commit SHAs with a `# vN` comment.

## F7 — Over-broad workflow permissions — LOW, FIXED
`ci.yml` declared no `permissions:` (implicit default token scope). In `deploy.yml` the build job held `pages: write` and `id-token: write` it does not need. Now: workflow level is `contents: read`; only the deploy job gets the Pages/OIDC write scopes.

## F8 — Deploy did not run the verify suite — MEDIUM, FIXED
`ci.yml` says deploy "runs the same verify suite before publishing", but `deploy.yml` only built. Merges pushed straight to `main` therefore skipped every gate, including the security gates. Added `npm run verify:ci` to the deploy build job (measured locally: green, ~1m47s, 134+258+90+... checks). A failing gate now blocks publishing.

Gate: `npm run verify:workflows` (SHA pins, top-level read-only permissions, no `pull_request_target`); perturbed two ways, fails each time; in `verify:ci`.

## F9 — Legacy `FIGMA_TOKEN` sitting in a Dropbox-synced `.env` — LOW, owner action
`.env` is gitignored, mode 600, and was never committed (history scan clean). But it lives in a Dropbox-synced folder, so it is copied to Dropbox's servers and every synced machine. CLAUDE.md says Figma access now goes through grip and the token is "legacy-only". Recommend: revoke it in Figma account settings and delete the line unless `tokens:sync` is still used.

## Checked, clean
- **Secret scan of git history** (AWS, GitHub, OpenAI-style, Slack keys, private keys, `FIGMA_TOKEN=`; up to 400 commits): none.
- **Tracked sensitive files:** none (hits were design-token files). `.remember/` ignores itself.
- **`npm audit --omit=dev`:** 0. Full audit: 18 (11 high), all in dev tooling (eslint/minimatch/brace-expansion, postcss, nanoid, picomatch, js-yaml, zod used by scripts). None ship in the app; fix with `npm audit fix` as its own change.
- **Install scripts:** only dev tools (`@swc/core`, `esbuild`, `fsevents`); no production dependency runs an install script.
- **Triggers:** no `pull_request_target`; `ci.yml` runs on PRs from this repo only and holds no secrets.

## Recommended, not done
- **SRI for the embed snippet** (`src/embed/publish.ts` injects the player via a plain `<script src>`): the player file is version-pinned and immutable, so an `integrity` hash is feasible, but it needs the hash computed at `build:embed` and plumbed into the generated snippet. It would protect embedders if sombra.sh or its Pages deploy were ever compromised. Medium effort, its own change.
- **Dev-dependency upgrade** (`npm audit fix`) with the verify suite as the safety net.
- **Manual (yours):** 2FA on GitHub, Dropbox, the sombra.sh registrar; DNS lock; branch protection on `main` (require the CI check).
