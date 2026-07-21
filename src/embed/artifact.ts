import pako from 'pako'
import type { RenderPlan, RenderPass } from '../compiler/glsl-generator'
import type { UniformSpec } from '../nodes/types'
import { GLSL_VERTEX_SHADER } from './vertex'

/** A knob exposed to the host page. One per unwired updateMode:'uniform' param. */
export interface KnobDescriptor {
  key: string                              // node-scoped, deduped (e.g. "noise-scale", "noise-2-scale")
  uniform: string                          // wire name, e.g. "u_abc123_scale"
  nodeId: string                           // stable node id — the deliberate addressing handle
  node: string                             // owning node's display name (e.g. "Noise", "Noise 2")
  nodeType: string                         // machine node type (e.g. "noise") — for filtering
  param: string                            // friendly param slug, unique within its node (e.g. "scale")
  label: string                            // the param's own label (e.g. "Scale")
  type: 'float' | 'vec2' | 'vec3' | 'color'
  glslType: 'float' | 'vec2' | 'vec3' | 'vec4'
  min?: number
  max?: number
  step?: number
  default: number | number[]
}

/** A knob as returned by the read API — descriptor plus its current live value. */
export type Knob = KnobDescriptor & { value: number | number[] }

/** A node and the knobs it owns, for deliberate node-directed access. */
export interface NodeInfo {
  id: string                               // stable node id (pass to set(id, param, value))
  name: string                             // display name (e.g. "Noise 2")
  type: string                             // machine type (e.g. "noise")
  params: Knob[]
}

/** A baked image texture. */
export interface ImageAsset {
  sampler: string                          // "u_<sanitizedNodeId>_image"
  dataUrl: string                          // base64 data URL
}

/** RenderPlan with the constant vertex shaders removed (player re-adds them). */
export type SerializedPlan =
  Omit<RenderPlan, 'vertexShader' | 'passes'> & {
    passes: Array<Omit<RenderPass, 'vertexShader'>>
  }

/** The complete frozen scene payload. */
export interface SceneArtifact {
  v: 1
  kind: 'frozen'                           // reserved: future 'live'
  plan: SerializedPlan
  manifest: KnobDescriptor[]
  images: ImageAsset[]
  meta: {
    anchor: [number, number]
    timeSpeed: number
  }
  /**
   * Uniform names to re-seed with a fresh random value on each mount (Random-node
   * seeds). The editor keeps a stable baked value for consistency; a published
   * scene should randomise per load in the player/viewer. Optional — omitted when
   * the scene has no Random nodes; old players ignore it (stay frozen).
   */
  randomizeOnLoad?: string[]
}

/** Remove the constant vertex shader from every pass + the top-level field. */
export function stripPlan(plan: RenderPlan): SerializedPlan {
  const { vertexShader: _v, passes, ...rest } = plan
  return {
    ...rest,
    passes: passes.map(({ vertexShader: _pv, ...p }) => p),
  }
}

/** Re-attach the player-owned vertex constant so the renderer accepts the plan. */
export function reconstructPlan(sp: SerializedPlan): RenderPlan {
  return {
    ...sp,
    vertexShader: GLSL_VERTEX_SHADER,
    passes: sp.passes.map((p) => ({ ...p, vertexShader: GLSL_VERTEX_SHADER })),
  }
}

/** All runtime uniforms across every pass, deduped by name (for baking). */
export function collectPlanUniforms(
  plan: RenderPlan,
): Array<{ name: string; value: number | number[] }> {
  const seen = new Map<string, number | number[]>()
  for (const pass of plan.passes) {
    for (const u of pass.userUniforms as UniformSpec[]) {
      if (!seen.has(u.name)) seen.set(u.name, u.value)
    }
  }
  return [...seen].map(([name, value]) => ({ name, value }))
}

// --- base64url (chunked to avoid String.fromCharCode RangeError on large buffers) ---

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

// Maps do NOT survive JSON.stringify (they serialize to `{}`). The WGSL
// uniformLayout.offsets (Map<string,number>) is the one Map in a RenderPlan,
// and the WebGPU renderer calls `.get()` on it — so the codec must preserve
// Maps or WebGPU embeds throw at first uniform upload. Tag them generically so
// any Map added to the plan later is also round-tripped losslessly.
function mapReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) return { __map: [...value.entries()] }
  return value
}

function mapReviver(_key: string, value: unknown): unknown {
  if (
    value && typeof value === 'object' &&
    Array.isArray((value as { __map?: unknown }).__map)
  ) {
    return new Map((value as { __map: [unknown, unknown][] }).__map)
  }
  return value
}

/**
 * Binary transport: deflated JSON, no base64. This is the form a hosted `.sombra`
 * file takes — the player fetches it as an ArrayBuffer and inflates. Skipping
 * base64 drops its ~33% tax, so the file is smaller than the inline string and
 * self-compressed (no reliance on the host serving gzip/brotli).
 */
export function encodeArtifactBytes(a: SceneArtifact): Uint8Array {
  return pako.deflate(JSON.stringify(a, mapReplacer))
}

export function decodeArtifactBytes(bytes: Uint8Array): SceneArtifact {
  const json = pako.inflate(bytes, { to: 'string' })
  return JSON.parse(json, mapReviver) as SceneArtifact
}

/** Inline transport: the same deflated bytes, base64url-wrapped for a `data-` attribute. */
export function encodeArtifact(a: SceneArtifact): string {
  return bytesToBase64Url(encodeArtifactBytes(a))
}

export function decodeArtifact(s: string): SceneArtifact {
  return decodeArtifactBytes(base64UrlToBytes(s))
}
