/**
 * `adapter.requestDevice()` with the limits Sombra's multi-pass binding model
 * actually needs.
 *
 * WebGPU hands back a device on *default* limits unless you ask for more —
 * `maxSampledTexturesPerShaderStage` and `maxSamplersPerShaderStage` are both
 * 16 by default, no matter what the adapter reports. A bare `requestDevice()`
 * therefore pins every session to 16 sampled textures per stage even on
 * hardware offering far more, and a pass that binds past that gets an invalid
 * pipeline rather than a throwable error.
 *
 * Only the two limits that gate the sampler count are raised. Blanket-copying
 * every adapter limit is not free — a driver may take a slower path for a
 * device that asks for a maximal buffer or workgroup size — and none of the
 * rest is what Sombra runs out of.
 *
 * Requesting MORE than the adapter reports rejects device creation outright, so
 * every value is `min(wanted, adapter.limits[key])`. If the request is rejected
 * anyway, fall back to a bare `requestDevice()` so a browser that dislikes the
 * descriptor degrades to today's behaviour instead of losing WebGPU entirely.
 */

/**
 * Ceiling per limit. A cap rather than "whatever the adapter has": these bound
 * the binding-heavy passes Sombra generates, and there is nothing to gain from
 * asking a 1M-texture adapter for 1M descriptors.
 */
const WANTED_LIMITS = {
  maxSampledTexturesPerShaderStage: 128,
  maxSamplersPerShaderStage: 64,
} as const

type WantedLimit = keyof typeof WANTED_LIMITS

/** The `requiredLimits` Sombra would ask `adapter` for. Exported for verification. */
export function deviceLimitsFor(adapter: GPUAdapter): Record<string, number> {
  const limits: Record<string, number> = {}
  for (const key of Object.keys(WANTED_LIMITS) as WantedLimit[]) {
    const supported = (adapter.limits as unknown as Record<string, number | undefined>)[key]
    if (typeof supported !== 'number' || !Number.isFinite(supported)) continue
    limits[key] = Math.min(WANTED_LIMITS[key], supported)
  }
  return limits
}

/**
 * Request a device that is not pinned to WebGPU's default limits.
 *
 * @param adapter the adapter to request from
 * @param init extra descriptor fields (e.g. `requiredFeatures: ['timestamp-query']`),
 *             merged with the computed `requiredLimits`
 */
export async function requestDeviceWithLimits(
  adapter: GPUAdapter,
  init?: Omit<GPUDeviceDescriptor, 'requiredLimits'>,
): Promise<GPUDevice> {
  const requiredLimits = deviceLimitsFor(adapter)
  try {
    return await adapter.requestDevice({ ...init, requiredLimits })
  } catch (error) {
    // Keep WebGPU working rather than raising the ceiling.
    console.warn('[Sombra WebGPU] requestDevice with raised limits failed, falling back to defaults:', error)
    return await adapter.requestDevice(init)
  }
}
