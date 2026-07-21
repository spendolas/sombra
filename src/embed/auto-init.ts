import type { MountOptions, SceneHandle } from './player'

type MountFn = (el: HTMLElement, opts: MountOptions) => Promise<SceneHandle>

const MOUNTED = 'sombraMounted'

/**
 * Scan the document for embeddable elements and mount each one. Three ways to
 * declare a scene, checked in order:
 *   - data-sombra-scene="<base64>"  inline artifact (self-contained, no fetch)
 *   - data-sombra-src="<url>"       hosted .sombra file (fetched as binary)
 *   - data-sombra-id="<id>"         resolved to a URL by Sombra.configure({resolve})
 * Idempotent — already-mounted elements are skipped, so calling init() repeatedly
 * (e.g. after DOM insertion) is safe.
 */
export function initAll(mount: MountFn): void {
  if (typeof document === 'undefined') return
  const els = document.querySelectorAll<HTMLElement>('[data-sombra-scene],[data-sombra-src],[data-sombra-id]')
  els.forEach((el) => {
    if (el.dataset[MOUNTED]) return
    const common = {
      autoplay: el.dataset.sombraAutoplay !== 'false',
      debug: el.dataset.sombraDebug === 'true',
    }
    let opts: MountOptions | null = null
    if (el.dataset.sombraScene) opts = { scene: el.dataset.sombraScene, ...common }
    else if (el.dataset.sombraSrc) opts = { src: el.dataset.sombraSrc, ...common }
    else if (el.dataset.sombraId) opts = { src: el.dataset.sombraId, ...common }
    if (!opts) return
    el.dataset[MOUNTED] = '1'
    void mount(el, opts)
  })
}
