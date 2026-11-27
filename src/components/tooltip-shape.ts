/**
 * Tooltip outline — bubble + caret as ONE closed SVG path.
 *
 * Figma: "DRAFT — Tooltip v2 (one-piece caret)" (1028:11193). The caret and the
 * bubble are a single shape, so there is no seam where they meet and the drop
 * shadow follows the combined outline.
 *
 * Geometry (px):
 *   bubble corners ........... R = 8
 *   caret ..................... 14 wide at the base, 7 tall, tip rounded r = 2
 *   caret/bubble junction ..... concave fillets r = 4
 *   corner sweep .............. when the caret is closer than 19 px (R + half
 *                               base + fillet) to a bubble corner, that corner
 *                               is dropped: the caret's outer side runs straight
 *                               into the adjacent edge and is rounded at r = 6.
 *
 * Built as a polygon with a rounding radius per vertex, so the same code does
 * convex corners, concave fillets, the tip and the corner sweep. Pure — no DOM —
 * so scripts/verify-tooltip-shape.ts can check it.
 */

export type CaretSide = 'top' | 'bottom' | 'left' | 'right'

export const TOOLTIP_RADIUS = 8
export const CARET_BASE = 14
export const CARET_DEPTH = 7
export const CARET_FILLET = 4
export const CARET_TIP_RADIUS = 2
export const CARET_SWEEP_RADIUS = 6
/** Closest the caret centre may sit to a bubble corner (the centre of a 24 px trigger). */
export const CARET_MIN_OFFSET = 12
/** Below this distance from a corner the corner is dropped (R + base/2 + fillet). */
export const CARET_CORNER_THRESHOLD = TOOLTIP_RADIUS + CARET_BASE / 2 + CARET_FILLET

type Vertex = { x: number; y: number; r: number }

/** Rounded closed polygon → SVG path data (tangent arcs, any turn direction). */
export function roundedPolygonPath(vertices: Vertex[]): string {
  const n = vertices.length
  const num = (v: number) => Math.round(v * 1000) / 1000
  const starts: Array<[number, number]> = []
  const ends: Array<[number, number]> = []
  const sweeps: number[] = []
  const radii: number[] = []
  for (let i = 0; i < n; i++) {
    const prev = vertices[(i + n - 1) % n]
    const cur = vertices[i]
    const next = vertices[(i + 1) % n]
    const u1x = cur.x - prev.x, u1y = cur.y - prev.y
    const u2x = next.x - cur.x, u2y = next.y - cur.y
    const l1 = Math.hypot(u1x, u1y), l2 = Math.hypot(u2x, u2y)
    const a = [u1x / l1, u1y / l1], b = [u2x / l2, u2y / l2]
    const cross = a[0] * b[1] - a[1] * b[0]
    const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]))
    const turn = Math.acos(dot) // exterior turning angle, 0 = straight on
    // Tangent length for radius r; clamp so two neighbouring roundings never overlap.
    let r = cur.r
    let d = turn < 1e-6 ? 0 : r * Math.tan(turn / 2)
    const maxD = Math.min(l1, l2) / 2
    if (d > maxD) { d = maxD; r = turn < 1e-6 ? 0 : d / Math.tan(turn / 2) }
    starts.push([cur.x - a[0] * d, cur.y - a[1] * d])
    ends.push([cur.x + b[0] * d, cur.y + b[1] * d])
    sweeps.push(cross > 0 ? 1 : 0)
    radii.push(r)
  }
  let path = `M${num(ends[0][0])} ${num(ends[0][1])}`
  for (let i = 1; i <= n; i++) {
    const k = i % n
    path += `L${num(starts[k][0])} ${num(starts[k][1])}`
    if (radii[k] > 0) {
      path += `A${num(radii[k])} ${num(radii[k])} 0 0 ${sweeps[k]} ${num(ends[k][0])} ${num(ends[k][1])}`
    }
  }
  return path + 'Z'
}

export interface TooltipOutline {
  /** SVG path data, in the box's own coordinates (0,0 = top-left of the box). */
  d: string
  /** Box size including the caret protrusion. */
  width: number
  height: number
  /** Where the bubble's own top-left sits inside the box (the caret side adds an offset). */
  bubbleX: number
  bubbleY: number
}

/**
 * @param w,h     bubble size
 * @param side    which bubble edge carries the caret ('top' = tooltip sits below its trigger)
 * @param at      caret centre, measured along that edge from its start (left→right for
 *                top/bottom, top→bottom for left/right)
 */
export function tooltipOutline(w: number, h: number, side: CaretSide, at: number): TooltipOutline {
  const horizontal = side === 'top' || side === 'bottom'
  const L = horizontal ? w : h // edge carrying the caret
  const D = horizontal ? h : w // depth of the bubble
  const cx = Math.max(CARET_MIN_OFFSET, Math.min(L - CARET_MIN_OFFSET, at))
  const half = CARET_BASE / 2
  const R = TOOLTIP_RADIUS

  // Local frame: caret on the top edge, u along the edge, v into the bubble.
  const local: Vertex[] = []
  if (cx < CARET_CORNER_THRESHOLD) local.push({ x: 0, y: cx - CARET_DEPTH, r: CARET_SWEEP_RADIUS })
  else {
    local.push({ x: 0, y: 0, r: R })
    local.push({ x: cx - half, y: 0, r: CARET_FILLET })
  }
  local.push({ x: cx, y: -CARET_DEPTH, r: CARET_TIP_RADIUS })
  if (L - cx < CARET_CORNER_THRESHOLD) local.push({ x: L, y: L - cx - CARET_DEPTH, r: CARET_SWEEP_RADIUS })
  else {
    local.push({ x: cx + half, y: 0, r: CARET_FILLET })
    local.push({ x: L, y: 0, r: R })
  }
  local.push({ x: L, y: D, r: R })
  local.push({ x: 0, y: D, r: R })

  // Map to screen (x right, y down) for the chosen side; shift so the box starts at 0,0.
  const map = (v: Vertex): Vertex => {
    switch (side) {
      case 'top': return { x: v.x, y: v.y + CARET_DEPTH, r: v.r }
      case 'bottom': return { x: v.x, y: D - v.y, r: v.r }
      case 'left': return { x: v.y + CARET_DEPTH, y: v.x, r: v.r }
      case 'right': return { x: D - v.y, y: v.x, r: v.r }
    }
  }
  const verts = local.map(map)
  return {
    d: roundedPolygonPath(verts),
    width: horizontal ? w : w + CARET_DEPTH,
    height: horizontal ? h + CARET_DEPTH : h,
    bubbleX: side === 'left' ? CARET_DEPTH : 0,
    bubbleY: side === 'top' ? CARET_DEPTH : 0,
  }
}
