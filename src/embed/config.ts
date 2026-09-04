/**
 * Scene-reference resolver seam.
 *
 * A container references its scene by a string ref: today a URL (`data-sombra-src`),
 * later a short id (`data-sombra-id`) mapped to a URL by a host-configured resolver.
 * The player only ever fetches `resolveRef(ref)`, so swapping to a short-code / CDN
 * service later is a one-liner — `Sombra.configure({ resolve })` — with zero changes
 * on the embedding pages. Default resolver is identity (the ref is already a URL).
 */
export type SceneResolver = (ref: string) => string

let resolver: SceneResolver = (ref) => ref

export function configureEmbed(opts: { resolve?: SceneResolver }): void {
  if (opts?.resolve) resolver = opts.resolve
}

// One-time hosting-migration shim. Files once hosted on the old GitHub Pages
// path now live at the sombra.sh apex. The old URL 301-redirects there, but a
// cross-origin fetch() is BLOCKED because GitHub's redirect response carries no
// Access-Control-Allow-Origin header — so already-published embeds that hardcoded
// the old URL fail (blank → fallback stub). Since the embedding page loads THIS
// player fresh each visit, rewriting the known old base to the new one before
// fetching heals those embeds automatically, with no change on the host page.
// Applied to the resolver's OUTPUT so custom resolvers benefit too.
const LEGACY_HOST_BASE = 'https://spendolas.github.io/sombra/'
const CURRENT_HOST_BASE = 'https://sombra.sh/'
function migrateLegacyHost(url: string): string {
  return url.startsWith(LEGACY_HOST_BASE)
    ? CURRENT_HOST_BASE + url.slice(LEGACY_HOST_BASE.length)
    : url
}

export function resolveRef(ref: string): string {
  return migrateLegacyHost(resolver(ref))
}
