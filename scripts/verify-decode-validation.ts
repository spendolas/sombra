/**
 * Decode-validation gate (security audit F3 + F4 + image-size bomb).
 *  A. image guard: only base64 png/jpeg/webp/gif data URLs; declared size read from the
 *     header and refused when oversize, BEFORE any decode. Each hostile case has a
 *     legitimate control, and the refusal REASON is asserted (not just "rejected").
 *  B. graph sanitizer: node/edge caps, __proto__ keys, wrongly-typed params reset, unsafe
 *     imageData dropped — while unknown keys, enums and valid values are left untouched.
 *  C. artifact shape check at decode.
 *  D. player + viewer sinks actually call the guard before `img.src =` (source assertion,
 *     because mount() needs a DOM; perturb it and this check fails).
 * Run: npx tsx scripts/verify-decode-validation.ts
 */
import { readFileSync } from 'fs'
import pako from 'pako'
import { initializeNodeLibrary } from '../src/nodes/index'
import { nodeRegistry } from '../src/nodes/registry'
import { decodeCompactHash, importFromFile } from '../src/utils/sombra-file'
import { MAX_GRAPH_NODES } from '../src/utils/sanitize-graph'
import { checkImageDataUrl } from '../src/embed/image-guard'
import { decodeArtifactBytes, MAX_ARTIFACT_PASSES } from '../src/embed/artifact'

initializeNodeLibrary()
let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`  [PASS] ${name}`)
  else { failures++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`) }
}
const b64 = (b: number[]) => Buffer.from(b).toString('base64')
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const pad = (b: number[], n = 66) => [...b, ...new Array(Math.max(0, n - b.length)).fill(0)]
const png = (w: number, h: number) => `data:image/png;base64,${b64(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h)]))}`
const webpX = (w: number, h: number) => { const a = w - 1, c = h - 1; return `data:image/webp;base64,${b64(pad([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0, 0, 0, 0, a & 255, (a >> 8) & 255, (a >> 16) & 255, c & 255, (c >> 8) & 255, (c >> 16) & 255]))}` }
const jpeg = (w: number, h: number) => `data:image/jpeg;base64,${b64(pad([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]))}`
const reason = (u: unknown) => { const r = checkImageDataUrl(u); return r.ok ? 'OK' : r.reason }

console.log('A. image guard')
check('control: 1x1 PNG accepted', reason(png(1, 1)) === 'OK')
check('control: 4096x4096 PNG (the editor\'s own cap) accepted', reason(png(4096, 4096)) === 'OK')
check('control: 8192x8192 WebP accepted', reason(webpX(8192, 8192)) === 'OK')
check('control: 4000x3000 JPEG accepted', reason(jpeg(4000, 3000)) === 'OK')
{
  // Real case: shaders/underwear.sombra embeds a 5504x3072 PNG as a 67.7M-character data URL.
  const head = png(5504, 3072)
  const big = head + 'A'.repeat(67_700_000 - head.length)
  check('control: legitimate 67.7M-char 5504x3072 PNG accepted (real shipped file)', reason(big) === 'OK', reason(big))
  const over = head + 'A'.repeat(97 * 1024 * 1024 - head.length)
  check('data URL over the character cap refused', reason(over) === 'too large', reason(over))
}
check('PNG declaring 30000x30000 refused (edge)', /edge over/.test(reason(png(30000, 30000))), reason(png(30000, 30000)))
check('PNG 16384x16384 refused (pixels)', /pixels/.test(reason(png(16384, 16384))), reason(png(16384, 16384)))
check('WebP declaring 30000 wide refused', /edge over/.test(reason(webpX(30000, 10))), reason(webpX(30000, 10)))
check('JPEG declaring 40000 wide refused', /edge over/.test(reason(jpeg(40000, 10))), reason(jpeg(40000, 10)))
check('remote URL refused', /not a base64/.test(reason('https://evil.example/pixel.png')))
check('javascript: URL refused', /not a base64/.test(reason('javascript:alert(1)')))
check('svg data URL refused', /not a base64/.test(reason('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')))
check('non-base64 data URL refused', /not a base64/.test(reason('data:image/png,abc')))
check('garbage header refused (unreadable)', /unreadable/.test(reason('data:image/png;base64,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')))
check('non-string refused', reason(42) === 'not a string')

console.log('B. graph sanitizer')
const enc = (o: unknown) => Buffer.from(pako.deflate(JSON.stringify(o).replace('"PROTO"', '"__proto__"'))).toString('base64url')
const compact = (n: unknown[], e: unknown[] = []) => enc({ v: 2, n, e })
const noiseScale = nodeRegistry.get('noise')!.params.find((p) => p.id === 'seed')!
check('precondition: noise.seed is a numeric float param', noiseScale.type === 'float' && typeof noiseScale.default === 'number')
{
  const r = decodeCompactHash(compact([{ i: 'a', t: 'noise', p: { seed: 'EVIL', phase: 7, foo: { bar: 1 }, PROTO: { polluted: 'yes' } } }]))
  const p = r.nodes[0].data.params as Record<string, unknown>
  check('wrongly-typed float param reset to its default', p.seed === noiseScale.default, String(p.seed))
  check('control: valid param value kept', p.phase === 7)
  check('control: unknown key preserved', JSON.stringify(p.foo) === '{"bar":1}')
  check('__proto__ key not applied to params', Object.getPrototypeOf(p) === Object.prototype && (p as { polluted?: string }).polluted === undefined)
  const ok = decodeCompactHash(compact([{ i: 'a', t: 'noise', p: { seed: 3.5 } }]))
  check('control: valid seed value unchanged', (ok.nodes[0].data.params as Record<string, unknown>).seed === 3.5)
  const nan = decodeCompactHash(compact([{ i: 'a', t: 'noise', p: { seed: null } }]))
  check('null in a float param reset to default', (nan.nodes[0].data.params as Record<string, unknown>).seed === noiseScale.default)
}
{
  const img = (u: string) => (decodeCompactHash(compact([{ i: 'im', t: 'image', p: { imageData: u } }])).nodes[0].data.params as Record<string, unknown>).imageData
  check('control: safe imageData kept', img(png(64, 64)) === png(64, 64))
  check('remote imageData URL dropped', img('https://evil.example/p.png') === undefined)
  check('giant-dimension imageData dropped', img(png(30000, 30000)) === undefined)
}
{
  const many = (n: number) => Array.from({ length: n }, (_, k) => ({ i: 'n' + k, t: 'noise' }))
  check(`control: ${MAX_GRAPH_NODES} nodes accepted`, (() => { try { decodeCompactHash(compact(many(MAX_GRAPH_NODES))); return true } catch { return false } })())
  check(`${MAX_GRAPH_NODES + 1} nodes refused (cap)`, (() => { try { decodeCompactHash(compact(many(MAX_GRAPH_NODES + 1))); return false } catch (e) { return /too many nodes/.test(String((e as Error).message)) } })())
}

{
  // .sombra FILE import is a separate code path from share links; cover it directly.
  const node = (params: Record<string, unknown>) => ({ id: 'im', type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: 'image', params } })
  const file = (params: Record<string, unknown>) => importFromFile({ sombra: 3, nodes: [node(params)], edges: [] }).nodes[0].data.params as Record<string, unknown>
  const ok = file({ imageData: png(64, 64), imageName: 'cat.png', imageAspect: 1 })
  check('control (file import): image, filename and aspect survive', ok.imageData === png(64, 64) && ok.imageName === 'cat.png' && ok.imageAspect === 1)
  check('file import: remote imageData dropped', file({ imageData: 'https://evil.example/p.png' }).imageData === undefined)
  const noiseFile = importFromFile({ sombra: 3, nodes: [{ ...node({ seed: 'EVIL' }), id: 'nz', data: { type: 'noise', params: { seed: 'EVIL' } } }], edges: [] }).nodes[0].data.params as Record<string, unknown>
  check('file import: wrongly-typed visible param reset to default', noiseFile.seed === noiseScale.default, String(noiseFile.seed))
  // JSON.parse makes "__proto__" a real OWN key (unlike Object.assign, which swallows it),
  // so this is the path that actually needs the filter.
  const protoFile = importFromFile(JSON.parse('{"sombra":3,"edges":[],"nodes":[{"id":"nz","type":"shaderNode","position":{"x":0,"y":0},"data":{"type":"noise","params":{"seed":5,"__proto__":{"polluted":"yes"}}}}]}')).nodes[0].data.params as Record<string, unknown>
  check('file import: own __proto__ key does not change the params prototype', Object.getPrototypeOf(protoFile) === Object.prototype && (protoFile as { polluted?: string }).polluted === undefined)
  check('control (file import): other params beside __proto__ kept', protoFile.seed === 5)
  check('file import: node cap enforced', (() => { try { importFromFile({ sombra: 3, nodes: Array.from({ length: MAX_GRAPH_NODES + 1 }, (_, k) => ({ ...node({}), id: 'n' + k })), edges: [] }); return false } catch (e) { return /too many nodes/.test(String((e as Error).message)) } })())
}

console.log('C. artifact shape')
const art = (o: unknown) => pako.deflate(JSON.stringify(o))
const good = { v: 1, kind: 'frozen', plan: { passes: [{}] }, manifest: [], images: [], meta: { anchor: [0.5, 0.5], timeSpeed: 1 } }
const shape = (o: unknown) => { try { decodeArtifactBytes(art(o)); return 'OK' } catch (e) { return String((e as Error).message) } }
check('control: well-formed artifact decodes', shape(good) === 'OK', shape(good))
check('no passes refused', /pass count/.test(shape({ ...good, plan: { passes: [] } })))
check(`>${MAX_ARTIFACT_PASSES} passes refused`, /pass count/.test(shape({ ...good, plan: { passes: new Array(MAX_ARTIFACT_PASSES + 1).fill({}) } })))
check('passes not an array refused', /render plan/.test(shape({ ...good, plan: { passes: 'x' } })))
check('manifest not an array refused', /manifest/.test(shape({ ...good, manifest: {} })))
check('array root refused', /not an object/.test(shape([])))
check('__proto__ key refused', /forbidden key/.test((() => { try { decodeArtifactBytes(pako.deflate(JSON.stringify(good).replace('"v"', '"__proto__":{"x":1},"v"'))); return 'OK' } catch (e) { return String((e as Error).message) } })()))

console.log('D. sinks call the guard')
for (const f of ['src/embed/player.ts', 'src/viewer.ts']) {
  const s = readFileSync(f, 'utf8')
  const g = s.indexOf('isSafeImageDataUrl(')
  const sink = s.indexOf('.src = ', s.indexOf('new Image()'))
  check(`${f}: guard precedes img.src`, g !== -1 && sink !== -1 && g < sink)
}
console.log(failures ? `\n${failures} FAILED` : '\nAll decode-validation checks passed')
process.exit(failures ? 1 : 0)
