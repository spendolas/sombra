import { test, run, assert } from './test-util'
import {
  stepEdge,
  pointOnBlack,
  smoothGradient,
  hfNoise,
  transparentEdgeSprite,
  colorEdge,
  brightPointField,
} from './corpus'

test('stepEdge: hard vertical black/white edge, exactly two distinct columns', () => {
  const img = stepEdge(8, 4)
  const colAt = (x: number) => img.data[(0 * 8 + x) * 4]
  assert(colAt(0) === 0, 'left is black')
  assert(colAt(7) === 255, 'right is white')
  // every row identical (vertical edge) and only two luminance values present
  const values = new Set<number>()
  for (let i = 0; i < img.data.length; i += 4) values.add(img.data[i])
  assert(values.size === 2, `two values, got ${values.size}`)
})

test('pointOnBlack: exactly one non-black pixel at the centre', () => {
  const img = pointOnBlack(9, 9)
  let nonBlack = 0
  let cx = -1
  for (let p = 0; p < 9 * 9; p++) {
    if (img.data[p * 4] > 0 || img.data[p * 4 + 1] > 0 || img.data[p * 4 + 2] > 0) {
      nonBlack++
      cx = p
    }
  }
  assert(nonBlack === 1, `one bright pixel, got ${nonBlack}`)
  assert(cx === 4 * 9 + 4, 'at centre')
})

test('smoothGradient: horizontally monotonic, low contrast band', () => {
  const img = smoothGradient(64, 2, { from: 100, to: 140 })
  let prev = -1
  for (let x = 0; x < 64; x++) {
    const v = img.data[x * 4]
    assert(v >= prev, `monotonic non-decreasing at ${x}`)
    prev = v
  }
  assert(img.data[0] === 100, 'starts at from')
  assert(img.data[63 * 4] === 140, 'ends at to')
})

test('hfNoise is deterministic for a fixed seed', () => {
  const a = hfNoise(16, 16, 1234)
  const b = hfNoise(16, 16, 1234)
  const c = hfNoise(16, 16, 9999)
  let sameAB = true
  let sameAC = true
  for (let i = 0; i < a.data.length; i++) {
    if (a.data[i] !== b.data[i]) sameAB = false
    if (a.data[i] !== c.data[i]) sameAC = false
  }
  assert(sameAB, 'same seed -> identical')
  assert(!sameAC, 'different seed -> different')
})

test('transparentEdgeSprite: has both fully-opaque and fully-transparent regions', () => {
  const img = transparentEdgeSprite(32, 32)
  let hasOpaque = false
  let hasTransparent = false
  for (let p = 0; p < 32 * 32; p++) {
    const a = img.data[p * 4 + 3]
    if (a === 255) hasOpaque = true
    if (a === 0) hasTransparent = true
  }
  assert(hasOpaque && hasTransparent, 'both alpha extremes present')
})

test('colorEdge: two saturated hues meeting at a hard edge', () => {
  const img = colorEdge(8, 2)
  const left = [img.data[0], img.data[1], img.data[2]]
  const right = [img.data[7 * 4], img.data[7 * 4 + 1], img.data[7 * 4 + 2]]
  assert(left[0] !== right[0] || left[1] !== right[1] || left[2] !== right[2], 'distinct hues')
})

test('brightPointField: multiple bright points on black', () => {
  const img = brightPointField(32, 32, 4)
  let bright = 0
  for (let p = 0; p < 32 * 32; p++) if (img.data[p * 4] === 255) bright++
  assert(bright >= 4, `>=4 points, got ${bright}`)
})

run('corpus')
