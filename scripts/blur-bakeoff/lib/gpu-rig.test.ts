// GPU rig tests — these drive a REAL GPU in headless Chrome, so they are slower
// than the pure-TS suites. They pin down the two things a silent bug would
// otherwise corrupt in every later measurement: byte-exact passthrough (proves
// orientation + format handling) and cross-backend parity.

import { test, run, assert } from './test-util'
import { createRig, type Rig } from './gpu-rig'
import { stepEdge, transparentEdgeSprite } from './corpus'
import type { Rgba8 } from './image'

function maxAbsDiff(a: Rgba8, b: Rgba8): number {
  assert(a.width === b.width && a.height === b.height, 'dims match')
  let worst = 0
  for (let i = 0; i < a.data.length; i++) {
    const d = Math.abs(a.data[i] - b.data[i])
    if (d > worst) worst = d
  }
  return worst
}

let rig: Rig

test('rig starts and reports both backends available', async () => {
  rig = await createRig()
  assert(rig.available.webgpu, 'webgpu available')
  assert(rig.available.webgl2, 'webgl2 available')
})

test('WebGPU: passthrough returns the input image byte-exactly (orientation correct)', async () => {
  const src = stepEdge(32, 16)
  const out = await rig.capture({
    backend: 'webgpu',
    width: 32,
    height: 16,
    input: src,
    passes: [{ body: 'return sampleSrc(uv);', filter: 'nearest' }],
  })
  assert(maxAbsDiff(out, src) === 0, `expected byte-exact, max diff ${maxAbsDiff(out, src)}`)
})

test('WebGL2: passthrough returns the input image byte-exactly (orientation correct)', async () => {
  const src = stepEdge(32, 16)
  const out = await rig.capture({
    backend: 'webgl2',
    width: 32,
    height: 16,
    input: src,
    passes: [{ body: 'return sampleSrc(uv);', filter: 'nearest' }],
  })
  assert(maxAbsDiff(out, src) === 0, `expected byte-exact, max diff ${maxAbsDiff(out, src)}`)
})

test('passthrough preserves alpha (transparent regions stay transparent)', async () => {
  const src = transparentEdgeSprite(32, 32)
  for (const backend of ['webgpu', 'webgl2'] as const) {
    const out = await rig.capture({
      backend,
      width: 32,
      height: 32,
      input: src,
      passes: [{ body: 'return sampleSrc(uv);', filter: 'nearest' }],
    })
    assert(maxAbsDiff(out, src) === 0, `${backend}: alpha round-trip, diff ${maxAbsDiff(out, src)}`)
  }
})

test('uniforms reach the shader (u_radius drives output)', async () => {
  const src = stepEdge(8, 8)
  for (const backend of ['webgpu', 'webgl2'] as const) {
    const out = await rig.capture({
      backend,
      width: 8,
      height: 8,
      input: src,
      radius: 0.5,
      passes: [{ body: 'return vec4(U.u_radius, 0.0, 0.0, 1.0);' }],
    })
    // 0.5 linear written to an 8-bit unorm target -> 128 (±1)
    assert(Math.abs(out.data[0] - 128) <= 1, `${backend}: expected ~128, got ${out.data[0]}`)
  }
})

test('multi-pass chains: pass 2 sees pass 1 output', async () => {
  const src = stepEdge(8, 8)
  for (const backend of ['webgpu', 'webgl2'] as const) {
    const out = await rig.capture({
      backend,
      width: 8,
      height: 8,
      input: src,
      passes: [
        { body: 'return vec4(1.0, 0.0, 0.0, 1.0);' }, // pass 1: solid red
        { body: 'return vec4(1.0 - sampleSrc(uv).rgb, 1.0);' }, // pass 2: invert -> cyan
      ],
    })
    assert(out.data[0] === 0, `${backend}: R inverted to 0, got ${out.data[0]}`)
    assert(out.data[1] === 255, `${backend}: G is 255, got ${out.data[1]}`)
    assert(out.data[2] === 255, `${backend}: B is 255, got ${out.data[2]}`)
  }
})

test('sampleOrig always reaches the original input, even in later passes', async () => {
  // pass 1 destroys the image (solid black); pass 2 must still recover the original
  const src = stepEdge(16, 8)
  for (const backend of ['webgpu', 'webgl2'] as const) {
    const out = await rig.capture({
      backend,
      width: 16,
      height: 8,
      input: src,
      passes: [
        { body: 'return vec4(0.0, 0.0, 0.0, 1.0);' },
        { body: 'return sampleOrig(uv);', filter: 'nearest' },
      ],
    })
    assert(maxAbsDiff(out, src) === 0, `${backend}: original recovered, diff ${maxAbsDiff(out, src)}`)
  }
})

test('per-pass scale downsamples then upsamples (pyramid prototype)', async () => {
  // A 0.25-scale intermediate must visibly blockify a fine checker when upsampled.
  const n = 32
  const checker: Rgba8 = { width: n, height: n, data: new Uint8ClampedArray(n * n * 4) }
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const v = (x + y) % 2 === 0 ? 255 : 0
      const i = (y * n + x) * 4
      checker.data[i] = checker.data[i + 1] = checker.data[i + 2] = v
      checker.data[i + 3] = 255
    }
  for (const backend of ['webgpu', 'webgl2'] as const) {
    const out = await rig.capture({
      backend,
      width: n,
      height: n,
      input: checker,
      passes: [
        { body: 'return sampleSrc(uv);', scale: 0.25, filter: 'linear' }, // downsample
        { body: 'return sampleSrc(uv);', scale: 1, filter: 'linear' }, // upsample back
      ],
    })
    // Averaging a 1px checker at quarter res collapses it toward mid-grey.
    let minV = 255
    let maxV = 0
    for (let p = 0; p < n * n; p++) {
      const v = out.data[p * 4]
      if (v < minV) minV = v
      if (v > maxV) maxV = v
    }
    assert(maxV - minV < 120, `${backend}: checker collapsed toward grey, range ${minV}..${maxV}`)
  }
})

test('float16 intermediate targets work (Phase 2 precision prototype)', async () => {
  const src = stepEdge(16, 8)
  const out = await rig.capture({
    backend: 'webgpu',
    width: 16,
    height: 8,
    input: src,
    passes: [
      { body: 'return sampleSrc(uv);', float16: true, filter: 'nearest' },
      { body: 'return sampleSrc(uv);', filter: 'nearest' },
    ],
  })
  assert(maxAbsDiff(out, src) === 0, `float16 chain round-trips, diff ${maxAbsDiff(out, src)}`)
})

test('rig closes cleanly', async () => {
  await rig.close()
  assert(true, 'closed')
})

run('gpu-rig')
