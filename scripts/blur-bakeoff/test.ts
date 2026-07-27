// Aggregate runner for the blur-bakeoff pure-TS harness tests.
// Each *.test.ts is a standalone tsx script that exits non-zero on failure;
// we run them as child processes and summarize. Usage: npm run blur:test
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const libDir = join(here, 'lib')
const files = readdirSync(libDir)
  .filter((f) => f.endsWith('.test.ts'))
  .sort()

let failed = 0
for (const f of files) {
  try {
    const out = execFileSync('npx', ['tsx', join(libDir, f)], { encoding: 'utf8', stdio: 'pipe' })
    process.stdout.write(out)
  } catch (err) {
    failed++
    const e = err as { stdout?: string; stderr?: string }
    process.stdout.write(e.stdout ?? '')
    process.stderr.write(e.stderr ?? '')
  }
}

if (failed > 0) {
  console.error(`\n✗ blur-bakeoff: ${failed}/${files.length} suites FAILED`)
  process.exit(1)
}
console.log(`\n✓ blur-bakeoff: all ${files.length} suites passed`)
