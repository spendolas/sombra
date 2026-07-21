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

export function resolveRef(ref: string): string {
  return resolver(ref)
}
