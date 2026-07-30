/**
 * The `raw()` ratchet.
 *
 * Two-arg `raw(glsl, wgsl)` hands a different literal string to each backend and skips
 * mechanical translation entirely. That is the shape of every silent WebGPU-only bug this
 * project has shipped — the worst (`b56c19c`) reported compile SUCCESS and then dropped
 * every frame, because a non-uniform `textureSample` is illegal in WGSL and nothing checked
 * the WGSL arm existed.
 *
 * A documented budget with no check is a wish, so this is the check. The ceiling only ever
 * moves DOWN: lower it whenever a node converts to structured IR. If you find yourself
 * raising it, that is the signal to add the missing IR construct instead —
 * `src/compiler/ir/types.ts` is 292 lines of our own code and a new statement kind is about
 * 50 lines across it plus both backends (copy the `case 'for'` lowering).
 *
 * One-arg `raw()` is counted and reported but not capped: it is the right tool for whole
 * shared helper-function bodies (`noise-functions.ts` is 13/2 and mostly legitimately so). It is
 * NOT the right tool for node body logic, which no lexical scan can distinguish — that one
 * stays a review question.
 *
 * Method: a lexical scan with a bracket-depth counter, not a real parse. It agrees with an
 * independently-derived count (62 one-arg / 29 two-arg as of 2026-07-30), and it only has to
 * be deterministic to work as a ratchet.
 *
 * Run: npx tsx scripts/verify-raw-budget.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, run, assert } from './blur-bakeoff/lib/test-util'

/** Lower this when a node converts to structured IR. Never raise it. */
const TWO_ARG_CEILING = 29

/** Files where a one-arg raw() carrying a whole function body is the intended tool. */
const HELPER_BODY_FILES = ['noise/noise-functions.ts']

interface Counts { one: number; two: number }

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

/**
 * Count raw() call sites by arity.
 *
 * Splits the argument list at top-level commas and counts NON-BLANK segments. Counting
 * commas instead was wrong: this codebase writes multi-line calls with a trailing comma,
 *
 *     raw(
 *       `...` +
 *       `return total / maxAmp;`,     // <- trailing, not a second argument
 *     )
 *
 * so every such one-arg call scored as two-arg. That inflated the reported two-arg total and
 * therefore the budget itself — the exact "read what a number counts before trusting it"
 * failure this file exists to prevent, committed inside the file preventing it.
 */
function countRaw(src: string): Counts {
  const counts: Counts = { one: 0, two: 0 }
  const re = /\braw\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].length
    const segments: string[] = []
    let segStart = start
    let depth = 0
    let inStr: string | null = null
    let end = start
    for (let i = start; i < src.length; i++) {
      const c = src[i]
      const prev = src[i - 1]
      if (inStr) {
        if (c === inStr && prev !== '\\') inStr = null
        continue
      }
      if (c === '"' || c === "'" || c === '`') { inStr = c; continue }
      if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) { end = i; break }
        depth--
      } else if (c === ',' && depth === 0) {
        segments.push(src.slice(segStart, i))
        segStart = i + 1
      }
    }
    segments.push(src.slice(segStart, end))
    const realArgs = segments.filter((s) => s.trim().length > 0).length
    if (realArgs >= 2) counts.two++
    else counts.one++
  }
  return counts
}

const NODES = path.join(process.cwd(), 'src', 'nodes')
const perFile = new Map<string, Counts>()
let total: Counts = { one: 0, two: 0 }

for (const file of walk(NODES)) {
  const c = countRaw(fs.readFileSync(file, 'utf8'))
  if (c.one === 0 && c.two === 0) continue
  const rel = path.relative(NODES, file)
  perFile.set(rel, c)
  total = { one: total.one + c.one, two: total.two + c.two }
}

console.log(`\n  raw() by file (one-arg / two-arg):`)
for (const [rel, c] of [...perFile.entries()].sort((a, b) => (b[1].one + b[1].two) - (a[1].one + a[1].two))) {
  const flag = HELPER_BODY_FILES.includes(rel) ? '  (helper bodies — expected)' : ''
  console.log(`    ${String(c.one).padStart(3)} / ${String(c.two).padStart(2)}  ${rel}${flag}`)
}
console.log(`\n  TOTAL  one-arg ${total.one}   two-arg ${total.two}  (ceiling ${TWO_ARG_CEILING})\n`)

test(`two-arg raw() stays at or below ${TWO_ARG_CEILING}`, () => {
  assert(
    total.two <= TWO_ARG_CEILING,
    `two-arg raw() rose to ${total.two}, ceiling is ${TWO_ARG_CEILING}. Each one is a shader ` +
    `body hand-written separately per backend, which drifts by construction. Add the missing ` +
    `IR construct instead — see the Guardrails section of CLAUDE.md. If a conversion genuinely ` +
    `requires a new two-arg site, say so explicitly and move the ceiling in the same commit.`,
  )
})

test('the ceiling is not stale — lower it when it can be lowered', () => {
  assert(
    total.two >= TWO_ARG_CEILING - 4,
    `two-arg raw() is down to ${total.two} but the ceiling is still ${TWO_ARG_CEILING}. ` +
    `Lower TWO_ARG_CEILING to ${total.two} so the ratchet keeps its teeth.`,
  )
})

await run('raw-budget')
