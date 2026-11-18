/**
 * Workflow hardening gate (security audit 2026-11-16, WP5).
 *  - every `uses:` of a third-party/Marketplace action is pinned to a 40-hex commit SHA
 *    (a tag can be moved by whoever controls the action repo)
 *  - every workflow declares a top-level `permissions:` (no implicit default token scope)
 *  - no pull_request_target (runs untrusted PR code with secrets)
 *  - write scopes appear only in a job-level block, never at workflow level
 * Run: npx tsx scripts/verify-workflows.ts
 */
import { readdirSync, readFileSync } from 'fs'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`  [PASS] ${name}`)
  else { failures++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`) }
}
const dir = '.github/workflows'
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))
check('found workflows', files.length > 0)
for (const f of files) {
  const s = readFileSync(`${dir}/${f}`, 'utf8')
  const uses = [...s.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((m) => m[1]).filter((u) => !u.startsWith('./'))
  const unpinned = uses.filter((u) => !/@[0-9a-f]{40}$/.test(u))
  check(`${f}: ${uses.length} action(s) pinned to a commit SHA`, unpinned.length === 0, unpinned.join(', '))
  check(`${f}: top-level permissions declared`, /^permissions:/m.test(s))
  check(`${f}: no pull_request_target`, !/pull_request_target/.test(s))
  const top = s.match(/^permissions:\n((?:[ \t]+.*\n)+)/m)?.[1] ?? ''
  check(`${f}: workflow-level permissions are read-only`, !/:\s*write/.test(top), top.trim())
}
console.log(failures ? `\n${failures} FAILED` : '\nAll workflow checks passed')
process.exit(failures ? 1 : 0)
