/**
 * resolveSRT() — the gizmo-facing consumer of the SRT single source
 * (docs/research/2026-08-20-srt-api-design-spec.md, Consumer 3).
 *
 * A pure query: node params in → structured transform data + drag mappers out.
 * ALL SRT math (frames, y-sign, rotation direction, world/node conversion)
 * lives HERE — a gizmo renderer draws at the returned positions and feeds
 * pointer deltas to the mappers; it must never contain its own trig. The same
 * conversions the Node-view sliders use (ir/srt.ts) back the mappers, so the
 * gizmo, the sliders, and the shader can never disagree.
 *
 * Coordinate conventions:
 * - Params: world-frame offsets, +Y = up (ONE STORAGE — see ir/srt.ts).
 * - Gizmo space: canvas CSS px, y-DOWN, relative to the canvas anchor point
 *   (the Fragment Output anchor at `canvasSize * anchorFraction`).
 * - A world offset of T px displaces content T px in the render BUFFER
 *   (auto_uv's u_dpr divisor cancels against the buffer's dpr·qualityScale),
 *   i.e. T × cssPerPx CSS px where cssPerPx = canvasRect.width / canvas.width.
 *   The caller measures that ratio off the live canvas and passes it in;
 *   originOffset and dragTranslate bake it, so the gizmo tracks the content
 *   1:1 on any dpr / adaptive-quality tier.
 * - `space` mirrors the node's Offset Space view param: it changes the AXES
 *   the gizmo shows/constrains to — never the stored values (one storage).
 *
 * Rotation: the shader samples at R(θ)·S⁻¹·(c − t − a) + a, so visible content
 * transforms by S·R(−θ) — a node-frame +X offset displaces content along
 * css (sx·cosθ, −sy·sinθ). The axes below are exactly those directions.
 */
import { normalizeTranslateSpace, nodeOffsetToWorld } from './srt'
import type { TranslateSpace } from './types'

export interface Vec2 { x: number; y: number }

export interface ResolvedSRT {
  /** Resolved param values (world storage). */
  translate: Vec2
  rotate: number
  scale: Vec2
  /** The node's Offset Space view mode (param or default). */
  space: TranslateSpace
  /** Which transforms this node actually declares (drives which handles render). */
  has: { translate: boolean; rotate: boolean; scale: boolean; scaleXY: boolean }
  /** Gizmo center, as a CSS-px offset (y-down) from the canvas anchor point. */
  originOffset: Vec2
  /** Unit axis directions of the ACTIVE view frame, CSS y-down. */
  axes: { x: Vec2; y: Vec2 }
  /** CSS angle (radians, y-down) where the rotate handle sits. */
  rotateHandleAngle: number
  /** Uniform scale magnitude for placing the scale handle. */
  scaleMag: number
  /**
   * Map a pointer delta (CSS px, y-down) to a translate param patch.
   * 'free' follows the cursor; 'x'/'y' constrain to the ACTIVE frame's axis.
   */
  dragTranslate: (dxCss: number, dyCss: number, constraint: 'free' | 'x' | 'y') => Record<string, number>
  /** Map the cursor's CSS angle around the gizmo center to a rotate patch. */
  dragRotate: (cssAngleRad: number, snap15?: boolean) => Record<string, number>
  /** Map the cursor's distance from center (vs the handle's base radius) to a scale patch. */
  dragScale: (distCss: number, baseRadiusCss: number) => Record<string, number>
}

export interface ResolveSRTOptions {
  /** The node's SpatialConfig transforms (which SRT ops exist). */
  transforms: ReadonlyArray<'scale' | 'scaleXY' | 'rotate' | 'translate'>
  /**
   * CSS px that one world-offset px displaces content on screen:
   * canvasRect.width / canvas.width (buffer px). Default 1 (dpr-1, full-res).
   */
  cssPerPx?: number
  /**
   * The coords-view frame to resolve axes in. The app passes the GLOBAL
   * switch (settingsStore.gizmoView); falls back to the node's stored
   * srt_translateSpace (legacy saves), then 'world'.
   */
  space?: TranslateSpace
}

const deg2rad = Math.PI / 180

function normDeg(d: number): number {
  return ((d + 180) % 360 + 360) % 360 - 180
}

export function resolveSRT(params: Record<string, unknown>, opts: ResolveSRTOptions): ResolvedSRT {
  const has = {
    translate: opts.transforms.includes('translate'),
    rotate: opts.transforms.includes('rotate'),
    scale: opts.transforms.includes('scale'),
    scaleXY: opts.transforms.includes('scaleXY'),
  }
  const tx = (params.srt_translateX as number) ?? 0
  const ty = (params.srt_translateY as number) ?? 0
  const rotate = has.rotate ? ((params.srt_rotate as number) ?? 0) : 0
  const sx = has.scaleXY ? ((params.srt_scaleX as number) ?? 1) : ((params.srt_scale as number) ?? 1)
  const sy = has.scaleXY ? ((params.srt_scaleY as number) ?? 1) : ((params.srt_scale as number) ?? 1)
  const space = opts.space ?? normalizeTranslateSpace(params.srt_translateSpace)
  const cssPerPx = opts.cssPerPx && Number.isFinite(opts.cssPerPx) && opts.cssPerPx > 0 ? opts.cssPerPx : 1

  const rad = rotate * deg2rad
  const c = Math.cos(rad), s = Math.sin(rad)

  // Node-frame axis directions in CSS (y-down): where a node-frame +X/+Y offset
  // displaces content (from nodeOffsetToWorld: +X → css (sx·c, −sy·s),
  // +Y → css (−sx·s, −sy·c)). Degenerate scale falls back to pure rotation.
  const unit = (x: number, y: number, fx: number, fy: number): Vec2 => {
    const len = Math.hypot(x, y)
    return len > 1e-9 ? { x: x / len, y: y / len } : { x: fx, y: fy }
  }
  const nodeX = unit(sx * c, -sy * s, c, -s)
  const nodeY = unit(-sx * s, -sy * c, -s, -c)
  const axes = space === 'node'
    ? { x: nodeX, y: nodeY }
    : { x: { x: 1, y: 0 }, y: { x: 0, y: -1 } }

  const dragTranslate = (dxCss: number, dyCss: number, constraint: 'free' | 'x' | 'y') => {
    let dx = dxCss, dy = dyCss
    if (constraint !== 'free') {
      const a = constraint === 'x' ? axes.x : axes.y
      const k = dxCss * a.x + dyCss * a.y // projection onto the unit axis
      dx = a.x * k
      dy = a.y * k
    }
    // CSS displacement (dx, dy) → offset px (÷cssPerPx so content tracks the
    // cursor 1:1) → world params (+dx, −dy): +Y param = up.
    return { srt_translateX: tx + dx / cssPerPx, srt_translateY: ty - dy / cssPerPx }
  }

  // Visible content rotation in CSS y-down is −θ (see header): the handle sits
  // on the content's rotated X direction, and dragging maps back θ = −angle.
  const rotateHandleAngle = -rad
  const dragRotate = (cssAngleRad: number, snap15 = false) => {
    let deg = normDeg(-cssAngleRad / deg2rad)
    if (snap15) deg = normDeg(Math.round(deg / 15) * 15)
    return { srt_rotate: Math.round(deg) }
  }

  const scaleMag = has.scaleXY ? (Math.abs(sx) + Math.abs(sy)) / 2 : sx
  const dragScale = (distCss: number, baseRadiusCss: number): Record<string, number> => {
    const next = Math.min(10, Math.max(0.05, distCss / Math.max(baseRadiusCss, 1e-6)))
    const v = Math.round(next * 100) / 100 // param step 0.01
    // scaleXY v0: the uniform handle writes both axes (per-axis handles are the
    // polished-gizmo pass).
    return has.scaleXY ? { srt_scaleX: v, srt_scaleY: v } : { srt_scale: v }
  }

  return {
    translate: { x: tx, y: ty },
    rotate,
    scale: { x: sx, y: sy },
    space,
    has,
    originOffset: { x: tx * cssPerPx, y: -ty * cssPerPx },
    axes,
    rotateHandleAngle,
    scaleMag,
    dragTranslate,
    dragRotate,
    dragScale,
  }
}

// Re-export so a gizmo consumer needs a single import — and so tests can assert
// the mappers agree with the slider conversions (same underlying functions).
export { nodeOffsetToWorld }
