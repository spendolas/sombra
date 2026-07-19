import { createShaderRenderer } from '../renderer/create-renderer'
import type { ShaderRenderer, QualityTier } from '../renderer/types'
import {
  decodeArtifact, reconstructPlan, collectPlanUniforms,
  type SceneArtifact, type KnobDescriptor,
} from './artifact'

export interface MountOptions {
  scene: string                                   // base64url artifact
  variables?: Record<string, number | number[]>   // initial knob overrides (by key)
  autoplay?: boolean                               // default true
  debug?: boolean
  onLoad?: (h: SceneHandle) => void
  onError?: (e: Error) => void
}

export interface SceneHandle {
  set(key: string, value: number | number[]): void
  get(key: string): number | number[] | undefined
  variables(): KnobDescriptor[]
  play(): void
  pause(): void
  resize(): void
  destroy(): void
  on(event: 'load' | 'error' | 'contextlost', cb: (...a: unknown[]) => void): void
}

const NOOP_HANDLE: SceneHandle = {
  set() {}, get() { return undefined }, variables() { return [] },
  play() {}, pause() {}, resize() {}, destroy() {}, on() {},
}

export async function mount(el: HTMLElement, opts: MountOptions): Promise<SceneHandle> {
  if (typeof window === 'undefined' || !el) return NOOP_HANDLE

  let artifact: SceneArtifact
  try {
    artifact = decodeArtifact(opts.scene)
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    console.error('[Sombra] Failed to decode scene:', e.message)
    opts.onError?.(e)
    return NOOP_HANDLE
  }

  const canvas = document.createElement('canvas')
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.display = 'block'
  el.appendChild(canvas)

  const plan = reconstructPlan(artifact.plan)
  const manifest = artifact.manifest
  const byKey = new Map(manifest.map((k) => [k.key, k]))
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {}
  const emit = (ev: string, ...a: unknown[]) => (listeners[ev] ?? []).forEach((f) => f(...a))

  let renderer: ShaderRenderer
  try {
    renderer = await createShaderRenderer(canvas)
    const res = renderer.updateRenderPlan(plan)
    if (!res.success) throw new Error(res.error ?? 'updateRenderPlan failed')
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    console.error('[Sombra] Renderer init failed:', e.message)
    if (opts.debug) el.textContent = `[Sombra] ${e.message}`
    opts.onError?.(e)
    return NOOP_HANDLE
  }

  // Bake compile-time uniform values, then apply host overrides.
  renderer.updateUniforms(collectPlanUniforms(plan))
  renderer.setAnchor(artifact.meta.anchor)

  const applyOverride = (key: string, value: number | number[]) => {
    const knob = byKey.get(key)
    if (!knob) { console.warn(`[Sombra] unknown knob "${key}". Known: ${[...byKey.keys()].join(', ')}`); return }
    let v = value
    if (knob.glslType === 'vec4' && Array.isArray(v) && v.length === 3) v = [...v, 1] // pad color alpha
    renderer.updateUniforms([{ name: knob.uniform, value: v }])
  }
  if (opts.variables) for (const [k, v] of Object.entries(opts.variables)) applyOverride(k, v)

  // Re-apply GPU state after device/context loss (all GPU state is gone).
  renderer.onDeviceLost(() => {
    renderer.updateRenderPlan(plan)
    renderer.updateUniforms(collectPlanUniforms(plan))
    for (const [s, img] of images) renderer.uploadImageTexture(s, img)
    emit('contextlost')
  })

  // Baked image textures decode async — re-render as each lands.
  const images = new Map<string, HTMLImageElement>()
  const isAnimated = plan.isTimeLiveAtOutput
  for (const asset of artifact.images) {
    const img = new Image()
    img.onload = () => {
      images.set(asset.sampler, img)
      renderer.uploadImageTexture(asset.sampler, img)
      renderer.notifyChange()
      if (!isAnimated) renderer.requestRender()
    }
    img.src = asset.dataUrl
  }

  renderer.render()
  renderer.setAnimated(isAnimated)
  renderer.setQualityTier((plan.qualityTier ?? 'adaptive') as QualityTier)

  const play = () => { if (isAnimated) { renderer.setAnimationSpeed(artifact.meta.timeSpeed); renderer.startAnimation() } }
  const pause = () => renderer.stopAnimation()
  if (opts.autoplay !== false) play()
  else renderer.notifyChange()

  const handle: SceneHandle = {
    set: applyOverride,
    get: (key) => byKey.get(key)?.default,
    variables: () => manifest.slice(),
    play, pause,
    resize: () => renderer.requestRender(),
    destroy: () => { renderer.stopAnimation(); renderer.dispose(); canvas.remove() },
    on: (ev, cb) => { (listeners[ev] ??= []).push(cb) },
  }
  opts.onLoad?.(handle)
  emit('load', handle)
  return handle
}
