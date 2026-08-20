/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SRT conformity auditor — the ratchet against SRT dialects.
 * (Born 2026-08-21 after QA found FIVE ways nodes treat SRT: framework world /
 * image's y-up screen_uv / warp's internal hand-rolled copy / reeded's three
 * mixed-parity hand-rolls / gradient parked. See the SRT design spec.)
 *
 * CONFORMITY = a spatial node declares `spatial:` and consumes ONE coordinate
 * contract: coords default 'auto_uv', SRT applied only by the framework
 * (emitSRT). The node body never reads srt_* inputs and never hand-rolls a
 * coordinate origin.
 *
 * Mechanics (both codegen paths, every enum branch one-at-a-time):
 *  1. srt_* params without `spatial:`            → hand-rolled SRT ownership
 *  2. spatial node whose coords default ≠ auto_uv → alien coordinate space
 *  3. body text references an srt_* input marker → node consumes SRT itself
 *  4. body text hand-rolls an origin (gl_FragCoord / in.position)
 *
 * RATCHET: KNOWN_DEVIATIONS lists what's allowed today, each with its planned
 * kill. A NEW deviation fails the gate. An allowlisted deviation that no
 * longer reproduces ALSO fails — shrink the list when a migration lands.
 *
 * Run: npx tsx scripts/verify-srt-conformity.ts
 */
import { ALL_NODES, initializeNodeLibrary } from '../src/nodes/index'
import type { NodeDefinition } from '../src/nodes/types'

initializeNodeLibrary()

// deviation kinds → detector output
type Deviation = 'no-spatial-config' | 'alien-coord-space' | 'body-consumes-srt' | 'hand-rolled-origin'

/** The shrink-only allowlist. Kill order: warp → image → reeded (spec step 5). */
const KNOWN_DEVIATIONS: Record<string, { allowed: Deviation[]; kill: string }> = {
  image: {
    allowed: ['alien-coord-space'],
    kill: 'migrate image onto the y-down auto_uv coordinate contract',
  },
  warp: {
    allowed: ['body-consumes-srt', 'hand-rolled-origin'],
    kill: "delete warp's internal noise-coords SRT copy (texture mode also hand-rolls auto_uv); use the framework coord",
  },
  reeded_glass: {
    allowed: ['no-spatial-config', 'body-consumes-srt', 'hand-rolled-origin'],
    kill: 'reeded framework migration (spec step 5): spatial: + emitSRT, delete 3 hand-rolls',
  },
}

const SRT_MARKER = (id: string) => `__SRT_MRK_${id}__`
const ORIGIN_RE = /gl_FragCoord|in\.position/

/** Emit a node's GLSL body + IR JSON for one param assignment. An emission
 *  that THROWS makes the node unauditable — that is itself a gate failure
 *  (a swallowed throw here silently hid warp's and reeded's deviations). */
function emitTexts(def: NodeDefinition, params: Record<string, unknown>): { texts: string[]; errors: string[] } {
  const inputs: Record<string, string> = {}
  for (const inp of def.inputs ?? []) inputs[inp.id] = `__in_${inp.id}__`
  for (const p of def.params ?? []) {
    if ((p as any).connectable) inputs[p.id] = p.id.startsWith('srt_') ? SRT_MARKER(p.id) : `__in_${p.id}__`
  }
  const outputs: Record<string, string> = {}
  for (const out of def.outputs ?? []) outputs[out.id] = `__out_${out.id}__`
  const mkCtx = (textureMode: boolean): any => {
    const textureSamplers: Record<string, string> = {}
    if (textureMode) {
      for (const inp of def.inputs ?? []) {
        if ((inp as any).textureInput) textureSamplers[inp.id] = `u_audit_${inp.id}`
      }
    }
    return {
      inputs: { ...inputs }, outputs, params,
      nodeId: 'audit-node', uniforms: new Set<string>(),
      functions: [], functionRegistry: new Map<string, string>(),
      textureSamplers, imageSamplers: new Set<string>(), isPreview: false,
      // shared-helper bodies are global-safe (noise tables) — not scanned
      addFunction: () => {},
    }
  }
  const texts: string[] = []
  const errors: string[] = []
  // Texture-input nodes branch on texture mode (warp hides its hand-rolled
  // SRT copy behind it) — emit BOTH modes.
  const modes = (def.inputs ?? []).some((i) => (i as any).textureInput) ? [false, true] : [false]
  for (const mode of modes) {
    try { const g = def.glsl?.(mkCtx(mode)); if (typeof g === 'string') texts.push(g) } catch (e) { errors.push(`glsl(tex=${mode}): ${(e as Error).message}`) }
    try { const ir = def.ir?.(mkCtx(mode)); if (ir) texts.push(JSON.stringify((ir as any).statements ?? ir)) } catch (e) { errors.push(`ir(tex=${mode}): ${(e as Error).message}`) }
  }
  return { texts, errors }
}

/** All param assignments to scan: defaults + each enum option one-at-a-time. */
function paramVariants(def: NodeDefinition): Record<string, unknown>[] {
  const base: Record<string, unknown> = {}
  for (const p of def.params ?? []) base[p.id] = p.default
  const variants = [base]
  for (const p of def.params ?? []) {
    if (p.type === 'enum' && p.options) {
      for (const o of p.options) {
        if (o.value !== p.default) variants.push({ ...base, [p.id]: o.value })
      }
    }
  }
  return variants
}

function detect(def: NodeDefinition): { found: Set<Deviation>; unauditable: string[] } {
  const found = new Set<Deviation>()
  const unauditable: string[] = []
  const hasSrtParams = !!def.params?.some((p) => p.id.startsWith('srt_'))
  if (hasSrtParams && !def.spatial) found.add('no-spatial-config')
  if (def.spatial) {
    const coords = def.inputs?.find((i) => i.id === 'coords')
    if (coords?.default !== 'auto_uv') found.add('alien-coord-space')
  }
  if (hasSrtParams || def.spatial) {
    for (const params of paramVariants(def)) {
      const { texts, errors } = emitTexts(def, params)
      unauditable.push(...errors)
      for (const text of texts) {
        if (text.includes('__SRT_MRK_')) found.add('body-consumes-srt')
        if (ORIGIN_RE.test(text)) found.add('hand-rolled-origin')
      }
    }
  }
  return { found, unauditable }
}

let failures = 0
const rows: string[] = []
for (const def of ALL_NODES) {
  const { found, unauditable } = detect(def)
  for (const err of [...new Set(unauditable)]) {
    console.log(`  [FAIL] ${def.type}: unauditable — emission threw (${err}). Fix the audit ctx; a swallowed throw is a hidden deviation.`)
    failures++
  }
  const allowed = new Set(KNOWN_DEVIATIONS[def.type]?.allowed ?? [])
  const fresh = [...found].filter((d) => !allowed.has(d))
  const stale = [...allowed].filter((d) => !found.has(d))
  if (found.size || allowed.size) {
    rows.push(`  ${found.size ? '⚠' : ' '} ${def.type}: ${[...found].join(', ') || 'conforming'}${
      KNOWN_DEVIATIONS[def.type] ? `  [allowed — kill: ${KNOWN_DEVIATIONS[def.type].kill}]` : ''}`)
  }
  for (const d of fresh) {
    console.log(`  [FAIL] ${def.type}: NEW SRT deviation '${d}' — nodes must consume the framework SRT (emitSRT + auto_uv). If migrating an old node, update KNOWN_DEVIATIONS with a kill plan.`)
    failures++
  }
  for (const d of stale) {
    console.log(`  [FAIL] ${def.type}: allowlisted deviation '${d}' no longer reproduces — shrink KNOWN_DEVIATIONS (the ratchet only tightens).`)
    failures++
  }
}
// allowlist entries for node types that no longer exist
for (const type of Object.keys(KNOWN_DEVIATIONS)) {
  if (!ALL_NODES.some((n) => n.type === type)) {
    console.log(`  [FAIL] KNOWN_DEVIATIONS lists unknown node type '${type}'`)
    failures++
  }
}

console.log('\nSRT dialect audit:')
for (const r of rows) console.log(r)
console.log('\n' + '='.repeat(60))
console.log(failures === 0
  ? `  SUMMARY: SRT conformity holds (${Object.keys(KNOWN_DEVIATIONS).length} known deviations pending migration)`
  : `  SUMMARY: ${failures} FAILED`)
console.log('='.repeat(60))
process.exit(failures === 0 ? 0 : 1)
