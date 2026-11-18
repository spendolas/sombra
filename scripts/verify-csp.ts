/**
 * CSP gate (security audit 2026-11-16, WP3).
 *  A. The policy itself: no eval, no inline/remote script sources, plugins and <base> off.
 *  B. MECHANISM: the build plugin's own handler really puts the policy into HTML
 *     (so "policy looks fine" can't pass while nothing injects it).
 *  C. If dist/ exists: every shipped page carries it and has no inline <script> or on*= handler
 *     (an inline script would be blocked in production — breakage CSP would cause).
 * Run: npx tsx scripts/verify-csp.ts   (after `npm run build` for part C)
 */
import { existsSync, readFileSync } from 'fs'
import { CSP, injectCsp } from '../vite-csp'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`  [PASS] ${name}`)
  else { failures++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`) }
}
const dir = (n: string) => CSP.split(';').map((s) => s.trim()).find((s) => s.startsWith(n + ' ')) ?? ''

console.log('A. policy')
const script = dir('script-src')
check('script-src is self (+ wasm) only', /^script-src 'self'( 'wasm-unsafe-eval')?$/.test(script), script)
check("no 'unsafe-eval' / 'unsafe-inline' in script-src", !/(?<!wasm-)unsafe-eval|unsafe-inline/.test(script))
check('no wildcard or remote host anywhere', !/\*|https?:/.test(CSP))
check("object-src 'none'", dir('object-src') === "object-src 'none'")
check("base-uri 'none'", dir('base-uri') === "base-uri 'none'")
check("default-src 'self'", dir('default-src') === "default-src 'self'")

console.log('B. injection mechanism')
{
  const p = injectCsp() as unknown as { transformIndexHtml: { handler: (h: string) => string }; apply: string }
  const out = p.transformIndexHtml.handler('<html><head><title>x</title></head></html>')
  check('plugin output contains the policy meta', out.includes('http-equiv="Content-Security-Policy"') && out.includes(CSP))
  check('plugin is build-only (dev HMR needs inline scripts)', p.apply === 'build')
}

console.log('C. built pages')
for (const f of ['dist/index.html', 'dist/viewer.html']) {
  if (!existsSync(f)) { console.log(`  [SKIP] ${f} (run npm run build)`); continue }
  const html = readFileSync(f, 'utf8')
  check(`${f}: carries the policy`, html.includes(CSP))
  check(`${f}: no inline <script>`, !/<script(?![^>]*\bsrc=)[^>]*>/i.test(html))
  check(`${f}: no inline event handlers`, !/\son[a-z]+\s*=/i.test(html))
}
console.log(failures ? `\n${failures} FAILED` : '\nAll CSP checks passed')
process.exit(failures ? 1 : 0)
