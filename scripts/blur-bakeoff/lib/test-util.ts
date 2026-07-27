// Minimal assert-based test runner for the blur-bakeoff harness.
// The repo has no unit-test framework by convention (verification = tsx scripts);
// this mirrors that: a test file registers cases, then calls run(), which prints
// PASS/FAIL and exits non-zero if anything failed.

type TestFn = () => void | Promise<void>

interface Case {
  name: string
  fn: TestFn
}

const cases: Case[] = []

export function test(name: string, fn: TestFn): void {
  cases.push({ name, fn })
}

export function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

/** Assert two numbers are within `eps` of each other. */
export function assertClose(actual: number, expected: number, eps: number, msg?: string): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > eps) {
    throw new Error(`${msg ?? 'assertClose'}: expected ${expected} ±${eps}, got ${actual}`)
  }
}

export async function run(suiteName: string): Promise<void> {
  let passed = 0
  const failures: Array<{ name: string; err: string }> = []
  for (const c of cases) {
    try {
      await c.fn()
      passed++
    } catch (err) {
      failures.push({ name: c.name, err: err instanceof Error ? err.message : String(err) })
    }
  }
  const total = cases.length
  if (failures.length === 0) {
    console.log(`✓ ${suiteName}: ${passed}/${total} passed`)
  } else {
    console.error(`✗ ${suiteName}: ${failures.length}/${total} FAILED`)
    for (const f of failures) console.error(`  ✗ ${f.name}\n    ${f.err}`)
    process.exit(1)
  }
}
