/**
 * Does every GPUDevice Sombra creates ask for the limits it needs?
 *
 * WebGPU applies *default* limits unless the descriptor asks otherwise —
 * `maxSampledTexturesPerShaderStage` and `maxSamplersPerShaderStage` are 16
 * regardless of what the adapter reports. A bare `adapter.requestDevice()`
 * therefore caps a pass at 16 sampled textures on hardware offering hundreds,
 * and a pass that binds past that gets an INVALID pipeline, not a throwable
 * error (`createRenderPipeline` does not throw on a limit violation).
 *
 * Two halves, because either alone is vacuous:
 *   - BEHAVIOUR   `requestDeviceWithLimits` against fake adapters: the clamp,
 *                 the no-over-request rule (over-requesting rejects device
 *                 creation outright), feature pass-through, and the fallback.
 *   - REACH       a source scan proving no `requestDevice(` call in src/ still
 *                 bypasses the helper. Without it the behaviour half would stay
 *                 green while three of the five real call sites kept their bare
 *                 call — which is exactly the bug.
 *
 * Run: npx tsx scripts/verify-device-limits.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import { test, run, assert } from './blur-bakeoff/lib/test-util'

const ROOT = resolve(import.meta.dirname, '..')
const SRC = resolve(ROOT, 'src')
/** The one file allowed to call `requestDevice` directly — it IS the helper. */
const HELPER = resolve(SRC, 'renderer/request-device.ts')

interface Recorded { descriptor?: Record<string, unknown> }

/** A GPUAdapter stand-in: only `limits` and `requestDevice` are ever touched. */
function fakeAdapter(limits: Record<string, number>, opts: { rejectWithLimits?: boolean } = {}) {
  const calls: Recorded[] = []
  const adapter = {
    limits,
    async requestDevice(descriptor?: Record<string, unknown>) {
      calls.push({ descriptor })
      if (opts.rejectWithLimits && descriptor && 'requiredLimits' in descriptor) {
        throw new Error('requested limits exceed adapter capability')
      }
      return { __device: true, descriptor } as unknown
    },
  }
  return { adapter, calls }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(p)) out.push(p)
  }
  return out
}

type Helper = typeof import('../src/renderer/request-device')
let mod: Helper | null = null
let importError = ''
try {
  mod = await import('../src/renderer/request-device')
} catch (err) {
  importError = err instanceof Error ? err.message : String(err)
}

test('1 · the helper exists', () => {
  assert(!!mod, `src/renderer/request-device.ts did not import: ${importError}`)
  assert(typeof mod!.requestDeviceWithLimits === 'function', 'requestDeviceWithLimits is not exported')
  assert(typeof mod!.deviceLimitsFor === 'function', 'deviceLimitsFor is not exported')
})

test('2 · a generous adapter raises both sampler limits above the 16 default', () => {
  if (!mod) throw new Error('helper missing')
  const limits = mod.deviceLimitsFor(fakeAdapter({
    maxSampledTexturesPerShaderStage: 1_000_000,
    maxSamplersPerShaderStage: 1_000_000,
  }).adapter as unknown as GPUAdapter)
  assert(limits.maxSampledTexturesPerShaderStage > 16,
    `maxSampledTexturesPerShaderStage must exceed the 16 default, got ${limits.maxSampledTexturesPerShaderStage}`)
  assert(limits.maxSamplersPerShaderStage > 16,
    `maxSamplersPerShaderStage must exceed the 16 default, got ${limits.maxSamplersPerShaderStage}`)
})

test('3 · never asks for more than the adapter reports', () => {
  if (!mod) throw new Error('helper missing')
  // Over-requesting does not clamp — it REJECTS device creation. A modest
  // adapter must therefore be asked for exactly what it has, not the ceiling.
  const reported = { maxSampledTexturesPerShaderStage: 16, maxSamplersPerShaderStage: 16 }
  const limits = mod.deviceLimitsFor(fakeAdapter(reported).adapter as unknown as GPUAdapter)
  for (const [k, v] of Object.entries(limits)) {
    assert(v <= reported[k as keyof typeof reported],
      `asked for ${k}=${v} against an adapter reporting ${reported[k as keyof typeof reported]} — requestDevice would reject`)
  }
})

test('4 · a limit the adapter does not report is omitted, not requested as undefined', () => {
  if (!mod) throw new Error('helper missing')
  const limits = mod.deviceLimitsFor(fakeAdapter({ maxSampledTexturesPerShaderStage: 64 }).adapter as unknown as GPUAdapter)
  assert(!('maxSamplersPerShaderStage' in limits),
    'an unreported limit must be left out of requiredLimits entirely')
  assert(limits.maxSampledTexturesPerShaderStage === 64, 'the reported limit should still be requested')
})

test('5 · requiredLimits reach requestDevice, alongside requiredFeatures', async () => {
  if (!mod) throw new Error('helper missing')
  const { adapter, calls } = fakeAdapter({ maxSampledTexturesPerShaderStage: 64, maxSamplersPerShaderStage: 32 })
  await mod.requestDeviceWithLimits(adapter as unknown as GPUAdapter,
    { requiredFeatures: ['timestamp-query'] as unknown as GPUFeatureName[] })
  assert(calls.length === 1, `expected 1 requestDevice call, got ${calls.length}`)
  const d = calls[0].descriptor as { requiredLimits?: Record<string, number>; requiredFeatures?: string[] }
  assert(!!d?.requiredLimits, 'requestDevice was called WITHOUT requiredLimits — the device stays on defaults')
  assert(d.requiredLimits!.maxSampledTexturesPerShaderStage === 64,
    `expected 64, got ${d.requiredLimits!.maxSampledTexturesPerShaderStage}`)
  assert(d.requiredFeatures?.[0] === 'timestamp-query',
    'requiredFeatures must survive — the timestamp path depends on it')
})

test('6 · a rejected limits request falls back to a bare device', async () => {
  if (!mod) throw new Error('helper missing')
  const { adapter, calls } = fakeAdapter(
    { maxSampledTexturesPerShaderStage: 64, maxSamplersPerShaderStage: 32 },
    { rejectWithLimits: true })
  // The helper warns on the fallback, correctly — but this case provokes it on
  // purpose, and `verify:ci` output has to stay clean or real warnings stop
  // being read. Stub for this assertion only; the production helper keeps its
  // warning, since a test's needs must not shape it.
  const realWarn = console.warn
  console.warn = () => {}
  let device: GPUDevice
  try {
    device = await mod.requestDeviceWithLimits(adapter as unknown as GPUAdapter)
  } finally {
    console.warn = realWarn
  }
  assert(!!device, 'fallback must still produce a device — losing WebGPU is worse than default limits')
  assert(calls.length === 2, `expected a retry, got ${calls.length} call(s)`)
  assert(!(calls[1].descriptor && 'requiredLimits' in calls[1].descriptor),
    'the retry must not repeat the limits that were just rejected')
})

test('7 · no requestDevice call in src/ bypasses the helper', () => {
  const offenders: string[] = []
  for (const file of walk(SRC)) {
    if (resolve(file) === HELPER) continue
    const text = readFileSync(file, 'utf8')
    text.split('\n').forEach((line, i) => {
      // Skip comment lines — the prose in these files names the API.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
      if (/\.requestDevice\s*\(/.test(line)) offenders.push(`${relative(ROOT, file)}:${i + 1}`)
    })
  }
  assert(offenders.length === 0,
    `${offenders.length} bare requestDevice call(s) still pin their device to DEFAULT limits: ${offenders.join(', ')}`)
})

await run('device-limits')
