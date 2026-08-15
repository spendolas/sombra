import { resolveStrokeWidth } from '../src/icons/create-icon'

let failures = 0
function eq(label: string, got: number, want: number) {
  const ok = Math.abs(got - want) < 1e-9
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${label}: got ${got}, want ${want}`)
  if (!ok) failures++
}

// Non-absolute: attribute equals the raw stroke width (visual scales with size).
eq('non-absolute @16', resolveStrokeWidth(1.5, 16, false), 1.5)
eq('non-absolute @32', resolveStrokeWidth(1.5, 32, false), 1.5)
// Absolute: attribute is back-computed against the 16 base so the VISUAL stroke stays 1.5px.
eq('absolute @16', resolveStrokeWidth(1.5, 16, true), 1.5)
eq('absolute @32', resolveStrokeWidth(1.5, 32, true), 0.75)
eq('absolute @8', resolveStrokeWidth(1.5, 8, true), 3.0)

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nAll icon assertions passed.')
