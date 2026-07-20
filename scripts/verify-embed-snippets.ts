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

check('embed carries the artifact', s.embed.includes(`data-sombra-scene="${B64}"`))
check('embed is version-pinned', s.embed.includes(`sombra-player.${EMBED_VERSION}.umd.js`))
check('embed self-bootstraps init', s.embed.includes('Sombra.init()'))
check('embed div has a stable id for control', s.embed.includes('id="sombra-shader"'))
check('control targets the embed via sombra:load', s.control.includes(`getElementById('sombra-shader')`) && s.control.includes('sombra:load') && s.control.includes('e.detail.handle'))
check('iframe uses the viewer hash', s.iframe.includes('viewer.html#g=HASH'))
check('iframe absent without hash', buildSnippets(B64).iframe.includes('unavailable'))

console.log('='.repeat(60))
console.log(`  SUMMARY: ${passed} passed, ${failed} failed`)
console.log('='.repeat(60))
if (failed > 0) process.exit(1)
