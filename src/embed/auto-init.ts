import type { MountOptions, SceneHandle } from './player'

type MountFn = (el: HTMLElement, opts: MountOptions) => Promise<SceneHandle>

const MOUNTED = 'sombraMounted'

/**
 * Scan the document for [data-sombra-scene] elements and mount each one.
 * Idempotent — elements already mounted are skipped, so calling init()
 * repeatedly (e.g. after DOM insertion) is safe.
 */
export function initAll(mount: MountFn): void {
  if (typeof document === 'undefined') return
  const els = document.querySelectorAll<HTMLElement>('[data-sombra-scene]')
  els.forEach((el) => {
    if (el.dataset[MOUNTED]) return
    const scene = el.dataset.sombraScene
    if (!scene) return
    el.dataset[MOUNTED] = '1'
    void mount(el, {
      scene,
      autoplay: el.dataset.sombraAutoplay !== 'false',
      debug: el.dataset.sombraDebug === 'true',
    })
  })
}
