import { EMBED_VERSION } from './version'
import { mount } from './player'
import { initAll } from './auto-init'   // added in Task 6; import is safe once that file exists

export { mount } from './player'
export type { MountOptions, SceneHandle } from './player'
export type { KnobDescriptor } from './artifact'
export const version = EMBED_VERSION
export function init(): void { initAll(mount) }

// UMD global + auto-init on load.
if (typeof window !== 'undefined') {
  ;(window as unknown as { Sombra?: unknown }).Sombra = { mount, init, version }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init())
  } else {
    init()
  }
}
