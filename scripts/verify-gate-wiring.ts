/**
 * Can every gate in scripts/ actually be run, and does every npm script point
 * at a file that exists?
 *
 * WHY THIS EXISTS. A gate with no npm script is indistinguishable from a gate
 * that does not exist: nobody invokes it, CI never runs it, and it cannot report
 * that it has stopped working. Two were found by hand on 2026-09-13/14 —
 * verify-multipass-expand.ts held the ONLY assertion that a node's connectable
 * param defaults reach every sub-pass, while unrun; and verify-export-framing.ts
 * had been red since 23 August because a correct, deliberate refactor (a732a36)
 * renamed the field it inspected. Nobody was careless. An unwired gate simply
 * makes a correct refactor silently lossy. Finding that class a third time by
 * hand is what this file prevents.
 *
 * BOTH DIRECTIONS, deliberately. "Every gate has a script" alone is satisfied by
 * deleting gates; "every script resolves" alone is satisfied by deleting scripts.
 * The pair is what pins the mapping.
 *
 * Run: npm run verify:gate-wiring
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, run, assert } from './blur-bakeoff/lib/test-util'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Gates that deliberately have no npm script.
 *
 * A reason is REQUIRED and is asserted non-empty below: an entry has to justify
 * itself in the file, so the allowlist cannot quietly become the place gates go
 * to be forgotten. Stale entries fail too — remove one the moment its file is
 * deleted or it gains a script.
 */
const DELIBERATELY_UNWIRED: Record<string, string> = {}

/** Scripts in this chain are the ones CI actually runs. */
const CI_SCRIPT = 'verify:ci'

interface Pkg { scripts: Record<string, string> }
const pkg: Pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

/** Every scripts/**\/verify-*.ts, repo-relative, sorted. */
function gateFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        walk(p)
      } else if (/^verify-.*\.ts$/.test(entry.name)) {
        out.push(path.relative(ROOT, p))
      }
    }
  }
  walk(path.join(ROOT, 'scripts'))
  return out.sort()
}

/** The script file each npm entry runs, for entries that run one. */
function scriptTargets(): Map<string, string> {
  const m = new Map<string, string>()
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    const hit = /(?:^|\s)(scripts\/[\w/.-]+\.ts)(?:\s|$)/.exec(cmd)
    if (hit) m.set(name, hit[1])
  }
  return m
}

const files = gateFiles()
const targets = scriptTargets()
const wired = new Set(targets.values())

test('the sweep actually found the gates — this file included', () => {
  assert(files.length > 20, `expected the repo's gate suite, found ${files.length} files`)
  assert(files.includes('scripts/verify-gate-wiring.ts'), 'the walker missed this very file, so it is not scanning scripts/')
})

test('every verify-*.ts has an npm script, or a reason why not', () => {
  const orphans = files.filter((f) => !wired.has(f) && !(path.basename(f) in DELIBERATELY_UNWIRED))
  assert(
    orphans.length === 0,
    `no npm script runs these gates, so nobody can invoke them:\n    ${orphans.join('\n    ')}\n` +
      '  Add "verify:<name>": "tsx <path>" to package.json, or add the basename to ' +
      'DELIBERATELY_UNWIRED in this file with a reason.',
  )
})

test('every npm script points at a file that exists', () => {
  const missing = [...targets].filter(([, f]) => !fs.existsSync(path.join(ROOT, f)))
  assert(
    missing.length === 0,
    `npm scripts reference files that are gone:\n    ${missing.map(([n, f]) => `${n} -> ${f}`).join('\n    ')}`,
  )
})

test('every allowlist entry is live and carries a reason', () => {
  for (const [base, reason] of Object.entries(DELIBERATELY_UNWIRED)) {
    assert(reason.trim().length > 0, `${base}: allowlisted with no reason given`)
    const match = files.find((f) => path.basename(f) === base)
    assert(match !== undefined, `${base}: allowlisted but no such gate exists — remove the entry`)
    assert(!wired.has(match!), `${base}: allowlisted as unwired but it now HAS an npm script — remove the entry`)
  }
})

test('this check is itself in the CI chain', () => {
  // Without this, the check can be neutered by dropping one entry from
  // verify:ci while leaving the script in place — which looks like nothing.
  const ci = pkg.scripts[CI_SCRIPT] ?? ''
  assert(ci.includes('verify:gate-wiring'), `${CI_SCRIPT} does not run verify:gate-wiring`)
})

await run('gate-wiring')
