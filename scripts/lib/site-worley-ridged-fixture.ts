/**
 * The `site-worley-ridged` conformance fixture: the spendolas.com background
 * look "spectra Preset 3 – Worley Ridged" rebuilt from existing nodes, node by
 * node and wire by wire, with every wire checked by the canvas's own
 * isConnectionValid() rule (graphBuilder from site-base-fixture.ts).
 *
 * Source of the recipe: the www repo's docs/refactor/sombra/S-B-LOOK-SPEC.md
 * §2 (pipeline), §4.2 (graph), §4.3 (values). Where that spec is wrong about
 * Sombra, the code here follows the source and says so (see the constants).
 *
 * Browser-safe (no node:* imports): the offline gate
 * (verify-embed-site-worley.ts) imports it under tsx, the GPU gate
 * (verify-embed-site-worley-gpu.ts) through the Vite dev server, so both build
 * the identical graph. Call initializeNodeLibrary() before building.
 *
 * Shape (one pass, WebGL2-capable):
 *
 *   field(uv, t) = Smoothstep(0.2, 0.8, Ridged(Noise worley2d(DomainWarp depth 3)))
 *   feed  = field(Pixelate.uv, clock) + site.balance
 *   M     = Dither square(threshold = Remap(feed, 0..1 → -0.04/63..63.96/63))
 *   cv    = field(Pixelate.uv at half scale, clock × 0.5)
 *   on    = mix(mix(stop1, stop2, 0.3·cv), stop3, 0.3·smoothstep(0.585, 0.885, feed))
 *   out   = mix(stop0, on, M)
 *
 * The tail (balance → threshold → dither → accent → four stops → three Mixes →
 * output) is addSiteTail(); a second look (e.g. a value-FBM preset) only needs
 * its own field builder feeding the same tail.
 */
import { graphBuilder, hex, SITE_STOP_HEX, type Graph } from './site-base-fixture'

export { SITE_STOP_HEX, hex }

/** Reference viewport the authored warp scale is set for (spec §7 baseline: 1440×900). */
export const WR_VIEW_CSS_H = 900
/**
 * Warp SRT scale = one spectra lattice unit in Sombra ref units. spectra
 * samples at uv·foldScale with uv in viewport HEIGHTS (foldScale 0.1 → one
 * lattice unit = 10 heights); Sombra ref uv is 512 CSS px and SRT divides by
 * scale, so S = 10·H_css/512 = H_css/51.2. The host re-writes it on resize.
 * (Above the knob's authored max of 10 — nothing clamps a write; see EMBED.md.)
 */
export const WR_WARP_SCALE = WR_VIEW_CSS_H / 51.2            // 17.578125
/** spectra warpStrength. Both the xy and the z (phase) warp use it. */
export const WR_WARP_STRENGTH = 0.2
/**
 * Field time = u_time × site.clock speed. spectra: t = uTime·speed·foldSpeed·0.05
 * = uTime·1e-5·5·0.05 = 2.5e-6·uTime. The player's u_time is plain seconds ×
 * the host's timeScale: `meta.timeSpeed` only picks the adaptive FPS tier
 * (renderer.setAnimationSpeed) and does NOT scale time, so the whole factor
 * goes on the Time node (spec §4.3's "5e-5 × meta 0.05" does not hold).
 */
export const WR_CLOCK_SPEED = 2.5e-6
/** Dot / field-cell size in REFERENCE px (×dpr on the GPU): 2/16 → 4/32 device px at dpr 2. */
export const WR_DOT_PX = 2
export const WR_CELL_PX = 16
/**
 * Threshold calibration: Sombra lights a dot when bayer(k)/63 ≤ thr; spectra
 * when feed + 0.015 ≥ 1 − k'/64. thr = (64·(feed + 0.015) − 1)/63 =
 * feed·64/63 − 0.04/63, i.e. Remap 0..1 → −0.04/63..63.96/63
 * (−0.000635..1.015238).
 */
export const WR_THR_OUT: readonly [number, number] = [-0.04 / 63, 63.96 / 63]
/** spectra smoothstep(0.6, 0.9, field + 0.015 + balance) with the 0.015 folded in. */
export const WR_ACCENT_EDGES: readonly [number, number] = [0.585, 0.885]
/** spectra blends at most 30 % toward stop 2 (cv) and stop 3 (accent). */
export const WR_BLEND_MAX = 0.3

/** The keys the site binds, exactly (unlabelled nodes' knobs come on top and are pinned by the gate). */
export const WR_REQUIRED_KEYS = [
  'site-clock-speed', 'site-seed-value', 'site-balance-value', 'site-dots-pixel-size',
  'site-palette-stop-0-color', 'site-palette-stop-1-color', 'site-palette-stop-2-color', 'site-palette-stop-3-color',
  'site-warp-scale', 'site-warp-color-scale',
  'fragment-output-alpha',
] as const

type Builder = ReturnType<typeof graphBuilder>
type Port = readonly [node: string, port: string]

/**
 * One spectra `fieldValue`: Domain Warp (value noise, 3 samples: x, y AND the
 * phase) → Noise worley2d at the warped coords and warped phase → Ridged →
 * Smoothstep(0.2, 0.8). Returns the Smoothstep result port.
 */
function addWorleyRidgedField(
  g: Builder, p: string, row: number, warpLabel: string, coords: Port, phase: Port, seed: Port, warpScale: number,
): Port {
  const warp = `${p}warp`, field = `${p}field`, ridged = `${p}ridged`, smooth = `${p}smooth`
  // Labelled: the host re-writes the warp scale on resize, so its key must not
  // depend on compile order (unlabelled, the colour branch's warp compiles
  // first and would own `warp-scale`).
  g.add(warp, 'warp', 2, row, { noiseType: 'value', warpDepth: '3', strength: WR_WARP_STRENGTH, srt_scale: warpScale }, warpLabel)
  g.add(field, 'noise', 3, row, { noiseType: 'worley2d', srt_scale: 1 })
  g.add(ridged, 'ridged', 4, row)
  g.add(smooth, 'smoothstep', 5, row, { min: 0.2, max: 0.8 })
  g.wire(coords[0], coords[1], warp, 'coords')
  g.wire(phase[0], phase[1], warp, 'phase')
  g.wire(seed[0], seed[1], warp, 'seed')
  g.wire(warp, 'warped', field, 'coords')
  g.wire(warp, 'warpedPhase', field, 'phase')
  g.wire(seed[0], seed[1], field, 'seed')
  g.wire(field, 'value', ridged, 'value')
  g.wire(ridged, 'result', smooth, 'x')
  return [smooth, 'result']
}

/**
 * The shared spectra pixel-mode tail: feed = field + site.balance → threshold
 * Remap → site.dots (square, live) → mask; accent from feed; four stop colours
 * → three Mixes → Fragment Output. `field` drives coverage, `cv` (0..1) the
 * stop-1 → stop-2 blend.
 */
export function addSiteTail(g: Builder, field: Port, cv: Port): void {
  const color = (k: number) => ({ color: hex(SITE_STOP_HEX[k]) })
  g.add('site-balance', 'float_constant', 5, 4, { value: 0 }, 'site.balance')
  g.add('feed', 'arithmetic', 6, 0, { operation: 'add', inputCount: 2 })
  g.add('thr', 'remap', 7, 0, { inMin: 0, inMax: 1, outMin: WR_THR_OUT[0], outMax: WR_THR_OUT[1] })
  g.add('site-dots', 'dither', 8, 0, { pixelSize: WR_DOT_PX, shape: 'square', colorSource: 'live' }, 'site.dots')
  // Dither's colour port is a texture input — wiring a constant into it would
  // split the plan into two passes. Unwired it is grey 0.5, so Result.x =
  // 0.5 × mask and this Remap returns the mask exactly (as in site-base).
  g.add('mask', 'remap', 9, 0, { inMin: 0, inMax: 0.5, outMin: 0, outMax: 1 })
  g.add('acc', 'smoothstep', 7, 1, { min: WR_ACCENT_EDGES[0], max: WR_ACCENT_EDGES[1] })
  g.add('acc-k', 'remap', 8, 1, { inMin: 0, inMax: 1, outMin: 0, outMax: WR_BLEND_MAX })
  g.add('cv-k', 'remap', 8, 3, { inMin: 0, inMax: 1, outMin: 0, outMax: WR_BLEND_MAX })
  for (let k = 0; k < 4; k++) g.add(`site-palette-stop-${k}`, 'color_constant', 9, 2 + k, color(k), `site.palette.stop-${k}`)
  g.add('mix-cv', 'mix', 10, 3)
  g.add('mix-acc', 'mix', 11, 2)
  g.add('mix-m', 'mix', 12, 1)
  g.add('output', 'fragment_output', 13, 1, { alpha: 1, alphaOp: 'multiply', quality: 'high', anchor: 'center' })

  g.wire(field[0], field[1], 'feed', 'in_0')
  g.wire('site-balance', 'value', 'feed', 'in_1')
  g.wire('feed', 'result', 'thr', 'value')
  g.wire('thr', 'result', 'site-dots', 'threshold')
  g.wire('site-dots', 'result', 'mask', 'value')
  g.wire('feed', 'result', 'acc', 'x')
  g.wire('acc', 'result', 'acc-k', 'value')
  g.wire(cv[0], cv[1], 'cv-k', 'value')
  g.wire('site-palette-stop-1', 'color', 'mix-cv', 'a')
  g.wire('site-palette-stop-2', 'color', 'mix-cv', 'b')
  g.wire('cv-k', 'result', 'mix-cv', 'factor')
  g.wire('mix-cv', 'result', 'mix-acc', 'a')
  g.wire('site-palette-stop-3', 'color', 'mix-acc', 'b')
  g.wire('acc-k', 'result', 'mix-acc', 'factor')
  g.wire('site-palette-stop-0', 'color', 'mix-m', 'a')
  g.wire('mix-acc', 'result', 'mix-m', 'b')
  g.wire('mask', 'result', 'mix-m', 'factor')
  g.wire('mix-m', 'result', 'output', 'color')
}

/** spectra Preset 3 "Worley Ridged" as a site scene (spec §4.2). */
export function buildSiteWorleyRidged(): Graph {
  const g = graphBuilder()
  g.add('site-clock', 'time', 0, 0, { speed: WR_CLOCK_SPEED }, 'site.clock')
  g.add('pixelate', 'pixelate', 0, 1, { pixelSize: WR_CELL_PX })
  g.add('site-seed', 'float_constant', 0, 2, { value: 123 }, 'site.seed')
  // Colour branch: spectra evaluates fieldValue(uv·0.5, t·0.5). Half the coords
  // = twice the warp scale; half the time through an exact ×0.5 Remap.
  g.add('half-clock', 'remap', 1, 3, { inMin: 0, inMax: 1, outMin: 0, outMax: 0.5 })
  g.wire('site-clock', 'time', 'half-clock', 'value')

  const seed: Port = ['site-seed', 'value']
  const field = addWorleyRidgedField(g, '', 0, 'site.warp', ['pixelate', 'uv'], ['site-clock', 'time'], seed, WR_WARP_SCALE)
  const cv = addWorleyRidgedField(g, 'c-', 3, 'site.warp-color', ['pixelate', 'uv'], ['half-clock', 'result'], seed, 2 * WR_WARP_SCALE)
  addSiteTail(g, field, cv)
  return { nodes: g.nodes, edges: g.edges }
}
