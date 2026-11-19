/**
 * Hostile-input gate (security audit 2026-11-16, findings F1 + F2).
 *
 * F1 — node ids / port handles are spliced into shader text; an id from a share
 *      link or .sombra file must never reach it. Proven on ALL FOUR compilers and
 *      the three decoders, with a clean-graph positive control so "rejects
 *      everything" cannot pass.
 * F2 — inflate had no output cap (200 KB -> 200 MB). Proven by (a) the limit
 *      error, (b) PEAK MEMORY staying bounded — that is the mechanism: an
 *      inflate-then-check implementation would also throw, but only after
 *      allocating the whole bomb — and (c) legitimate payloads still round-trip.
 *
 * Run: npx tsx scripts/verify-security-input.ts
 */
import pako from 'pako'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../src/nodes/types'
import { initializeNodeLibrary } from '../src/nodes/index'
import { compileGraph } from '../src/compiler/glsl-generator'
import { compileGraphIR } from '../src/compiler/ir-compiler'
import { compileNodePreview } from '../src/compiler/subgraph-compiler'
import { compileNodePreviewIR } from '../src/compiler/ir-subgraph-compiler'
import { decodeCompactHash, decodeGraphFromHash, importFromFile, decodeSombraPackage } from '../src/utils/sombra-file'
import { decodeArtifactBytes } from '../src/embed/artifact'
import { safeInflate, InflateLimitError, MAX_INFLATED_HASH_BYTES, MAX_INFLATED_FILE_BYTES } from '../src/embed/safe-inflate'

initializeNodeLibrary()
let failures = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  [PASS] ${name}`)
  else { failures++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`) }
}
const throws = (fn: () => unknown) => { try { fn(); return false } catch { return true } }

const EVIL = 'x; } void INJECTED(){ for(;;){} } void y(){ //'
const mk = (id: string, type: string) =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params: {} } }) as Node<NodeData>
const edge = (s: string, t: string, sh = 'value', th = 'color') =>
  ({ id: `${s}-${t}`, source: s, target: t, sourceHandle: sh, targetHandle: th, type: 'typed', data: {} }) as Edge<EdgeData>

function graph(id: string, sh = 'value') {
  return { nodes: [mk(id, 'noise'), mk('out', 'fragment_output')], edges: [edge(id, 'out', sh)] }
}
// Shader output only: the refusal message legitimately quotes the bad id back.
type Result = { success?: boolean; errors?: unknown } | null
const injected = (x: Result) => JSON.stringify({ ...(x ?? {}), errors: undefined }).includes('INJECTED')
const refusedByGuard = (x: Result) => x?.success === false && /Unsafe (node id|port handle)/.test(JSON.stringify(x.errors ?? ''))

console.log('F1 — ids and handles reach shader text only if safe')
{
  const ok = graph('noise-abc-123')
  const g = compileGraph(ok.nodes, ok.edges)
  const w = compileGraphIR(ok.nodes, ok.edges)
  const p = compileNodePreview(ok.nodes, ok.edges, 'noise-abc-123')
  const pi = compileNodePreviewIR(ok.nodes, ok.edges, 'noise-abc-123')
  check('control: clean graph compiles on GLSL', g.success === true)
  check('control: clean graph compiles on WGSL', w !== null)
  check('control: clean graph compiles as GLSL preview', p.success === true)
  check('control: clean graph compiles as WGSL preview', pi.success === true)

  for (const [label, bad] of [['node id', graph(EVIL)], ['port handle', graph('n1', EVIL)]] as const) {
    const g2 = compileGraph(bad.nodes, bad.edges)
    check(`${label}: compileGraph refuses`, refusedByGuard(g2) && !injected(g2))
    const w2 = compileGraphIR(bad.nodes, bad.edges)
    check(`${label}: compileGraphIR refuses`, w2 === null)
    const p2 = compileNodePreview(bad.nodes, bad.edges, bad.nodes[0].id)
    check(`${label}: compileNodePreview refuses`, refusedByGuard(p2) && !injected(p2))
    const pi2 = compileNodePreviewIR(bad.nodes, bad.edges, bad.nodes[0].id)
    check(`${label}: compileNodePreviewIR refuses`, refusedByGuard(pi2) && !injected(pi2))
  }

  const enc = (o: unknown) => Buffer.from(pako.deflate(JSON.stringify(o))).toString('base64url')
  const compact = (id: string) => ({ v: 2, n: [{ i: id, t: 'noise' }, { i: 'o', t: 'fragment_output' }], e: [{ s: id, sh: 'value', t: 'o', th: 'color' }] })
  check('control: clean compact hash decodes', !throws(() => decodeCompactHash(enc(compact('n1')))))
  check('decodeCompactHash rejects unsafe id', throws(() => decodeCompactHash(enc(compact(EVIL)))))
  check('decodeGraphFromHash rejects unsafe id', throws(() => decodeGraphFromHash(enc({ sombra: 1, nodes: [{ id: EVIL, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: 'noise', params: {} } }], edges: [] }))))
  check('importFromFile rejects unsafe id', throws(() => importFromFile({ sombra: 1, nodes: [{ id: EVIL, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: 'noise', params: {} } }], edges: [] })))
}

console.log('F2 — inflate is bounded while streaming')
{
  const mb = (n: number) => n * 1024 * 1024
  const bomb = pako.deflate(new Uint8Array(mb(300)).fill(0x20)) // 300 MB of JSON whitespace
  console.log(`  (bomb: ${bomb.length} bytes compressed -> 300 MB)`)
  const limit = 8 * 1024 * 1024
  const before = process.memoryUsage().rss
  let err: unknown
  try { safeInflate(bomb, limit) } catch (e) { err = e }
  const grewMB = (process.memoryUsage().rss - before) / mb(1)
  check('bomb throws InflateLimitError', err instanceof InflateLimitError)
  // MECHANISM: streaming abort. Inflating all 300 MB first would grow RSS >300 MB.
  check('peak memory stayed bounded (aborted mid-stream)', grewMB < 100, `RSS grew ${grewMB.toFixed(0)} MB`)

  const payload = new TextEncoder().encode(JSON.stringify({ hello: 'world', n: Array.from({ length: 50000 }, (_, i) => i) }))
  const rt = safeInflate(pako.deflate(payload), mb(4))
  check('control: legitimate payload round-trips byte-exact', rt.length === payload.length && rt.every((b, i) => b === payload[i]))
  check('control: payload just under the limit passes, over it fails',
    !throws(() => safeInflate(pako.deflate(payload), payload.length)) && throws(() => safeInflate(pako.deflate(payload), payload.length - 1)))

  // Bombs are VALID JSON (a huge string field), so the only thing that can reject
  // them is the size cap — never a downstream parse error. Each check also
  // requires the "too large" cap message, not merely "something threw".
  const bombJson = (over: number, head: string) =>
    new TextEncoder().encode(head + 'x'.repeat(over) + '"}')
  const capHit = (fn: () => unknown) => { try { fn(); return false } catch (e) { return e instanceof InflateLimitError || /too large/.test(String((e as Error)?.message)) } }
  const hashPayload = pako.deflate(bombJson(MAX_INFLATED_HASH_BYTES + mb(1), '{"v":2,"n":[],"e":[],"pad":"'))
  const hashBomb = Buffer.from(hashPayload).toString('base64url')
  check('control: a 1 MB-padded valid hash is NOT rejected by the cap',
    !capHit(() => decodeCompactHash(Buffer.from(pako.deflate(bombJson(mb(1), '{"v":2,"n":[],"e":[],"pad":"'))).toString('base64url'))))
  check('decodeCompactHash: cap fires on an inflate bomb', capHit(() => decodeCompactHash(hashBomb)))
  const legacyBomb = Buffer.from(pako.deflate(bombJson(MAX_INFLATED_HASH_BYTES + mb(1), '{"sombra":1,"nodes":[],"edges":[],"pad":"'))).toString('base64url')
  check('decodeGraphFromHash: cap fires on an inflate bomb', capHit(() => decodeGraphFromHash(legacyBomb)))
  const fileBomb = pako.deflate(bombJson(MAX_INFLATED_FILE_BYTES + mb(1), '{"v":1,"kind":"frozen","pad":"'))
  check('decodeArtifactBytes: cap fires on an inflate bomb', capHit(() => decodeArtifactBytes(fileBomb)))
  const pkgBomb = new Uint8Array(8 + fileBomb.length)
  pkgBomb.set([0x53, 0x4f, 0x4d, 0x42, 0x52, 0x41, 0x00, 1]) // SOMBRA\0 + package version 1
  pkgBomb.set(fileBomb, 8)
  check('decodeSombraPackage: cap fires on an inflate bomb', capHit(() => decodeSombraPackage(pkgBomb)))
  check('oversized encoded hash rejected before atob', capHit(() => decodeCompactHash('A'.repeat(9 * 1024 * 1024))))
}

console.log(failures ? `\n${failures} FAILED` : '\nAll security input checks passed')
process.exit(failures ? 1 : 0)
