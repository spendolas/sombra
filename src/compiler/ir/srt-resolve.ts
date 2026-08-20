/**
 * resolveSRT() — the gizmo-facing consumer of the SRT single source
 * (docs/research/2026-08-20-srt-api-design-spec.md, Consumer 3).
 *
 * A pure query: node params in → structured transform data + drag mappers out.
 * ALL SRT math (coord spaces, y-parity, rotation direction, world/node
 * conversion, px↔css units) lives HERE — a gizmo renderer draws at the
 * returned positions and feeds pointer deltas to the mappers; it must never
 * contain its own trig. The same conversions the Node-view sliders use
 * (ir/srt.ts) back the mappers, so the gizmo, the sliders, and the shader can
 * never disagree.
 *
 * COORD SPACES — the node's `coords` input default decides how offset params
 * map to the screen, and the API owns both cases (nothing leaks to consumers):
 * - 'auto_uv' (patterns): y-DOWN, isotropic, ref-sized. An offset of T px
 *   displaces content T px in the render BUFFER → T·(cssW/bufferW) CSS px.
 * - 'screen_uv' (image): v_uv is y-UP and canvas-relative, so the same shader
 *   code lands differently: +ty moves content DOWN on screen (parity flip) and
 *   units are per-axis canvas fractions — css = (tx·cssW, ty·cssH)/(u_dpr·REF)
 *   with u_dpr measured as bufferW/cssW. Rotation is visually mirrored and
 *   aspect-warped in this space (long-standing image behaviour — the fix is
 *   migrating image onto the coordinate contract, spec follow-up); the mappers
 *   here TRACK that reality so the gizmo stays glued to what renders.
 *
 * Everything reduces to two diagonal maps (paramDeltaToCss / cssDeltaToParam);
 * axes, rotate handle, and all drag inversions derive from them numerically.
 *
 * `space` mirrors the GLOBAL coords-view switch: it changes the AXES the gizmo
 * shows/constrains to — never the stored values (ONE STORAGE, see ir/srt.ts).
 */
import { normalizeTranslateSpace, nodeOffsetToWorld, worldOffsetToNode } from './srt'
import { REFERENCE_SIZE } from '../../renderer/constants'
import type { TranslateSpace } from './types'

export interface Vec2 { x: number; y: number }

/**
 * 'auto_uv': the coordinate contract (y-down, ref-sized, buffer px).
 * 'screen_uv': image's v_uv space (y-up, canvas-relative, per-axis units).
 * (reeded pixel-measured 2026-08-21: its rib space has STANDARD parity —
 *  +ty up, standard rotation — plus node-frame translate; so it's plain
 *  'auto_uv' + translateFrame 'node-legacy'. A y-flipped 'ref_yup' space was
 *  derived from patRef source-reading, shipped, and proven wrong on screen.)
 */
export type SRTCoordSpace = 'auto_uv' | 'screen_uv'

export interface SRTCanvasMetrics {
  /** Canvas CSS size. */
  cssW: number
  cssH: number
  /** Canvas render-buffer width (canvas.width) — carries dpr × quality scale. */
  bufferW: number
}

export interface ResolvedSRT {
  /** Resolved param values (world storage). */
  translate: Vec2
  rotate: number
  scale: Vec2
  /** The coords-view frame in effect (global switch / legacy param / world). */
  space: TranslateSpace
  /** Which transforms this node declares (drives which handles render). */
  has: { translate: boolean; rotate: boolean; scale: boolean; scaleXY: boolean }
  /** Gizmo center, as a CSS-px offset (y-down) from the canvas anchor point. */
  originOffset: Vec2
  /** Unit axis directions of the ACTIVE view frame, CSS y-down. */
  axes: { x: Vec2; y: Vec2 }
  /** CSS angle (radians, y-down) where the rotate handle sits. */
  rotateHandleAngle: number
  /** Uniform scale magnitude for placing the scale handle. */
  scaleMag: number
  /** Map a pointer delta (CSS px) to a translate patch. 'free' follows the
   *  cursor; 'x'/'y' constrain to the ACTIVE frame's axis. */
  dragTranslate: (dxCss: number, dyCss: number, constraint: 'free' | 'x' | 'y') => Record<string, number>
  /** Map the cursor's CSS angle around the gizmo center to a rotate patch. */
  dragRotate: (cssAngleRad: number, snap15?: boolean) => Record<string, number>
  /** Map the cursor's distance from center (vs the handle's base radius) to a scale patch. */
  dragScale: (distCss: number, baseRadiusCss: number) => Record<string, number>
}

export interface ResolveSRTOptions {
  /** The node's SpatialConfig transforms (which SRT ops exist). */
  transforms: ReadonlyArray<'scale' | 'scaleXY' | 'rotate' | 'translate'>
  /** The node's coords space (its `coords` input default). Default 'auto_uv'. */
  coordSpace?: SRTCoordSpace
  /** Live canvas measurements. Default 1/1/1 (unit css, dpr-1). */
  metrics?: SRTCanvasMetrics
  /** The coords-view frame (the GLOBAL switch). Falls back to the node's
   *  stored srt_translateSpace (legacy saves), then 'world'. */
  space?: TranslateSpace
  /**
   * What the node's stored offsets MEAN. 'world' (default): one-storage,
   * framework-injected SRT. 'node-legacy': hand-rolled SRT that still applies
   * translate inside the scaled+rotated frame (reeded_glass) — params are
   * node-frame values, so the visible shift is S·R(−θ)·t and the mappers wrap
   * the same conversions the migration uses. Dies with the reeded migration.
   */
  translateFrame?: 'world' | 'node-legacy'
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
  const coordSpace = opts.coordSpace ?? 'auto_uv'
  const m = opts.metrics ?? { cssW: 1, cssH: 1, bufferW: 1 }
  const safe = (v: number, fb: number) => (Number.isFinite(v) && v > 0 ? v : fb)
  const cssW = safe(m.cssW, 1), cssH = safe(m.cssH, 1), bufferW = safe(m.bufferW, cssW)

  // The two primitives everything derives from — diagonal maps between a
  // param-space offset delta (+Y semantics per space) and a CSS delta (y-down).
  let toCss: (dtx: number, dty: number) => Vec2
  let toParam: (dx: number, dy: number) => Vec2
  if (coordSpace === 'screen_uv') {
    // v_uv space: y-up, canvas-relative. u_dpr ≈ bufferW/cssW; tExpr divides
    // by u_dpr·REF, then 1 uv unit spans the canvas per axis. +ty → DOWN.
    const k = bufferW / cssW
    const ux = cssW / (k * REFERENCE_SIZE)
    const uy = cssH / (k * REFERENCE_SIZE)
    toCss = (dtx, dty) => ({ x: dtx * ux, y: dty * uy })
    toParam = (dx, dy) => ({ x: dx / ux, y: dy / uy })
  } else {
    // auto_uv: offsets land in buffer px, isotropic, y-down (+ty → up).
    const unit = cssW / bufferW
    toCss = (dtx, dty) => ({ x: dtx * unit, y: -dty * unit })
    toParam = (dx, dy) => ({ x: dx / unit, y: -dy / unit })
  }

  // Node-frame axis directions in CSS: where a node-frame +X/+Y offset step
  // displaces content — the world-conversion of a unit node offset, mapped to
  // css. Handles y-parity, aspect, and mirrored rotation with no special cases.
  const axisDir = (nx: number, ny: number, fx: number, fy: number): Vec2 => {
    const w = nodeOffsetToWorld(nx, ny, rotate, sx, sy)
    const v = toCss(w.tx, w.ty)
    const len = Math.hypot(v.x, v.y)
    return len > 1e-9 ? { x: v.x / len, y: v.y / len } : { x: fx, y: fy }
  }
  const worldAxis = (nx: number, ny: number, fx: number, fy: number): Vec2 => {
    const v = toCss(nx, ny)
    const len = Math.hypot(v.x, v.y)
    return len > 1e-9 ? { x: v.x / len, y: v.y / len } : { x: fx, y: fy }
  }
  const axes = space === 'node'
    ? { x: axisDir(1, 0, 1, 0), y: axisDir(0, 1, 0, -1) }
    : { x: worldAxis(1, 0, 1, 0), y: worldAxis(0, 1, 0, -1) }

  // Stored-offset meaning: in 'node-legacy' (hand-rolled reeded SRT) the
  // params are node-frame, so the content-visible world step is
  // nodeOffsetToWorld(params) and writes convert back with worldOffsetToNode.
  const legacy = opts.translateFrame === 'node-legacy'
  const paramsToWorld = (px: number, py: number): Vec2 => {
    if (!legacy) return { x: px, y: py }
    const w = nodeOffsetToWorld(px, py, rotate, sx, sy)
    return { x: w.tx, y: w.ty }
  }
  const worldToParams = (wx: number, wy: number): Vec2 => {
    if (!legacy) return { x: wx, y: wy }
    const n = worldOffsetToNode(wx, wy, rotate, sx, sy)
    return { x: n.tx, y: n.ty }
  }

  const dragTranslate = (dxCss: number, dyCss: number, constraint: 'free' | 'x' | 'y') => {
    let dx = dxCss, dy = dyCss
    if (constraint !== 'free') {
      const a = constraint === 'x' ? axes.x : axes.y
      const k = dxCss * a.x + dyCss * a.y // projection onto the unit axis
      dx = a.x * k
      dy = a.y * k
    }
    const d = toParam(dx, dy)
    // World step → stored-frame step. For legacy the delta must convert as a
    // VECTOR (difference of converted absolutes keeps rotation/scale exact).
    const cur = paramsToWorld(tx, ty)
    const next = worldToParams(cur.x + d.x, cur.y + d.y)
    return { srt_translateX: next.x, srt_translateY: next.y }
  }

  // Rotate handle sits along the css direction of a unit node-X offset at the
  // CURRENT rotation (scale-independent); dragRotate inverts via toParam, so
  // parity and aspect warp cancel exactly (handle tracks the visible feature).
  const rotHandleDirOf = (deg: number): Vec2 => {
    const w = nodeOffsetToWorld(1, 0, deg, 1, 1)
    return toCss(w.tx, w.ty)
  }
  const hd = rotHandleDirOf(rotate)
  const rotateHandleAngle = Math.atan2(hd.y, hd.x)
  // In node-legacy storage, rotating/scaling would ORBIT the content (the
  // world position S·R(−θ)·t changes with θ/s) — wonky under a gizmo. These
  // drags therefore COMPENSATE the offsets to hold the world position fixed,
  // matching how world-storage nodes feel (their center never moves).
  const holdWorld = (newDeg: number, newSx: number, newSy: number): Record<string, number> => {
    if (!legacy || (tx === 0 && ty === 0)) return {}
    const w = paramsToWorld(tx, ty)
    const n = worldOffsetToNode(w.x, w.y, newDeg, newSx, newSy)
    return { srt_translateX: n.tx, srt_translateY: n.ty }
  }
  const dragRotate = (cssAngleRad: number, snap15 = false) => {
    const v = toParam(Math.cos(cssAngleRad), Math.sin(cssAngleRad))
    // v is the node-X world step (c, s) direction (see rotHandleDirOf inverse)
    let deg = normDeg(Math.atan2(v.y, v.x) / deg2rad)
    if (snap15) deg = normDeg(Math.round(deg / 15) * 15)
    deg = Math.round(deg)
    return { srt_rotate: deg, ...holdWorld(deg, sx, sy) }
  }

  const scaleMag = has.scaleXY ? (Math.abs(sx) + Math.abs(sy)) / 2 : sx
  const dragScale = (distCss: number, baseRadiusCss: number): Record<string, number> => {
    const next = Math.min(10, Math.max(0.05, distCss / Math.max(baseRadiusCss, 1e-6)))
    const v = Math.round(next * 100) / 100 // param step 0.01
    // scaleXY v0: the uniform handle writes both axes (per-axis handles are the
    // polished-gizmo pass).
    const base: Record<string, number> = has.scaleXY ? { srt_scaleX: v, srt_scaleY: v } : { srt_scale: v }
    return { ...base, ...holdWorld(rotate, v, v) }
  }

  return {
    translate: { x: tx, y: ty },
    rotate,
    scale: { x: sx, y: sy },
    space,
    has,
    originOffset: (() => { const w = paramsToWorld(tx, ty); return toCss(w.x, w.y) })(),
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
