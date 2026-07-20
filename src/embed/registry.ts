/**
 * Handle registry — lets a host page reach the SceneHandle of an auto-mounted
 * embed (the `data-sombra-scene` path), so one snippet serves both "just show it"
 * and "control it". Populated by mount() on success; queryable via Sombra.get().
 * Also fires a `sombra:load` CustomEvent on the element (detail.handle) so hosts
 * can subscribe before mount completes.
 */
import type { SceneHandle } from './player'

const registry = new WeakMap<HTMLElement, SceneHandle>()

export function registerHandle(el: HTMLElement, handle: SceneHandle): void {
  registry.set(el, handle)
  try {
    el.dispatchEvent(new CustomEvent('sombra:load', { detail: { handle } }))
  } catch {
    /* environments without CustomEvent — ignore */
  }
}

export function unregisterHandle(el: HTMLElement): void {
  registry.delete(el)
}

/** Get the handle for an element (or element id). Undefined until mounted. */
export function getHandle(target: HTMLElement | string): SceneHandle | undefined {
  const el = typeof target === 'string'
    ? (typeof document !== 'undefined' ? document.getElementById(target) : null)
    : target
  return el ? registry.get(el) : undefined
}
