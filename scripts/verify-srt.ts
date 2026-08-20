/**
 * Regression gate for the SRT single-source op-list (src/compiler/ir/srt.ts).
 * (docs/research/2026-08-20-srt-api-design-spec.md — see its decision log.)
 *
 * ONE STORAGE model: srt_translateX/Y always store the WORLD-frame offset and
 * the shader has exactly ONE translate semantic (translate applied in the world
 * frame, before the anchor/scale/rotate block). The Offset Space param
 * ('world'/'node') is a VIEW/edit mode that never reaches codegen. This gate
 * asserts:
 *   A. single source — GLSL and WGSL emit the SAME op order (only syntax differs).
 *   B. single semantic — translate lands in the opening decl and is applied
 *      exactly ONCE (the retired node-frame application after rotate is gone).
 *   C. emit is byte-pinned to the canonical world lowering.
 *   D. exposeTranslateSpace reaches node params for exactly the exposed nodes,
 *      with World/node values, default world.
 *   E. frame conversions (edit layer + migration math): known numeric case +
 *      world↔node round-trips, including non-uniform scale.
 *   F. load-time migration (srt-migration.ts): pre-one-storage saves convert
 *      ('convert' mode), localStorage stamps without touching values
 *      ('stamp-only'), canonical saves untouched (idempotent), hand-rolled SRT
 *      types untouched, and the migrating-type list cannot drift from the
 *      registry's spatial configs.
 *
 * Run: npx tsx scripts/verify-srt.ts
 */
import type { Node } from '@xyflow/react'
import { emitSRT, normalizeTranslateSpace, worldOffsetToNode, nodeOffsetToWorld } from '../src/compiler/ir/srt'
import type { IRSpatialTransform } from '../src/compiler/ir/types'
import type { NodeData } from '../src/nodes/types'
import { ALL_NODES, initializeNodeLibrary } from '../src/nodes/index'
import { migrateOffsetSpace, FRAMEWORK_SPATIAL_TRANSLATE_TYPES } from '../src/utils/srt-migration'
import { importFromFile, exportToFile, encodeCompactHash, decodeCompactHash } from '../src/utils/sombra-file'
import { resolveSRT } from '../src/compiler/ir/srt-resolve'
import pako from 'pako'

let failures = 0
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${cond ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps

const full = (): IRSpatialTransform => ({
  coordsVar: 'C', outputVar: 'V',
  scaleUniform: 'S', rotateUniform: 'R',
  translateXUniform: 'TX', translateYUniform: 'TY',
})

/** Tag each line by which op it is, so GLSL and WGSL can be compared structurally. */
function ops(lines: string[]): string[] {
  return lines.map((l) => {
    if (/TX/.test(l) && /C\b/.test(l)) return 'start+translate' // world decl includes translate
    if (/=\s*C\b/.test(l) || /=\s*C /.test(l)) return 'start'
    if (/-= u_anchor/.test(l)) return 'subAnchor'
    if (/\/=/.test(l)) return 'scale'
    if (/_rad/.test(l) && /0\.01745329/.test(l)) return 'rotate:rad'
    if (/cos\(/.test(l)) return 'rotate:cs'
    if (/\.x \* V_c/.test(l)) return 'rotate:apply'
    if (/TX/.test(l)) return 'translate'
    if (/\+= u_anchor/.test(l)) return 'addAnchor'
    return 'other'
  })
}

console.log('\nA. single source — GLSL and WGSL emit the same op order')
{
  const g = ops(emitSRT(full(), 'glsl'))
  const w = ops(emitSRT(full(), 'wgsl'))
  check('op order identical across backends', JSON.stringify(g) === JSON.stringify(w), `glsl=${g} wgsl=${w}`)
}

console.log('\nB. single semantic — translate applied once, in the opening decl')
{
  const lines = emitSRT(full(), 'wgsl')
  check('translate in the opening decl (world frame, before subAnchor)', /TX/.test(lines[0]) && /C\b/.test(lines[0]))
  const translateLines = lines.filter((l) => /TX/.test(l))
  check('translate applied exactly ONCE (node-frame application retired)', translateLines.length === 1,
    `found ${translateLines.length}: ${JSON.stringify(translateLines)}`)
  const cosIdx = lines.findIndex((l) => /cos\(/.test(l))
  check('no translate after rotate', !lines.some((l, i) => i > cosIdx && /TX/.test(l)))
}

console.log('\nC. emit byte-pinned to the canonical world lowering')
{
  const expected = [
    'var V: vec2f = C - vec2f(TX, -(TY)) / (u_dpr * u_ref_size);',
    'V -= u_anchor;',
    'V /= vec2f(S);',
    'let V_rad: f32 = R * 0.01745329;',
    'let V_c: f32 = cos(V_rad); let V_s: f32 = sin(V_rad);',
    'V = vec2f(V.x * V_c - V.y * V_s, V.x * V_s + V.y * V_c);',
    'V += u_anchor;',
  ]
  const got = emitSRT(full(), 'wgsl')
  check('WGSL matches the canonical world lines', JSON.stringify(got) === JSON.stringify(expected),
    `\n    got: ${JSON.stringify(got)}\n    exp: ${JSON.stringify(expected)}`)
}

console.log('\nD. the coords view is GLOBAL — no node carries an Offset Space param')
// The World/node view lives on settingsStore.gizmoView (GizmoViewControl),
// decoupled from nodes. A node param reappearing here means the retired
// per-node control leaked back in.
{
  for (const n of ALL_NODES) {
    const p = n.params?.find((x) => x.id === 'srt_translateSpace')
    if (p) check(`${n.type}: must not carry srt_translateSpace`, false, 'the view is global (gizmoView)')
  }
  check('no node declares srt_translateSpace', ALL_NODES.every((n) => !n.params?.some((x) => x.id === 'srt_translateSpace')))
  check("normalize('screen') === 'world' (legacy alias)", normalizeTranslateSpace('screen') === 'world')
  check("normalize('local') === 'node' (legacy alias)", normalizeTranslateSpace('local') === 'node')
  check("normalize(undefined) === 'world' (default)", normalizeTranslateSpace(undefined) === 'world')
}

console.log('\nE. frame conversions (view/edit + migration math)')
{
  // Known case (live-verified in the renderer sandbox): rot 30°, scale 1,
  // world (120, 0) reads as node (103.92, −60).
  const n = worldOffsetToNode(120, 0, 30, 1, 1)
  check('world (120,0) @ rot30 → node (103.92, −60)', approx(n.tx, 103.92, 0.01) && approx(n.ty, -60, 0.01),
    `got (${n.tx}, ${n.ty})`)
  const w = nodeOffsetToWorld(n.tx, n.ty, 30, 1, 1)
  check('…and round-trips back to (120, 0)', approx(w.tx, 120) && approx(w.ty, 0), `got (${w.tx}, ${w.ty})`)
  // Non-uniform scale round-trip (uv_transform uses scaleXY)
  const w2 = nodeOffsetToWorld(10, 0, 90, 2, 3)
  const n2 = worldOffsetToNode(w2.tx, w2.ty, 90, 2, 3)
  check('non-uniform scale round-trips (10,0) @ rot90 sx2 sy3', approx(n2.tx, 10) && approx(n2.ty, 0),
    `world=(${w2.tx},${w2.ty}) back=(${n2.tx},${n2.ty})`)
  // Degenerate scale must not produce non-finite view values
  const g = worldOffsetToNode(50, 20, 45, 0, 0)
  check('degenerate scale view is finite', Number.isFinite(g.tx) && Number.isFinite(g.ty))
}

console.log('\nF. load-time migration (srt-migration.ts)')
{
  const mk = (type: string, params: Record<string, unknown>): Node<NodeData> =>
    ({ id: `${type}-t`, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params } }) as Node<NodeData>
  const P = (n: Node<NodeData>) => n.data.params as Record<string, unknown>

  // convert mode: missing key = main-era node-semantics save → values convert
  {
    const r = migrateOffsetSpace([mk('stripes', { srt_translateX: 120, srt_translateY: 0, srt_rotate: 30, srt_scale: 2 })], 'convert')
    const p = P(r.nodes[0])
    const exp = nodeOffsetToWorld(120, 0, 30, 2, 2)
    check('convert: missing key → offsets converted node→world',
      approx(p.srt_translateX as number, exp.tx) && approx(p.srt_translateY as number, exp.ty),
      `got (${p.srt_translateX}, ${p.srt_translateY}) exp (${exp.tx}, ${exp.ty})`)
    check("convert: missing key → stamped 'world'", p.srt_translateSpace === 'world')
    check('convert: reports migrated', r.migrated === 1)
  }
  // stamp-only mode: values untouched (localStorage rendered world all along)
  {
    const r = migrateOffsetSpace([mk('stripes', { srt_translateX: 120, srt_translateY: 0, srt_rotate: 30, srt_scale: 2 })], 'stamp-only')
    const p = P(r.nodes[0])
    check('stamp-only: values untouched', p.srt_translateX === 120 && p.srt_translateY === 0)
    check("stamp-only: stamped 'world'", p.srt_translateSpace === 'world')
  }
  // legacy 'local' (QA-era node shader semantics) → convert, keep the view as 'node'
  {
    const r = migrateOffsetSpace([mk('dots', { srt_translateX: 120, srt_translateY: 0, srt_rotate: 30, srt_scale: 1, srt_translateSpace: 'local' })], 'stamp-only')
    const p = P(r.nodes[0])
    const exp = nodeOffsetToWorld(120, 0, 30, 1, 1)
    check("'local' → converted even in stamp-only (explicit node semantics)",
      approx(p.srt_translateX as number, exp.tx) && approx(p.srt_translateY as number, exp.ty),
      `got (${p.srt_translateX}, ${p.srt_translateY})`)
    check("'local' → view preserved as 'node'", p.srt_translateSpace === 'node')
  }
  // legacy 'screen' (QA-era world shader semantics) → rename only
  {
    const r = migrateOffsetSpace([mk('noise', { srt_translateX: 40, srt_translateY: 5, srt_scale: 3, srt_translateSpace: 'screen' })], 'convert')
    const p = P(r.nodes[0])
    check("'screen' → values untouched, renamed 'world'",
      p.srt_translateX === 40 && p.srt_translateY === 5 && p.srt_translateSpace === 'world')
  }
  // canonical saves untouched → idempotent
  {
    const canonical = mk('stripes', { srt_translateX: 7, srt_translateY: 8, srt_rotate: 45, srt_scale: 2, srt_translateSpace: 'node' })
    const r = migrateOffsetSpace([canonical], 'convert')
    check('idempotent: canonical save untouched', r.migrated === 0 && r.nodes[0] === canonical)
  }
  // hand-rolled SRT types never migrate
  {
    const reeded = mk('reeded_glass', { srt_translateX: 100, srt_rotate: 45, srt_scale: 2 })
    const r = migrateOffsetSpace([reeded], 'convert')
    check('reeded_glass (hand-rolled SRT) untouched', r.migrated === 0 && r.nodes[0] === reeded)
  }
  // drift gate: the hardcoded list must equal the registry's framework-spatial
  // translate nodes — adding/removing spatial: on a node without updating the
  // migration list fails here.
  {
    const fromRegistry = new Set(
      ALL_NODES.filter((n) => n.spatial?.transforms.some((t) => t === 'translate')).map((n) => n.type),
    )
    const a = [...fromRegistry].sort().join(',')
    const b = [...FRAMEWORK_SPATIAL_TRANSLATE_TYPES].sort().join(',')
    check('migration list matches registry spatial configs', a === b, `registry=[${a}] list=[${b}]`)
  }
}

console.log('\nG. file/share formats route through the migration (version-fingerprinted)')
{
  initializeNodeLibrary()
  const mkFileNode = (id: string, type: string, params: Record<string, unknown>) =>
    ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params } })
  const legacyParams = { srt_translateX: 120, srt_translateY: 0, srt_rotate: 30, srt_scale: 2, width: 40, gap: 40 }
  const expW = nodeOffsetToWorld(120, 0, 30, 2, 2)
  const getP = (nodes: Node<NodeData>[], id: string) => nodes.find((n) => n.id === id)!.data.params as Record<string, unknown>

  // .sombra v2 (pre-one-storage): offsets convert; the defaults merge must not
  // have destroyed the missing-key signal (regression: it did, live).
  {
    const r = importFromFile({ sombra: 2, nodes: [mkFileNode('a', 'stripes', { ...legacyParams })], edges: [] })
    const p = getP(r.nodes, 'a')
    check('.sombra v2: offsets converted node→world',
      approx(p.srt_translateX as number, expW.tx) && approx(p.srt_translateY as number, expW.ty),
      `got (${p.srt_translateX}, ${p.srt_translateY}) exp (${expW.tx}, ${expW.ty})`)
    check(".sombra v2: stamped 'world'", p.srt_translateSpace === 'world')
  }
  // .sombra v3 (one-storage): values untouched
  {
    const r = importFromFile({ sombra: 3, nodes: [mkFileNode('a', 'stripes', { ...legacyParams, srt_translateSpace: 'world' })], edges: [] })
    const p = getP(r.nodes, 'a')
    check('.sombra v3: values untouched', p.srt_translateX === 120 && p.srt_translateY === 0)
  }
  // exportToFile now writes v3
  check('exportToFile writes sombra: 3', exportToFile([], []).sombra === 3)
  // Compact round-trip of a canonical world graph is lossless — the encoder
  // strips default params; v2 decode must NOT misread that as legacy.
  {
    // The encoder keeps only nodes wired to the Fragment Output — include one.
    const nodes = [
      mkFileNode('c', 'stripes', { ...legacyParams, srt_translateSpace: 'world' }),
      mkFileNode('out', 'fragment_output', {}),
    ] as Node<NodeData>[]
    const edges = [{ id: 'e1', source: 'c', target: 'out', sourceHandle: 'color', targetHandle: 'color' }] as never[]
    const r = decodeCompactHash(encodeCompactHash(nodes, edges))
    const p = getP(r.nodes, 'c')
    check('compact v2 round-trip: offsets lossless (no double conversion)',
      p.srt_translateX === 120 && p.srt_translateY === 0 && p.srt_translateSpace === 'world',
      `got (${p.srt_translateX}, ${p.srt_translateY}, ${p.srt_translateSpace})`)
  }
  // Hand-built compact v1 (legacy share URL): stripped default must not mask
  // the missing key — offsets convert.
  {
    const compact = { v: 1, n: [{ i: 'l1', t: 'stripes', p: { srt_translateX: 120, srt_rotate: 30, srt_scale: 2 } }], e: [] }
    const bytes = pako.deflate(new TextEncoder().encode(JSON.stringify(compact)))
    const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const r = decodeCompactHash(b64)
    const p = getP(r.nodes, 'l1')
    check('compact v1: offsets converted node→world',
      approx(p.srt_translateX as number, expW.tx) && approx(p.srt_translateY as number, expW.ty),
      `got (${p.srt_translateX}, ${p.srt_translateY}) exp (${expW.tx}, ${expW.ty})`)
    check("compact v1: stamped 'world'", p.srt_translateSpace === 'world')
  }
}

console.log('\nH. resolveSRT — the gizmo API (all math encapsulated)')
{
  const T: ReadonlyArray<'scale' | 'rotate' | 'translate'> = ['scale', 'rotate', 'translate']
  // world axes are the canvas axes (css y-down, +Y param = up = −y css)
  {
    const r = resolveSRT({ srt_translateSpace: 'world', srt_rotate: 30, srt_scale: 2 }, { transforms: T })
    check('world axes are canvas axes regardless of rotate/scale',
      r.axes.x.x === 1 && r.axes.x.y === 0 && r.axes.y.x === 0 && r.axes.y.y === -1)
  }
  // options.space (the GLOBAL switch) overrides any stored param value
  {
    const r = resolveSRT({ srt_translateSpace: 'node', srt_rotate: 30, srt_scale: 1 }, { transforms: T, space: 'world' })
    check('options.space overrides the stored param (global switch wins)',
      r.space === 'world' && r.axes.x.x === 1 && r.axes.x.y === 0)
  }
  // node axes: rotated content directions; must match the slider conversion math
  {
    const r = resolveSRT({ srt_translateSpace: 'node', srt_rotate: 30, srt_scale: 1 }, { transforms: T })
    const w = nodeOffsetToWorld(1, 0, 30, 1, 1) // css dir = (tx, −ty)
    const len = Math.hypot(w.tx, w.ty)
    check('node X axis == normalized css direction of a node-frame +X offset',
      approx(r.axes.x.x, w.tx / len) && approx(r.axes.x.y, -w.ty / len),
      `axis (${r.axes.x.x}, ${r.axes.x.y}) conv (${w.tx / len}, ${-w.ty / len})`)
    const rw = resolveSRT({ srt_translateSpace: 'world', srt_rotate: 30, srt_scale: 1 }, { transforms: T })
    check('node axes ≠ world axes when rotated (mechanism-engaged)',
      !approx(r.axes.x.x, rw.axes.x.x) || !approx(r.axes.x.y, rw.axes.x.y))
  }
  // originOffset: world offset (10,5) → css (10,−5) from the anchor point
  {
    const r = resolveSRT({ srt_translateX: 10, srt_translateY: 5 }, { transforms: T })
    check('originOffset flips Y (params +Y = up, css y-down)', r.originOffset.x === 10 && r.originOffset.y === -5)
  }
  // free drag follows the cursor: css (3,−4) → world (+3, +4)
  {
    const r = resolveSRT({ srt_translateX: 10, srt_translateY: 5 }, { transforms: T })
    const p = r.dragTranslate(3, -4, 'free')
    check('free drag: css (3,−4) → params (13, 9)', p.srt_translateX === 13 && p.srt_translateY === 9,
      `got (${p.srt_translateX}, ${p.srt_translateY})`)
  }
  // constrained node-X drag at rot 90°: node X ≈ css (0,−1); css (5,−10) projects to k=10 → up 10
  {
    const r = resolveSRT({ srt_translateX: 10, srt_translateY: 5, srt_rotate: 90, srt_scale: 1, srt_translateSpace: 'node' }, { transforms: T })
    const p = r.dragTranslate(5, -10, 'x')
    check('node-X constrained drag @ rot90 moves along the rotated axis only',
      approx(p.srt_translateX, 10) && approx(p.srt_translateY, 15),
      `got (${p.srt_translateX}, ${p.srt_translateY})`)
  }
  // rotate mapping: handle css angle −θ; drag −30° css → θ=30; Shift snaps 37→30
  {
    const r = resolveSRT({ srt_rotate: 30, srt_scale: 1 }, { transforms: T })
    check('rotate handle sits at css angle −θ', approx(r.rotateHandleAngle, -30 * Math.PI / 180))
    check('dragRotate(−30° css) → 30', r.dragRotate(-30 * Math.PI / 180).srt_rotate === 30)
    check('dragRotate snap15: 37° → 30', r.dragRotate(-37 * Math.PI / 180, true).srt_rotate === 30)
  }
  // scale mapping: dist/base, clamped, step-rounded; scaleXY writes both axes
  {
    const r = resolveSRT({ srt_scale: 1 }, { transforms: T })
    check('dragScale(80, 40) → 2', r.dragScale(80, 40).srt_scale === 2)
    const rxy = resolveSRT({ srt_scaleX: 1, srt_scaleY: 1 }, { transforms: ['scaleXY', 'rotate', 'translate'] })
    const p = rxy.dragScale(60, 40)
    check('scaleXY: uniform handle writes both axes', p.srt_scaleX === 1.5 && p.srt_scaleY === 1.5)
  }
  // cssPerPx: offsets displace content in BUFFER px (auto_uv's u_dpr divisor),
  // so on-screen CSS displacement = offset × rect/buffer. Retina (0.5):
  // originOffset halves; a css drag doubles into params so content tracks 1:1.
  {
    const r = resolveSRT({ srt_translateX: 10, srt_translateY: 5 }, { transforms: T, cssPerPx: 0.5 })
    check('cssPerPx 0.5: originOffset halves', r.originOffset.x === 5 && r.originOffset.y === -2.5)
    const p = r.dragTranslate(3, -4, 'free')
    check('cssPerPx 0.5: css drag (3,−4) → params (16, 13)', p.srt_translateX === 16 && p.srt_translateY === 13,
      `got (${p.srt_translateX}, ${p.srt_translateY})`)
    const d = resolveSRT({ srt_translateX: 10 }, { transforms: T, cssPerPx: 0 })
    check('degenerate cssPerPx falls back to 1', d.originOffset.x === 10)
  }
}

console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? '  SUMMARY: all SRT checks passed' : `  SUMMARY: ${failures} FAILED`)
console.log('='.repeat(60))
process.exit(failures === 0 ? 0 : 1)
