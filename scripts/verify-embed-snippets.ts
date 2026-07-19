/**
 * verify-embed-snippets — buildSnippets emits well-formed, version-pinned
 * snippets carrying the artifact. Run: npx tsx scripts/verify-embed-snippets.ts
 */
import { buildSnippets } from '../src/embed/publish'
import { EMBED_VERSION } from '../src/embed/version'

let passed = 0, failed = 0
function check(name: string, cond: boolean) { if (cond) passed++; else { failed++; console.error(`  [FAIL] ${name}`) } }

const B64 = 'ABC123_-abc'
const s = buildSnippets(B64, 'HASH')

check('copyPaste carries the artifact', s.copyPaste.includes(`data-sombra-scene="${B64}"`))
check('copyPaste is version-pinned', s.copyPaste.includes(`sombra-player.${EMBED_VERSION}.umd.js`))
check('copyPaste self-bootstraps init', s.copyPaste.includes('Sombra.init()'))
check('developer uses Sombra.mount', s.developer.includes('Sombra.mount(') && s.developer.includes(`scene: "${B64}"`))
check('iframe uses the viewer hash', s.iframe.includes('viewer.html#g=HASH'))
check('iframe absent without hash', buildSnippets(B64).iframe.includes('unavailable'))

console.log('='.repeat(60))
console.log(`  SUMMARY: ${passed} passed, ${failed} failed`)
console.log('='.repeat(60))
if (failed > 0) process.exit(1)
