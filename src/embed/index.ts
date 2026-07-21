import { EMBED_VERSION } from './version'
import { mount } from './player'
import { initAll } from './auto-init'
import { getHandle } from './registry'
import { configureEmbed } from './config'

export { mount } from './player'
export { getHandle as get } from './registry'
export { configureEmbed as configure } from './config'
export type { MountOptions, SceneHandle } from './player'
export type { SceneResolver } from './config'
export type { KnobDescriptor, Knob, NodeInfo } from './artifact'
export const version = EMBED_VERSION
export function init(): void { initAll(mount) }

// UMD global + auto-init on load. Idempotent: if a (possibly different) Sombra
// is already present we keep it, so double-loading the bundle can't clobber a
// live instance — the loader snippet guards on window.Sombra.init.
if (typeof window !== 'undefined') {
  const w = window as unknown as { Sombra?: Record<string, unknown> }
  if (!w.Sombra || typeof w.Sombra.init !== 'function') {
    w.Sombra = { mount, init, get: getHandle, configure: configureEmbed, version }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init())
  } else {
    init()
  }
}
