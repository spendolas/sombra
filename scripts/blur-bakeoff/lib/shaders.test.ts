// Ties the GPU generators to the CPU ground truth. If a generated shader agrees
// with the reference to within 8-bit rounding, then (a) the generator is correct
// and (b) the reference is a usable yardstick for GPU output. Also measures what
// an 8-bit intermediate costs versus a float16 one — the first Phase 2 datum.

import { test, run, assert } from './test-util'
import { createRig, type Rig } from './gpu-rig'
import { separableGaussianPasses } from './shaders'
import { decodeToLinear, encodeToSrgb8, type Rgba8 } from './image'
import { gaussianBlur } from './reference'
import { hfNoise } from './corpus'

function stats(a: Rgba8, b: Rgba8): { max: number; mean: number } {
  let max = 0
  let sum = 0
  let n = 0
  for (let p = 0; p < a.width * a.height; p++)
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.data[p * 4 + c] - b.data[p * 4 + c])
      if (d > max) max = d
      sum += d
      n++
    }
  return { max, mean: sum / n }
}

let rig: Rig
const SIGMA = 3
const SIZE = 64

test('open rig', async () => {
  rig = await createRig()
  assert(rig.available.webgpu && rig.available.webgl2, 'both backends')
})

// Ground truth: decode to linear, blur in linear light, re-encode.
function cpuReference(src: Rgba8): Rgba8 {
  return encodeToSrgb8(gaussianBlur(decodeToLinear(src), SIGMA))
}

test('WebGPU linearized blur with float16 intermediate matches CPU reference', async () => {
  const src = hfNoise(SIZE, SIZE, 7)
  const out = await rig.capture({
    backend: 'webgpu',
    width: SIZE,
    height: SIZE,
    input: src,
    passes: separableGaussianPasses({ backend: 'webgpu', sigma: SIGMA, linearize: true, premultiply: false, float16: true }),
  })
  const { max, mean } = stats(out, cpuReference(src))
  console.log(`    webgpu float16 intermediate: max diff ${max}, mean ${mean.toFixed(3)}`)
  assert(max <= 3, `expected near-exact agreement, max diff ${max}`)
})

test('WebGL2 linearized blur agrees with CPU reference too (backend parity)', async () => {
  const src = hfNoise(SIZE, SIZE, 7)
  const out = await rig.capture({
    backend: 'webgl2',
    width: SIZE,
    height: SIZE,
    input: src,
    passes: separableGaussianPasses({ backend: 'webgl2', sigma: SIGMA, linearize: true, premultiply: false, float16: true }),
  })
  const { max, mean } = stats(out, cpuReference(src))
  console.log(`    webgl2 float16 intermediate: max diff ${max}, mean ${mean.toFixed(3)}`)
  assert(max <= 4, `expected near-exact agreement, max diff ${max}`)
})

test('the two backends agree with each other', async () => {
  const src = hfNoise(SIZE, SIZE, 11)
  const opts = { sigma: SIGMA, linearize: true, premultiply: false, float16: true } as const
  const a = await rig.capture({
    backend: 'webgpu', width: SIZE, height: SIZE, input: src,
    passes: separableGaussianPasses({ ...opts, backend: 'webgpu' }),
  })
  const b = await rig.capture({
    backend: 'webgl2', width: SIZE, height: SIZE, input: src,
    passes: separableGaussianPasses({ ...opts, backend: 'webgl2' }),
  })
  const { max, mean } = stats(a, b)
  console.log(`    cross-backend: max diff ${max}, mean ${mean.toFixed(3)}`)
  assert(max <= 4, `backends should agree, max diff ${max}`)
})

test('an 8-bit intermediate is measurably worse than float16', async () => {
  const src = hfNoise(SIZE, SIZE, 3)
  const ref = cpuReference(src)
  const f16 = await rig.capture({
    backend: 'webgpu', width: SIZE, height: SIZE, input: src,
    passes: separableGaussianPasses({ backend: 'webgpu', sigma: SIGMA, linearize: true, premultiply: false, float16: true }),
  })
  const u8 = await rig.capture({
    backend: 'webgpu', width: SIZE, height: SIZE, input: src,
    passes: separableGaussianPasses({ backend: 'webgpu', sigma: SIGMA, linearize: true, premultiply: false, float16: false }),
  })
  const sf = stats(f16, ref)
  const su = stats(u8, ref)
  console.log(`    vs reference — float16 mean ${sf.mean.toFixed(3)} max ${sf.max} | 8-bit mean ${su.mean.toFixed(3)} max ${su.max}`)
  assert(su.mean >= sf.mean, 'the 8-bit intermediate should not beat float16')
})

test('close rig', async () => {
  await rig.close()
  assert(true, 'closed')
})

run('shaders')
