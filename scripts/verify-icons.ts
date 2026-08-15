import { resolveStrokeWidth } from '../src/icons/create-icon'
import { normalizeIcon } from '../scripts/lib/normalize-icon'

let failures = 0
function eq(label: string, got: number, want: number) {
  const ok = Math.abs(got - want) < 1e-9
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${label}: got ${got}, want ${want}`)
  if (!ok) failures++
}

function eqStr(label: string, got: boolean, want: boolean) {
  const ok = got === want
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${label}`)
  if (!ok) failures++
}

async function main() {
  // Non-absolute: attribute equals the raw stroke width (visual scales with size).
  eq('non-absolute @16', resolveStrokeWidth(1.5, 16, false), 1.5)
  eq('non-absolute @32', resolveStrokeWidth(1.5, 32, false), 1.5)
  // Absolute: attribute is back-computed against the 16 base so the VISUAL stroke stays 1.5px.
  eq('absolute @16', resolveStrokeWidth(1.5, 16, true), 1.5)
  eq('absolute @32', resolveStrokeWidth(1.5, 32, true), 0.75)
  eq('absolute @8', resolveStrokeWidth(1.5, 8, true), 3.0)

  const LUCIDE_PLUS =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" class="lucide lucide-plus"><path d="M5 12h14"/>' +
    '<path d="M12 5v14"/></svg>'

  const { svgText, node } = await normalizeIcon(LUCIDE_PLUS)
  console.log(`[INFO] normalized plus: ${svgText}`)
  eqStr('viewBox is 16 grid', /viewBox="0 0 16 16"/.test(svgText), true)
  eqStr('root stroke-width 1.5', /stroke-width="1.5"/.test(svgText), true)
  eqStr('currentColor kept', /stroke="currentColor"/.test(svgText), true)
  eqStr('no per-child stroke-width', !/<path[^>]*stroke-width/.test(svgText), true)
  eqStr('two path children', node.length === 2, true)
  eqStr('child is path with d', node[0][0] === 'path' && typeof node[0][1].d === 'string', true)
  // 12 in 24-space → 8 in 16-space; 14 → 9.333(4, svgpath carries M's rounding delta); 5 → 3.333
  // NOTE: `\b` doesn't work here — svgpath serialises "...8h9.334" with no separator between
  // a whole-number coord and the next command letter, and \b treats digit+letter as non-boundary
  // (both are \w). Use a digit/dot-aware lookaround instead so this fails on unscaled input too.
  eqStr('d rescaled', /(?<![\d.])8(?![\d.])/.test(String(node[0][1].d)), true)

  if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1) }
  console.log('\nAll icon assertions passed.')
}

main()
