// Single source of truth for the player's version + bundle filename.
// The snippet HOST (which domain serves the player + viewer) is deliberately NOT
// here: it is derived at snippet-build time from the running origin (see
// `embedHostBase` in publish.ts), so embeds follow whatever domain hosts the
// editor — sombra.sh in prod, localhost in dev — instead of a baked-in URL.
// IMMUTABILITY RULE: the bytes served at a given player filename must NEVER change
// once released, because embed snippets carry a Subresource Integrity hash of them
// (src/embed/integrity.ts). Any change to the player build => bump this version, add
// the new file's hash (`npm run embed:integrity -- --write`), and keep the old file
// served (public/embed/) so snippets already in the wild keep working.
// `npm run verify:embed-integrity` (CI + deploy) enforces all of this.
export const EMBED_VERSION = '0.2.0'
export const PLAYER_FILENAME = `sombra-player.${EMBED_VERSION}.umd.js`
