import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string }

let commit = 'unknown'
try {
  commit = execSync('git rev-parse --short=12 HEAD', {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
} catch {
  commit = 'unknown'
}

const version = pkg.version
const buildId = `${version}+${commit}`
const out = resolve(root, 'src/generated/build-info.ts')
const content = `/**
 * Generated app build metadata.
 *
 * Regenerate with: npm run build:info
 */

export const SOMBRA_APP_VERSION = ${JSON.stringify(version)} as const
export const SOMBRA_APP_COMMIT = ${JSON.stringify(commit)} as const
export const SOMBRA_APP_BUILD_ID = ${JSON.stringify(buildId)} as const
`

writeFileSync(out, content.endsWith('\n') ? content : `${content}\n`)
console.log(`Wrote ${out}`)
