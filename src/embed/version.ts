// Single source of truth for the player's version + bundle filename.
// The snippet HOST (which domain serves the player + viewer) is deliberately NOT
// here: it is derived at snippet-build time from the running origin (see
// `embedHostBase` in publish.ts), so embeds follow whatever domain hosts the
// editor — sombra.sh in prod, localhost in dev — instead of a baked-in URL.
export const EMBED_VERSION = '0.1.0'
export const PLAYER_FILENAME = `sombra-player.${EMBED_VERSION}.umd.js`
