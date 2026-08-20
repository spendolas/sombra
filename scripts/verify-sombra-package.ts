/**
 * Editable `.sombra` package verification.
 *
 * Proves the binary container is self-identifying, actually compressed,
 * lossless, corruption-sensitive, and backward-compatible with legacy JSON.
 */
import {
  SOMBRA_PACKAGE_VERSION,
  decodeSombraPackage,
  encodeSombraPackage,
  exportToFile,
  importFromFile,
} from '../src/utils/sombra-file'
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

console.log('\n' + '='.repeat(60))
console.log(`  SUMMARY: ${passed} passed, ${failed} failed`)
console.log('='.repeat(60))
if (failed > 0) process.exit(1)
