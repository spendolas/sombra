/**
 * verify-gizmo-coords — round-trip check for the gizmo px↔screen coord mapping.
 *
 * The overlay maps control-point px (relative to the anchor) to preview-screen
 * pixels and back; the two functions MUST be exact inverses or dragging a
 * handle would drift. Part of the repo's script-based test suite (no unit
 * framework): run with `npx tsx scripts/verify-gizmo-coords.ts`.
 */
import { pointPxToScreen, screenToPointPx } from '../src/utils/gizmo-coords'

const rects = [
  { left: 0, top: 0, width: 800, height: 600 },
  { left: 120.5, top: -40.25, width: 640, height: 360 },
  { left: -300, top: 200, width: 1920, height: 1080 },
]
const anchors: Array<[number, number]> = [
  [0.5, 0.5], [0, 0], [1, 0], [0, 1], [1, 1], [0.25, 0.75],
]
const points: Array<[number, number]> = [
  [0, 0], [40, 40], [-120, 60], [512.5, -0.5], [1000, 1000],
]

const EPS = 1e-6
let passed = 0
let failed = 0

for (const rect of rects) {
  for (const anchor of anchors) {
    for (const [px, py] of points) {
      const screen = pointPxToScreen(px, py, rect, anchor)
      const back = screenToPointPx(screen.x, screen.y, rect, anchor)
      if (Math.abs(back.x - px) <= EPS && Math.abs(back.y - py) <= EPS) {
        passed++
      } else {
        failed++
        console.error(`  [FAIL] rect=${JSON.stringify(rect)} anchor=${anchor} px=(${px},${py}) → back=(${back.x},${back.y})`)
      }
    }
  }
}

console.log('='.repeat(60))
console.log(`  SUMMARY: ${passed} passed, ${failed} failed out of ${passed + failed} round-trip cases`)
console.log('='.repeat(60))
if (failed > 0) process.exit(1)
