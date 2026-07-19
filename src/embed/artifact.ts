import pako from 'pako'
import type { RenderPlan, RenderPass } from '../compiler/glsl-generator'
import type { UniformSpec } from '../nodes/types'
import { GLSL_VERTEX_SHADER } from './vertex'

/** A knob exposed to the host page. One per unwired updateMode:'uniform' param. */
export interface KnobDescriptor {
  key: string                              // friendly, deduped (e.g. "scale", "scale-2")
  uniform: string                          // wire name, e.g. "u_abc123_scale"
  label: string
  type: 'float' | 'vec2' | 'vec3' | 'color'
  glslType: 'float' | 'vec2' | 'vec3' | 'vec4'
  min?: number
  max?: number
  step?: number
  default: number | number[]
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

export function encodeArtifact(a: SceneArtifact): string {
  const json = JSON.stringify(a)
  const deflated = pako.deflate(json)
  return bytesToBase64Url(deflated)
}

export function decodeArtifact(s: string): SceneArtifact {
  const bytes = base64UrlToBytes(s)
  const json = pako.inflate(bytes, { to: 'string' })
  return JSON.parse(json) as SceneArtifact
}
