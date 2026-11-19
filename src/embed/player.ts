import { createShaderRenderer } from '../renderer/create-renderer'
import type { ShaderRenderer, QualityTier } from '../renderer/types'
import {
  decodeArtifact, decodeArtifactBytes, reconstructPlan, collectPlanUniforms,
  type SceneArtifact, type KnobDescriptor, type Knob, type NodeInfo,
} from './artifact'
import { resolveRef } from './config'
import { PerfHarness } from './perf-harness'
import { showFallback } from './fallback'
import { registerHandle, unregisterHandle } from './registry'
import { isSafeImageDataUrl } from './image-guard'
import { CAPABILITIES, createReporter, closest, checkKnobValue, describe } from './feedback'
import type { SombraWarning } from './feedback'

/** Composite index key for (nodeId, param) lookups (param ids never contain a space). */
const nodeKey = (nodeId: string, param: string) => `${nodeId} ${param}`

export interface MountOptions {
  scene?: string                                  // inline base64url artifact (data-sombra-scene)
  src?: string                                    // scene ref — a hosted .sombra URL (or an id run through the resolver), fetched as binary
  variables?: Record<string, number | number[]>   // initial knob overrides (by key)
  autoplay?: boolean                               // default true
  debug?: boolean                                  // show the error message on the fallback
  fallback?: boolean                               // show the bouncing-SOMBRA screen on error (default true)
  onLoad?: (h: SceneHandle) => void
  onError?: (e: Error) => void
  time?: number                                    // initial scene time in seconds (default 0)
  timeScale?: number                               // clock rate, >= 0 (default 1)
  reducedMotion?: 'respect' | 'ignore'             // default 'respect': no loop under prefers-reduced-motion
}

export interface SceneHandle {
  /** false for the no-op handle returned on any mount failure. */
  readonly ok: boolean
  /** The failure, when ok === false. */
  readonly error?: Error
  /** Set a knob by its flat key, e.g. set('noise-scale', 3). Returns true when applied,
   *  false when not (unknown knob, wrong value type); never throws. The reason is also
   *  reported once via console.warn and the 'warning' event. */
  set(key: string, value: number | number[]): boolean
  /** Set a knob by stable node id + param, e.g. set(nodeId, 'scale', 3). Same contract. */
  set(nodeId: string, param: string, value: number | number[]): boolean
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
  /** True while the render loop is actually running. */
  isPlaying(): boolean
  /** Scene time (u_time) in seconds. */
  getTime(): number
  /** Jump the scene clock; repaints if the loop is not running. */
  setTime(seconds: number): void
  getTimeScale(): number
  /** Clock rate, k >= 0, phase-continuous. 0 holds time while the loop keeps painting. */
  setTimeScale(k: number): void
  /** Draw one frame now. */
  render(): void
  resize(): void
  destroy(): void
  /** 'warning' delivers a SombraWarning (non-fatal misuse, with a stable code). */
  on(event: 'load' | 'error' | 'contextlost' | 'warning', cb: (...a: unknown[]) => void): void
  /** What this player build can do: feature-detect instead of version-sniffing. */
  readonly capabilities: readonly string[]
}

export type { SombraWarning }

const EVENTS: readonly string[] = ['load', 'error', 'contextlost', 'warning']

const NOOP_HANDLE: Omit<SceneHandle, 'ok' | 'error'> = {
  capabilities: CAPABILITIES,
  set() { return false }, get() { return undefined }, variables() { return [] }, nodes() { return [] },
  play() {}, pause() {}, resize() {}, destroy() {}, on() {},
  isPlaying() { return false }, getTime() { return 0 }, setTime() {},
  getTimeScale() { return 1 }, setTimeScale() {}, render() {},
}

/** Fetch a hosted `.sombra` file (binary deflated artifact) and decode it. The ref
 *  is run through the resolver seam first (URL passthrough by default). */
async function fetchArtifact(ref: string): Promise<SceneArtifact> {
  const url = resolveRef(ref)
  let res: Response
  try {
    res = await fetch(url)
  } catch (e) {
    // Cross-origin files must send Access-Control-Allow-Origin; most static hosts can.
    throw new Error(`could not fetch scene "${url}" — network or CORS error (${e instanceof Error ? e.message : String(e)})`)
  }
  if (!res.ok) throw new Error(`could not fetch scene "${url}" — HTTP ${res.status}`)
  return decodeArtifactBytes(new Uint8Array(await res.arrayBuffer()))
}

/** The no-op handle for a failed mount: ok === false, `error` set, and
 *  on('error', cb) calls cb(error) at once (the failure already happened).
 *  destroy() runs `cleanup` (removes the fallback) once. */
function failedHandle(error: Error, cleanup?: () => void): SceneHandle {
  let done = false
  return {
    ...NOOP_HANDLE, ok: false, error,
    destroy: () => { if (!done) { done = true; cleanup?.() } },
    on: (ev, cb) => { if (ev === 'error') cb(error) },
  }
}

export async function mount(el: HTMLElement, opts: MountOptions): Promise<SceneHandle> {
  if (typeof window === 'undefined' || !el) {
    return failedHandle(new Error(typeof window === 'undefined' ? 'no DOM (server-side render)' : 'mount requires an element'))
  }

  // Report a failure to the host: log, onError, and a DOM event mirror of
  // 'sombra:load' so host pages can react to a failed embed (e.g. a 404 /
  // CORS-blocked hosted .ombra file) without a JS callback.
  const notify = (e: Error) => {
    console.error('[Sombra]', e.message)
    opts.onError?.(e)
    try { el.dispatchEvent(new CustomEvent('sombra:error', { detail: { error: e } })) } catch { /* no CustomEvent */ }
  }

  // Any mount failure ends here: notify and (unless opted out) show the bouncing
  // "SOMBRA" fallback in the container. The returned handle is a no-op except
  // destroy(), which removes the fallback.
  const fail = (e: Error): SceneHandle => {
    notify(e)
    if (opts.fallback === false) return failedHandle(e)
    return failedHandle(e, showFallback(el, opts.debug ? e.message : undefined))
  }

  let artifact: SceneArtifact
  try {
    if (opts.scene != null) {
      artifact = decodeArtifact(opts.scene)
    } else if (opts.src != null) {
      artifact = await fetchArtifact(opts.src)
    } else {
      throw new Error('mount requires { scene } (inline) or { src } (hosted .sombra url)')
    }
  } catch (err) {
    return fail(err instanceof Error ? err : new Error(String(err)))
  }

  const canvas = document.createElement('canvas')
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.display = 'block'
  el.appendChild(canvas)

  const plan = reconstructPlan(artifact.plan)
  const isAnimated = plan.isTimeLiveAtOutput
  const manifest = artifact.manifest
  const byKey = new Map(manifest.map((k) => [k.key, k]))
  const byNode = new Map(manifest.map((k) => [nodeKey(k.nodeId, k.param), k]))
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {}
  const emit = (ev: string, ...a: unknown[]) => (listeners[ev] ?? []).forEach((f) => f(...a))
  // Non-fatal misuse of the API: console.warn once per problem + the 'warning' event.
  const report = createReporter((w) => emit('warning', w))
  let loaded = false

  let renderer: ShaderRenderer
  try {
    // Pass the plan so the factory picks WebGL2 for a no-WGSL artifact (published
    // from a non-WebGPU browser) instead of hard-failing on a WebGPU device.
    renderer = await createShaderRenderer(canvas, plan)
    const res = renderer.updateRenderPlan(plan)
    if (!res.success) throw new Error(res.error ?? 'updateRenderPlan failed')
  } catch (err) {
    canvas.remove()
    return fail(err instanceof Error ? err : new Error(String(err)))
  }

  // Live uniform values (seeded with baked defaults; updated on every set()).
  const values = new Map<string, number | number[]>()
  const baked = collectPlanUniforms(plan)
  for (const u of baked) values.set(u.name, u.value)

  renderer.updateUniforms(baked)

  // Randomise Random-node seeds on load: the editor bakes a stable value for
  // consistency, but a published scene should produce a fresh value each mount.
  const seedNames = artifact.randomizeOnLoad ?? []
  if (seedNames.length) {
    const fresh = seedNames.map((name) => ({ name, value: Math.random() }))
    for (const f of fresh) values.set(f.name, f.value)
    renderer.updateUniforms(fresh)
  }

  renderer.setAnchor(artifact.meta.anchor)

  // Player-owned clock (seconds) fed to the renderer as u_time. It advances only
  // while the loop runs, by each frame's dt (clamped to 0.1 s) × timeScale, and
  // holds whenever the loop is stopped — paused, off-screen, tab hidden, reduced
  // motion — so resuming never jumps by the stopped duration.
  let time = opts.time ?? 0
  let timeScale = Math.max(0, opts.timeScale ?? 1) || 0
  let running = false   // the render loop is running right now
  let lastTick = -1     // performance.now() of the last advance; -1 = none since (re)start
  const clock = (): number => {
    if (running) {
      const now = performance.now()
      if (lastTick >= 0) time += Math.min((now - lastTick) / 1000, 0.1) * timeScale
      lastTick = now
    }
    return time
  }
  renderer.setTimeSource?.(clock)

  // One frame on demand while the loop is stopped (set, setTime, resize, a late
  // image), coalesced to one per animation frame. A static scene goes through the
  // renderer's own request path; a time-live scene keeps the renderer `animated`
  // (which makes it ignore requestRender), so the player draws it.
  let ready = false, dead = false, pending = false
  const repaint = () => {
    if (!ready || dead || running) return
    if (!isAnimated) { renderer.requestRender(); return }
    if (pending) return
    pending = true
    requestAnimationFrame(() => { pending = false; if (!dead && !running) renderer.render() })
  }

  // Apply a value to a resolved uniform, padding rgb→rgba for color knobs.
  const applyUniform = (uniform: string, glslType: string, value: number | number[]) => {
    let v = value
    if (glslType === 'vec4' && Array.isArray(v) && v.length === 3) v = [...v, 1]
    renderer.updateUniforms([{ name: uniform, value: v }])
    values.set(uniform, v)
    repaint()
  }

  // set(key, value) OR set(nodeId, param, value) — arity disambiguates. Returns whether
  // the value was applied; never throws (hosts call this from their own render loops).
  const setImpl = (a: string, b: unknown, c?: unknown): boolean => {
    const nodeForm = typeof c !== 'undefined'
    const label = nodeForm ? `${String(a)}.${String(b)}` : String(a)
    if (typeof a !== 'string' || (nodeForm && typeof b !== 'string')) {
      report({ code: 'BAD_VALUE', key: label, message: `knob key${nodeForm ? ' and param' : ''} must be a string, got ${typeof a}.` })
      return false
    }
    const knob = nodeForm ? byNode.get(nodeKey(a, b as string)) : byKey.get(a)
    if (!knob) { unknownKnob(label, nodeForm); return false }
    const checked = checkKnobValue(knob, nodeForm ? c : b)
    if (!checked.ok) {
      report({ code: 'BAD_VALUE', key: label, message: `set("${label}"): ${checked.message}` })
      return false
    }
    if (checked.outOfRange) report({ code: 'OUT_OF_RANGE', key: label, message: `set("${label}"): ${checked.outOfRange}` })
    applyUniform(knob.uniform, knob.glslType, checked.value)
    return true
  }

  // Same report for set() and get(), so asking about one bad key warns once in total.
  const unknownKnob = (label: string, nodeForm: boolean) => {
    const near = nodeForm ? undefined : closest(label, byKey.keys())
    report({
      code: 'UNKNOWN_KNOB', key: label,
      message: `unknown knob "${label}".`,
      hint: near ? `Did you mean "${near}"?` : nodeForm
        ? 'Use handle.nodes() to list node ids and params.'
        : `Use handle.variables() to list knobs (${[...byKey.keys()].slice(0, 8).join(', ')}${byKey.size > 8 ? ', …' : ''}).`,
    })
  }

  // get(key) OR get(nodeId, param) — returns the live value (or default); undefined when
  // the knob does not exist (reported once, like set()).
  const getImpl = (a: string, b?: string): number | number[] | undefined => {
    const nodeForm = typeof b === 'string'
    const knob = nodeForm ? byNode.get(nodeKey(a, b)) : byKey.get(a)
    if (!knob) { unknownKnob(nodeForm ? `${String(a)}.${b}` : String(a), nodeForm); return undefined }
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
    const res = renderer.updateRenderPlan(plan)
    if (!res.success) {
      // Nothing valid to draw on the restored context: stop and tell the host.
      running = false
      renderer.stopAnimation()
      const e = new Error(`context restore failed: ${res.error ?? 'updateRenderPlan failed'}`)
      notify(e)
      emit('error', e)
      return
    }
    renderer.updateUniforms([...values].map(([name, value]) => ({ name, value })))
    for (const [s, img] of images) renderer.uploadImageTexture(s, img)
    // The renderer restarts its loop on restore whenever the scene is time-live;
    // run it only if intent + visibility say so (stopped before its first frame).
    running = false
    renderer.stopAnimation()
    sync()
    repaint()
    emit('contextlost')
  })

  // Baked image textures decode async — re-render as each lands.
  const images = new Map<string, HTMLImageElement>()
  for (const asset of artifact.images) {
    // Only real, sanely-sized image data URLs: an artifact must not make the visitor's
    // browser fetch an arbitrary URL, or decode a header-declared giant image.
    if (!isSafeImageDataUrl(asset?.dataUrl)) continue
    const img = new Image()
    img.onload = () => {
      images.set(asset.sampler, img)
      renderer.uploadImageTexture(asset.sampler, img)
      renderer.notifyChange()
      repaint()
    }
    img.src = asset.dataUrl
  }

  // Animation mode and quality tier set the DPR scale, so apply both before the
  // first frame — otherwise it is drawn at the wrong resolution, then redrawn.
  renderer.setAnimated(isAnimated)
  renderer.setQualityTier((plan.qualityTier ?? 'adaptive') as QualityTier)
  renderer.render()
  ready = true

  // The loop runs iff the scene is time-live, the host wants it (autoplay /
  // play()), and the harness allows it (in view, tab visible, no reduced motion).
  // Every play/pause/visibility change funnels through sync().
  let autoplayWanted = opts.autoplay !== false
  const sync = () => {
    if (dead) return
    if (isAnimated && autoplayWanted && harness.visible) {
      if (!running) { running = true; lastTick = -1; renderer.setAnimationSpeed(artifact.meta.timeSpeed) }
      renderer.startAnimation()   // idempotent
    } else if (running) {
      clock()                     // bank the time up to the stop
      running = false
      renderer.stopAnimation()
    }
  }
  const harness = new PerfHarness(el, { onVisible: sync, onHidden: sync, onResize: repaint },
    opts.reducedMotion === 'ignore')
  harness.start()

  const handle: SceneHandle = {
    ok: true,
    capabilities: CAPABILITIES,
    set: setImpl as SceneHandle['set'],
    get: getImpl,
    variables: () => manifest.map(withValue),
    nodes: nodesImpl,
    play: () => { autoplayWanted = true; sync() },
    pause: () => { autoplayWanted = false; sync() },
    isPlaying: () => running,
    getTime: clock,
    setTime: (seconds) => {
      if (!Number.isFinite(seconds)) {
        report({ code: 'BAD_VALUE', key: 'setTime', message: `setTime(): expected a finite number of seconds, got ${describe(seconds)}; ignored.` })
        return
      }
      time = seconds
      if (running) lastTick = performance.now()
      repaint()
    },
    getTimeScale: () => timeScale,
    setTimeScale: (k) => {
      if (!Number.isFinite(k) || k < 0) {
        report({ code: 'BAD_VALUE', key: 'setTimeScale', message: `setTimeScale(): expected a number >= 0, got ${describe(k)}; using 0.` })
      }
      clock(); timeScale = Math.max(0, k) || 0
    },
    render: () => { if (!dead) renderer.render() },
    resize: repaint,
    destroy: () => {
      if (dead) return
      dead = true; running = false
      unregisterHandle(el); harness.stop(); renderer.stopAnimation(); renderer.dispose()
      // Release the WebGL context now, not at GC: browsers cap live contexts per
      // page and evict the OLDEST one — possibly the host's. A loss forced through
      // WEBGL_lose_context is never auto-restored, so the renderer's restore path
      // stays idle. (WebGPU's dispose() already destroys its device.)
      if (renderer.backend === 'webgl2') canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext()
      canvas.remove()
    },
    on: (ev, cb) => {
      if (!EVENTS.includes(ev)) {
        report({ code: 'UNKNOWN_EVENT', key: String(ev), message: `unknown event "${String(ev)}"; ignored.`, hint: `Supported: ${EVENTS.join(', ')}.` })
        return
      }
      if (typeof cb !== 'function') {
        report({ code: 'BAD_VALUE', key: `on:${ev}`, message: `on("${ev}"): the callback must be a function.` })
        return
      }
      (listeners[ev] ??= []).push(cb)
      // 'load' already fired synchronously during mount() — replay it for late
      // subscribers so handle.on('load', cb) is reliable, not a lost event.
      if (ev === 'load' && loaded) cb(handle)
    },
  }
  loaded = true
  registerHandle(el, handle)   // expose to the host via Sombra.get(el) + 'sombra:load'
  opts.onLoad?.(handle)
  emit('load', handle)
  return handle
}
