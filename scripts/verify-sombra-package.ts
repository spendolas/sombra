/**
 * Editable `.sombra` package verification.
 *
 * Proves the binary container is self-identifying, actually compressed,
 * lossless, corruption-sensitive, and backward-compatible with legacy JSON.
 */
import pako from 'pako'
import {
  SOMBRA_PACKAGE_VERSION,
  decodeCompactHash,
  decodeSombraPackage,
  encodeCompactHash,
  encodeSombraPackage,
  exportToFile,
  extractSombraThumbnail,
  importFromFile,
} from '../src/utils/sombra-file'
import { SOMBRA_APP_BUILD_ID } from '../src/generated/build-info'
import { initializeNodeLibrary } from '../src/nodes'
import { createDefaultGraph } from '../src/utils/test-graph'

initializeNodeLibrary()

let passed = 0
let failed = 0

function check(name: string, condition: boolean): void {
  if (condition) {
    passed++
    console.log(`  [PASS] ${name}`)
  } else {
    failed++
    console.error(`  [FAIL] ${name}`)
  }
}

function checkThrows(name: string, fn: () => unknown, pattern: RegExp): void {
  try {
    fn()
    check(name, false)
  } catch (error) {
    check(name, pattern.test(error instanceof Error ? error.message : String(error)))
  }
}

const graph = createDefaultGraph()
const file = exportToFile(graph.nodes, graph.edges)
const json = JSON.stringify(file)
const jsonBytes = new TextEncoder().encode(json)
const packaged = encodeSombraPackage(file)

console.log('\nA. Binary container and compression mechanism')
check(
  'package starts with the SOMBRA magic bytes',
  new TextDecoder().decode(packaged.subarray(0, 6)) === 'SOMBRA',
)
check('package carries the supported container version', packaged[7] === SOMBRA_PACKAGE_VERSION)
checkThrows(
  'package bytes are not directly parseable as JSON',
  () => JSON.parse(new TextDecoder().decode(packaged)),
  /Unexpected|JSON/,
)
check('deflated package is smaller than the minified JSON payload', packaged.length < jsonBytes.length)
console.log(`  size: ${jsonBytes.length} B JSON -> ${packaged.length} B packaged`)

console.log('\nB. Round-trip and editor import')
const decoded = decodeSombraPackage(packaged)
check('binary package round-trips losslessly', JSON.stringify(decoded) === json)
const imported = importFromFile(decoded)
check('decoded package engages graph validation/import', imported.nodes.length === graph.nodes.length)
check('decoded package preserves graph edges', imported.edges.length === graph.edges.length)
check('package records the current app build id', file.appBuildId === SOMBRA_APP_BUILD_ID)
check('decoded package preserves the app build id', (decoded as { appBuildId?: string }).appBuildId === SOMBRA_APP_BUILD_ID)

console.log('\nC. Backward compatibility')
check(
  'legacy minified JSON remains readable',
  JSON.stringify(decodeSombraPackage(jsonBytes)) === json,
)
check(
  'legacy pretty JSON remains readable',
  JSON.stringify(decodeSombraPackage(new TextEncoder().encode(JSON.stringify(file, null, 2)))) === json,
)

console.log('\nD. Version and integrity failures')
const unsupported = packaged.slice()
unsupported[7] = SOMBRA_PACKAGE_VERSION + 1
checkThrows(
  'unsupported package version is rejected explicitly',
  () => decodeSombraPackage(unsupported),
  /Unsupported \.sombra package version/,
)
checkThrows(
  'truncated package header is rejected',
  () => decodeSombraPackage(packaged.subarray(0, 7)),
  /truncated header/,
)
checkThrows(
  'missing compressed payload is rejected',
  () => decodeSombraPackage(packaged.subarray(0, 8)),
  /missing payload/,
)

const uncompressedPayload = new Uint8Array(8 + jsonBytes.length)
uncompressedPayload.set(packaged.subarray(0, 8))
uncompressedPayload.set(jsonBytes, 8)
checkThrows(
  'header plus raw JSON fails (decoder genuinely inflates the payload)',
  () => decodeSombraPackage(uncompressedPayload),
  /Invalid \.sombra package payload/,
)

const corrupted = packaged.slice()
corrupted[corrupted.length - 1] ^= 0xff
checkThrows(
  'corrupted compressed payload is rejected',
  () => decodeSombraPackage(corrupted),
  /Invalid \.sombra package payload/,
)
checkThrows(
  'unrecognized binary input is rejected',
  () => decodeSombraPackage(new Uint8Array([0, 1, 2, 3, 4])),
  /expected a \.sombra package or JSON document/,
)

console.log('\nE. Embedded thumbnail')
const thumb = { mimeType: 'image/webp', dataUrl: 'data:image/webp;base64,UklGRhoAAABXRUJQ' }
const withThumb = exportToFile(graph.nodes, graph.edges, thumb)
const decodedThumb = decodeSombraPackage(encodeSombraPackage(withThumb))
const extracted = extractSombraThumbnail(decodedThumb)
// Non-vacuous: the data URL travels JSON → deflate → inflate → JSON → extract.
check(
  'thumbnail survives encode → decode → extract',
  extracted?.dataUrl === thumb.dataUrl && extracted?.mimeType === thumb.mimeType,
)
check('a thumbnail-less export omits the field', !('thumbnail' in file))
check('a file without a thumbnail extracts null (backward-compat)', extractSombraThumbnail(decoded) === null)
// Reject invalid thumbnails — proves extract validates, not passes through.
check(
  'non-data: URL thumbnail is rejected',
  extractSombraThumbnail({ thumbnail: { mimeType: 'image/png', dataUrl: 'https://example.com/x.png' } }) === null,
)
check(
  'thumbnail missing mimeType is rejected',
  extractSombraThumbnail({ thumbnail: { dataUrl: 'data:image/png;base64,AA' } }) === null,
)

console.log('\nF. Author labels (SR-1)')
{
  // Label one node of the default graph; leave the rest unlabelled.
  const labelled = createDefaultGraph()
  const target = labelled.nodes.find((n) => labelled.edges.some((e) => e.source === n.id))!
  target.data = { ...target.data, label: 'site.seed' }
  const others = labelled.nodes.filter((n) => n.id !== target.id).map((n) => n.id)

  const viaPackage = importFromFile(decodeSombraPackage(encodeSombraPackage(exportToFile(labelled.nodes, labelled.edges))))
  check('label survives .sombra encode → decode → import',
    viaPackage.nodes.find((n) => n.id === target.id)?.data.label === 'site.seed')
  check('unlabelled nodes stay unlabelled through .sombra',
    viaPackage.nodes.filter((n) => others.includes(n.id)).every((n) => !('label' in n.data)))

  const hash = encodeCompactHash(labelled.nodes, labelled.edges)
  // Mechanism: the label is really IN the hash, as `l`, and only on that node.
  const b64 = hash.replace(/-/g, '+').replace(/_/g, '/')
  const compact = JSON.parse(new TextDecoder().decode(pako.inflate(Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0)))))
  check('compact hash carries l on the labelled node only',
    compact.n.filter((cn: { l?: string }) => 'l' in cn).length === 1 && compact.n.find((cn: { i: string }) => cn.i === target.id)?.l === 'site.seed')
  const viaHash = decodeCompactHash(hash)
  check('label survives compact-hash encode → decode', viaHash.nodes.find((n) => n.id === target.id)?.data.label === 'site.seed')
  check('unlabelled nodes decode with no label key', viaHash.nodes.filter((n) => n.id !== target.id).every((n) => !('label' in n.data)))

  // A hash written before labels existed (no `l` anywhere) still decodes, unchanged.
  const toHash = (o: unknown) => btoa(String.fromCharCode(...pako.deflate(new TextEncoder().encode(JSON.stringify(o)))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const legacy = decodeCompactHash(toHash({
    v: 2,
    n: [{ i: 'a', t: 'noise', p: { seed: 3 } }, { i: 'o', t: 'fragment_output' }],
    e: [{ s: 'a', sh: 'value', t: 'o', th: 'color' }],
  }))
  check('a hash without l still decodes (2 nodes, 1 edge, param kept)',
    legacy.nodes.length === 2 && legacy.edges.length === 1 && legacy.nodes[0].data.params.seed === 3)
  check('a hash without l yields no labels', legacy.nodes.every((n) => !('label' in n.data)))

  // A hand-made hash cannot smuggle in a label the store would never keep.
  const crafted = decodeCompactHash(toHash({
    v: 2,
    n: [{ i: 'a', t: 'noise', l: `  ${'z'.repeat(60)}  ` }, { i: 'b', t: 'noise', l: '   ' }, { i: 'c', t: 'noise', l: 7 }, { i: 'o', t: 'fragment_output' }],
    e: [{ s: 'a', sh: 'value', t: 'o', th: 'color' }],
  }))
  check('decoded labels are normalised (trimmed, 40 chars; blank / non-string dropped)',
    crafted.nodes[0].data.label === 'z'.repeat(40) && !('label' in crafted.nodes[1].data) && !('label' in crafted.nodes[2].data))
}

console.log('\n' + '='.repeat(60))
console.log(`  SUMMARY: ${passed} passed, ${failed} failed`)
console.log('='.repeat(60))
if (failed > 0) process.exit(1)
