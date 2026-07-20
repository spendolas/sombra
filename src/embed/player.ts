import { createShaderRenderer } from '../renderer/create-renderer'
import type { ShaderRenderer, QualityTier } from '../renderer/types'
import {
  decodeArtifact, reconstructPlan, collectPlanUniforms,
  type SceneArtifact, type KnobDescriptor, type Knob, type NodeInfo,
} from './artifact'
import { PerfHarness } from './perf-harness'

/** Composite index key for (nodeId, param) lookups (param ids never contain a space). */
const nodeKey = (nodeId: string, param: string) => `${nodeId} ${param}`

export interface MountOptions {
  scene: string                                   // base64url artifact
  variables?: Record<string, number | number[]>   // initial knob overrides (by key)
  autoplay?: boolean                               // default true
  debug?: boolean
  onLoad?: (h: SceneHandle) => void
  onError?: (e: Error) => void
}

export interface SceneHandle {
  /** Set a knob by its flat key, e.g. set('noise-scale', 3). */
  set(key: string, value: number | number[]): void
  /** Set a knob by stable node id + param, e.g. set(nodeId, 'scale', 3). */
  set(nodeId: string, param: string, value: number | number[]): void
  /** Current live value of a knob by flat key. */
  get(key: string): number | number[] | undefined
  /** Current live value of a knob by node id + param. */
  get(nodeId: string, param: string): number | number[] | undefined
  /** Flat list of every knob (metadata + current value). */
  variables(): Knob[]
  /** Knobs grouped by owning node — for deliberate node-directed access. */
  nodes(): NodeInfo[]
  play(): void
  pause(): void
  resize(): void
  destroy(): void
  on(event: 'load' | 'error' | 'contextlost', cb: (...a: unknown[]) => void): void
}

const NOOP_HANDLE: SceneHandle = {
  set() {}, get() { return undefined }, variables() { return [] }, nodes() { return [] },
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
  const byNode = new Map(manifest.map((k) => [nodeKey(k.nodeId, k.param), k]))
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

  // Live uniform values (seeded with baked defaults; updated on every set()).
  const values = new Map<string, number | number[]>()
  const baked = collectPlanUniforms(plan)
  for (const u of baked) values.set(u.name, u.value)

  renderer.updateUniforms(baked)
  renderer.setAnchor(artifact.meta.anchor)

  // Apply a value to a resolved uniform, padding rgb→rgba for color knobs.
  const applyUniform = (uniform: string, glslType: string, value: number | number[]) => {
    let v = value
    if (glslType === 'vec4' && Array.isArray(v) && v.length === 3) v = [...v, 1]
    renderer.updateUniforms([{ name: uniform, value: v }])
    values.set(uniform, v)
  }

  // set(key, value) OR set(nodeId, param, value) — arity disambiguates.
  const setImpl = (a: string, b: number | number[] | string, c?: number | number[]) => {
    if (typeof c !== 'undefined') {
      const knob = byNode.get(nodeKey(a, b as string))
      if (!knob) {
        console.warn(`[Sombra] unknown knob ${a}.${String(b)}. Use handle.nodes() to list nodes + params.`)
        return
      }
      applyUniform(knob.uniform, knob.glslType, c)
    } else {
      const knob = byKey.get(a)
      if (!knob) {
        console.warn(`[Sombra] unknown knob "${a}". Known: ${[...byKey.keys()].join(', ')}`)
        return
      }
      applyUniform(knob.uniform, knob.glslType, b as number | number[])
    }
  }

  // get(key) OR get(nodeId, param) — returns the live value (or default).
  const getImpl = (a: string, b?: string): number | number[] | undefined => {
    const knob = typeof b === 'string' ? byNode.get(nodeKey(a, b)) : byKey.get(a)
    if (!knob) return undefined
    return values.get(knob.uniform) ?? knob.default
  }

  const withValue = (k: KnobDescriptor): Knob => ({ ...k, value: values.get(k.uniform) ?? k.default })

  const nodesImpl = (): NodeInfo[] => {
    const order: string[] = []
    const map = new Map<string, NodeInfo>()
    for (const k of manifest) {
      let info = map.get(k.nodeId)
      if (!info) {
        info = { id: k.nodeId, name: k.node, type: k.nodeType, params: [] }
        map.set(k.nodeId, info)
        order.push(k.nodeId)
      }
      info.params.push(withValue(k))
    }
    return order.map((id) => map.get(id)!)
  }

  // Initial host overrides (by flat key).
  if (opts.variables) for (const [k, v] of Object.entries(opts.variables)) setImpl(k, v)

  // Re-apply GPU state after device/context loss (all GPU state is gone) — restore
  // the LIVE values, not just baked defaults, so host overrides survive.
  renderer.onDeviceLost(() => {
    renderer.updateRenderPlan(plan)
    renderer.updateUniforms([...values].map(([name, value]) => ({ name, value })))
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

  const rawPlay = () => { if (isAnimated) { renderer.setAnimationSpeed(artifact.meta.timeSpeed); renderer.startAnimation() } }
  const rawPause = () => renderer.stopAnimation()

  let autoplayWanted = opts.autoplay !== false
  const harness = new PerfHarness(el, {
    onVisible: () => { if (autoplayWanted) rawPlay() },
    onHidden: rawPause,
    onResize: () => renderer.requestRender(),
  })
  if (harness.reducedMotion) renderer.notifyChange() // one static frame, no loop
  else harness.start()

  const handle: SceneHandle = {
    set: setImpl,
    get: getImpl,
    variables: () => manifest.map(withValue),
    nodes: nodesImpl,
    play: () => { autoplayWanted = true; rawPlay() },
    pause: () => { autoplayWanted = false; rawPause() },
    resize: () => renderer.requestRender(),
    destroy: () => { harness.stop(); renderer.stopAnimation(); renderer.dispose(); canvas.remove() },
    on: (ev, cb) => { (listeners[ev] ??= []).push(cb) },
  }
  opts.onLoad?.(handle)
  emit('load', handle)
  return handle
}
