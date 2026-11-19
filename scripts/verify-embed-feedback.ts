/**
 * verify-embed-feedback: what the player says back when asked for something it can't do.
 * Pure-logic half (offline); the live-handle half is exercised in a real browser (see the
 * PR). Every bad input has a valid control, and refusals assert the REASON.
 * Run: npx tsx scripts/verify-embed-feedback.ts
 */
import { readFileSync } from 'fs'
import { CAPABILITIES, supports, createReporter, closest, checkKnobValue, describe } from '../src/embed/feedback'
import type { SombraWarning } from '../src/embed/feedback'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`  [PASS] ${name}`)
  else { failures++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`) }
}
const F = { glslType: 'float' as const, min: 0, max: 10 }
const V2 = { glslType: 'vec2' as const }
const V3 = { glslType: 'vec3' as const }
const V4 = { glslType: 'vec4' as const }

console.log('A. value validation')
{
  const ok = checkKnobValue(F, 3.5)
  check('control: in-range float accepted unchanged', ok.ok && ok.value === 3.5 && !('outOfRange' in ok && ok.outOfRange))
  check('control: boundary values accepted', checkKnobValue(F, 0).ok && checkKnobValue(F, 10).ok && !(checkKnobValue(F, 10) as { outOfRange?: string }).outOfRange)
  for (const [label, v] of [['NaN', NaN], ['Infinity', Infinity], ['a string', '3'], ['null', null], ['undefined', undefined], ['an array', [1]]] as const) {
    const r = checkKnobValue(F, v)
    check(`float rejects ${label}`, !r.ok && /expected a finite number/.test((r as { message: string }).message), JSON.stringify(r))
  }
  const out = checkKnobValue(F, 12)
  check('out-of-range float is APPLIED (no behaviour change) but flagged', out.ok && out.value === 12 && /outside the editor range 0\.\.10/.test(out.outOfRange ?? ''))
  check('below-range float flagged too', /outside/.test((checkKnobValue(F, -1) as { outOfRange?: string }).outOfRange ?? ''))
  check('control: float without a range is never flagged', !(checkKnobValue({ glslType: 'float' }, 1e9) as { outOfRange?: string }).outOfRange)
  check('control: vec2 [1,2] accepted', checkKnobValue(V2, [1, 2]).ok)
  check('vec2 rejects wrong length', !checkKnobValue(V2, [1]).ok && !checkKnobValue(V2, [1, 2, 3]).ok)
  check('vec2 rejects a non-finite component', !checkKnobValue(V2, [1, NaN]).ok && !checkKnobValue(V2, [1, 'a' as unknown as number]).ok)
  check('vec2 rejects a bare number, reason names the shape', /array of 2 finite numbers, got a number/.test((checkKnobValue(V2, 3) as { message?: string }).message ?? ''))
  check('control: vec3 [1,2,3] accepted; [1,2] rejected', checkKnobValue(V3, [1, 2, 3]).ok && !checkKnobValue(V3, [1, 2]).ok)
  check('control: colour accepts rgb and rgba', checkKnobValue(V4, [1, 0, 0]).ok && checkKnobValue(V4, [1, 0, 0, 0.5]).ok)
  check('colour rejects 2 or 5 components', !checkKnobValue(V4, [1, 0]).ok && !checkKnobValue(V4, [1, 0, 0, 1, 1]).ok)
  const arr = [0.1, 0.2, 0.3]; const same = checkKnobValue(V3, arr)
  check('valid arrays pass through with identical contents', same.ok && JSON.stringify(same.value) === JSON.stringify(arr))
}

console.log('A2. stable wording')
{
  const nums = [-1, -2.5, -100].map(describe)
  check('varying negative numbers all describe identically (so they dedupe)', new Set(nums).size === 1 && nums[0] === 'a negative number', nums.join('|'))
  check('NaN / Infinity / null / string / array / object are each distinct and readable', [NaN, Infinity, -Infinity, null, 's', [1, 2], {}].map(describe).join('|') === 'NaN|Infinity|-Infinity|null|a string|an array of length 2|an object')
}
console.log('B. "did you mean"')
{
  const keys = ['noise-scale', 'noise-2-scale', 'color-ramp-stop-0', 'blur-radius']
  check('typo suggests the right key', closest('noise-scal', keys) === 'noise-scale', String(closest('noise-scal', keys)))
  check('case differences are forgiven', closest('NOISE-SCALE', keys) === 'noise-scale')
  check('picks the NEAREST of several', closest('noise-2-scal', keys) === 'noise-2-scale')
  check('control: nothing near => no suggestion (never guesses wildly)', closest('zzzzzzzz', keys) === undefined)
  check('empty candidate list is safe', closest('x', []) === undefined)
}

console.log('C. report once')
{
  const warn = console.warn
  let logged = 0; console.warn = () => { logged++ }
  try {
    const got: SombraWarning[] = []
    const report = createReporter((w) => got.push(w))
    const w: SombraWarning = { code: 'UNKNOWN_KNOB', key: 'a', message: 'm', hint: 'h' }
    for (let i = 0; i < 100; i++) report(w) // a 60 Hz slider on a bad key
    check('100 identical reports => ONE console.warn and ONE event', logged === 1 && got.length === 1, `${logged}/${got.length}`)
    report({ ...w, key: 'b' }); report({ ...w, code: 'BAD_VALUE' })
    check('a different key or code is reported separately', logged === 3 && got.length === 3)
    // Different mistakes on one knob each report once; an out-of-range slider reports once per knob.
    { const r2 = createReporter(() => {}); logged = 0
      r2({ code: 'BAD_VALUE', key: 'k', message: 'expected a finite number, got NaN.' })
      r2({ code: 'BAD_VALUE', key: 'k', message: 'expected a finite number, got a string.' })
      r2({ code: 'BAD_VALUE', key: 'k', message: 'expected a finite number, got NaN.' })
      check('NaN then a string on the same knob => TWO reports (the second is not hidden)', logged === 2, String(logged))
      logged = 0
      for (let i = 0; i < 50; i++) r2({ code: 'OUT_OF_RANGE', key: 'k', message: `value ${100 + i} is outside the editor range 0..10; applied anyway.` })
      check('a slider dragged out of range (varying values) => ONE report, not fifty', logged === 1, String(logged)) }
    const small = createReporter(() => {}, 3); logged = 0
    for (let i = 0; i < 10; i++) small({ code: 'UNKNOWN_KNOB', key: 'k' + i, message: 'm' })
    check('bounded: endless distinct keys stop after the cap (no unbounded growth)', logged === 3, String(logged))
    const throwing = createReporter(() => { throw new Error('host listener bug') })
    let threw = false; try { throwing({ code: 'BAD_VALUE', key: 'x', message: 'm' }) } catch { threw = true }
    check('a throwing host listener never breaks the player', !threw)
    check('the console line carries the code, message and hint', (() => { let line = ''; console.warn = (m: string) => { line = m }; createReporter(() => {})({ code: 'UNKNOWN_KNOB', key: 'q', message: 'unknown knob "q".', hint: 'Did you mean "x"?' }); return /^\[Sombra\] UNKNOWN_KNOB: unknown knob "q"\. Did you mean "x"\?$/.test(line) })())
  } finally { console.warn = warn }
}

console.log('D. capabilities')
for (const c of ['knobs', 'knobs.byNode', 'clock.play', 'clock.time', 'clock.timeScale', 'events.warning', 'set.returnsBoolean', 'capabilities']) {
  check(`lists "${c}"`, CAPABILITIES.includes(c) && supports(c))
}
check('control: supports() is false for something it cannot do', !supports('teleport') && !supports(''))
check('names are unique', new Set(CAPABILITIES).size === CAPABILITIES.length)

console.log('E. the player actually uses it')
{
  const p = readFileSync('src/embed/player.ts', 'utf8')
  check('set() validates through checkKnobValue before applying', p.indexOf('checkKnobValue(knob') > -1 && p.indexOf('checkKnobValue(knob') < p.indexOf('applyUniform(knob.uniform, knob.glslType, checked.value)'))
  check('set() returns false for an unknown knob', /if \(!knob\) \{ unknownKnob\(label, nodeForm\); return false \}/.test(p))
  check('get() reports unknown knobs', /unknownKnob\(nodeForm \?/.test(p))
  check('on() reports unknown events instead of storing them', /code: 'UNKNOWN_EVENT'/.test(p))
  check('handle exposes capabilities', /ok: true,\n\s+capabilities: CAPABILITIES/.test(p))
  check('a failed-mount handle also answers (set() => false, capabilities)', /capabilities: CAPABILITIES,\n\s+set\(\) \{ return false \}/.test(p))
  const idx = readFileSync('src/embed/index.ts', 'utf8')
  check('Sombra.capabilities / Sombra.supports are on the global', /capabilities: CAPABILITIES, supports/.test(idx))
  check('player-half boundary: feedback.ts imports only types', !/^import (?!type)/m.test(readFileSync('src/embed/feedback.ts', 'utf8')))
}
console.log(failures ? `\n${failures} FAILED` : '\nAll embed feedback checks passed')
process.exit(failures ? 1 : 0)
