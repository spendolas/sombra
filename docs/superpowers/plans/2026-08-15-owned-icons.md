# Owned Iconography Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `lucide-react` runtime dependency with an in-repo icon system — owned 16×16 / 1.5px-stroke SVGs, a tiny `createIcon` factory, and generated per-icon data — so icon stroke weight no longer drifts and the repo owns its icon assets.

**Architecture:** lucide-static (dev dep) is the geometry source. A normaliser rescales each 24-grid lucide SVG to a true 16 viewBox with a 1.5px `currentColor` stroke and writes it to `src/icons/svg/` (the owned copy). A generator emits `src/generated/icon-nodes.ts` (children-as-data) from those SVGs. A ~35-line `createIcon` factory renders them with `size`/`strokeWidth`/`absoluteStrokeWidth` props. The existing `icons.ts` registry is rewired to the factory; consumers are untouched. The Figma DS icon set is mirrored to 21 components @ 1.5 in a one-time manual grip session.

**Tech Stack:** React 19 + TypeScript (strict), Vite, `tsx` scripts (the repo's test idiom), dev-only `lucide-static` / `svgson` / `svgpath`, grip MCP for Figma.

**Spec:** `docs/research/2026-08-15-owned-iconography-design.md`

## Global Constraints

- TypeScript strict mode everywhere; PascalCase components, camelCase utilities.
- **No test framework exists.** Verification = `tsx` assertion scripts + `npm run build` (`tsc -b`) + `npm run lint` + browser checks via `window.__sombra`. Do not add vitest/jest.
- **Runtime must not import `lucide-react`** after this work. `lucide-static`, `svgson`, `svgpath` are **devDependencies only** — never imported from `src/`.
- Owned SVGs: `viewBox="0 0 16 16"`, `fill="none"`, `stroke="currentColor"`, `stroke-width="1.5"`, `stroke-linecap="round"`, `stroke-linejoin="round"`. Child elements carry geometry only (no per-element stroke).
- Icon set is **21** names (the 22 in `icons.ts` today minus `ban`).
- Tailwind utility classes only; no per-component CSS; DS tokens via generated `ds`.
- Commit only when a task's steps say to. Branch: `feat/owned-icons` (already created).
- Every icon's geometry originates from lucide (MIT) — attribution required (Task 9).

**The 21-icon manifest (codeName → lucide-static filename):** used verbatim in Task 3.

| code | lucide-static |
|---|---|
| check | check |
| chevronDown | chevron-down |
| code | code |
| columns | columns-2 |
| copy | copy |
| download | download |
| eye | eye |
| film | film |
| folderOpen | folder-open |
| grid | grid-2x2 |
| maximize | maximize |
| minimize | minimize-2 |
| minus | minus |
| pip | picture-in-picture-2 |
| pipette | pipette |
| plus | plus |
| rows | rows-2 |
| scan | scan |
| share | share-2 |
| shuffle | shuffle |
| square | square |

---

## File Structure

- Create `src/icons/create-icon.tsx` — the runtime factory + `IconNode`/`IconProps` types + `resolveStrokeWidth` pure helper.
- Create `src/icons/svg/<name>.svg` (×21) — owned, generated, committed.
- Create `src/icons/svg/NOTICE` — lucide MIT attribution.
- Create `src/icons/icon-manifest.json` — `{ codeName: lucideName }` map (drives the generator).
- Create `src/generated/icon-nodes.ts` — generated `IconNode` data (×21 exports).
- Create `scripts/lib/normalize-icon.ts` — pure `normalizeIcon(lucideSvg) → { svgText, node }`.
- Create `scripts/generate-icons.ts` — CLI: `gen` / `gen --check` / `add <code> <lucide>`.
- Create `scripts/verify-icons.ts` — asserts `normalizeIcon` + `resolveStrokeWidth` behaviour.
- Modify `src/components/icons.ts` — rewire registry to `createIcon` + generated nodes; drop `ban`.
- Modify `src/components/ui/select.tsx` — swap lucide `ChevronDownIcon` for the owned chevron.
- Modify `src/components/ui/resizable.tsx` — remove dead grip (lucide `GripVerticalIcon`, `withHandle`).
- Modify `package.json` — remove `lucide-react` dep; add dev deps; add `icons:*` scripts.
- Modify `CLAUDE.md` / `AGENTS.md` — add the "new icon" flow to the change checklist.
- Figma (Task 8, manual grip): `stroke/icon = 1.5` variable + set `306:236` to 21 components @ 1.5.

---

### Task 1: Icon runtime — factory + stroke math

**Files:**
- Create: `src/icons/create-icon.tsx`
- Create: `scripts/verify-icons.ts` (stroke-math half; normaliser half added in Task 2)

**Interfaces:**
- Produces: `type IconNode = Array<[tag: string, attrs: Record<string, string | number>]>`; `type IconProps = Omit<React.SVGProps<SVGSVGElement>, 'ref'> & { size?: number; absoluteStrokeWidth?: boolean }`; `resolveStrokeWidth(strokeWidth: number, size: number, absolute: boolean, base?: number): number`; `createIcon(name: string, node: IconNode): React.ForwardRefExoticComponent<IconProps & React.RefAttributes<SVGSVGElement>>`.

- [ ] **Step 1: Write the failing assertion for the stroke math**

Create `scripts/verify-icons.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx scripts/verify-icons.ts`
Expected: FAIL — `Cannot find module` / `resolveStrokeWidth is not a function` (factory not written yet).

- [ ] **Step 3: Write the factory**

Create `src/icons/create-icon.tsx`:

```tsx
import { createElement, forwardRef } from 'react'

const BASE = 16 // our icon grid; absolute-stroke math uses this, not lucide's 24

export type IconNode = Array<[tag: string, attrs: Record<string, string | number>]>

export type IconProps = Omit<React.SVGProps<SVGSVGElement>, 'ref'> & {
  size?: number
  absoluteStrokeWidth?: boolean
}

/**
 * The stroke-width attribute to place on the <svg>. Non-absolute returns the raw
 * width (visual stroke scales with size). Absolute back-computes against BASE so the
 * on-screen stroke stays constant regardless of render size.
 */
export function resolveStrokeWidth(
  strokeWidth: number,
  size: number,
  absolute: boolean,
  base: number = BASE,
): number {
  return absolute ? (strokeWidth * base) / size : strokeWidth
}

export function createIcon(name: string, node: IconNode) {
  const Comp = forwardRef<SVGSVGElement, IconProps>(
    ({ size = 16, strokeWidth = 1.5, absoluteStrokeWidth = false, className, ...rest }, ref) =>
      createElement(
        'svg',
        {
          ref,
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: resolveStrokeWidth(Number(strokeWidth), Number(size), absoluteStrokeWidth),
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          className,
          ...rest,
        },
        node.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs })),
      ),
  )
  Comp.displayName = `Icon(${name})`
  return Comp
}
```

- [ ] **Step 4: Run it to verify the math passes**

Run: `npx tsx scripts/verify-icons.ts`
Expected: PASS — all 5 stroke-math assertions pass.

- [ ] **Step 5: Typecheck**

Run: `npm run build`
Expected: `tsc -b` clean (the new file compiles; nothing imports it yet).

- [ ] **Step 6: Commit**

```bash
git add src/icons/create-icon.tsx scripts/verify-icons.ts
git commit -m "feat(icons): createIcon factory + stroke-width math"
```

---

### Task 2: Normaliser — lucide 24-grid SVG → owned 16-grid SVG + IconNode

**Files:**
- Create: `scripts/lib/normalize-icon.ts`
- Modify: `scripts/verify-icons.ts` (append the normaliser assertions)

**Interfaces:**
- Consumes: `IconNode` from `src/icons/create-icon` (type-only import).
- Produces: `normalizeIcon(lucideSvg: string): Promise<{ svgText: string; node: IconNode }>`.

**Notes for the implementer:** lucide-static icons look like
`<svg ... width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide ..."><path d="M5 12h14"/><path d="M12 5v14"/></svg>`.
The normaliser must: scale all geometry by `16/24`, set the root to the owned attribute set,
strip per-child stroke/class, and return both the serialised SVG and the child geometry as an
`IconNode`. Non-path primitives lucide uses: `path` (attr `d`, via `svgpath`), `circle`
(`cx cy r`), `line` (`x1 y1 x2 y2`), `rect` (`x y width height rx ry`), `polyline`/`polygon`
(`points` — space/comma separated number pairs), `ellipse` (`cx cy rx ry`).

- [ ] **Step 1: Write the failing assertions**

Append to `scripts/verify-icons.ts` (before the final `if (failures)` block):

```ts
import { normalizeIcon } from '../scripts/lib/normalize-icon'

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
// 12 in 24-space → 8 in 16-space; 14 → 9.333; 5 → 3.333
eqStr('d rescaled', /8\b/.test(String(node[0][1].d)), true)
```

Add this helper near the top of the file (next to `eq`):

```ts
function eqStr(label: string, got: boolean, want: boolean) {
  const ok = got === want
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${label}`)
  if (!ok) failures++
}
```

Change the shebang/exec so top-level `await` works — the file is ESM under `tsx`, so wrap the
async assertions in an `async function main() { ... }` and call `main()` at the end, moving the
`if (failures)` exit check to the end of `main`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/verify-icons.ts`
Expected: FAIL — `Cannot find module '../scripts/lib/normalize-icon'`.

- [ ] **Step 3: Install the dev dependencies**

Run: `npm install -D svgson svgpath`
Expected: added to `devDependencies`.

- [ ] **Step 4: Implement the normaliser**

Create `scripts/lib/normalize-icon.ts`:

```ts
import { parse, stringify, type INode } from 'svgson'
import svgpath from 'svgpath'
import type { IconNode } from '../../src/icons/create-icon'

const SCALE = 16 / 24

// Attributes whose numeric value must be multiplied by SCALE, per element tag.
const SCALE_ATTRS: Record<string, string[]> = {
  circle: ['cx', 'cy', 'r'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
}
const POINTS_TAGS = new Set(['polyline', 'polygon'])
// Attributes to drop from children — geometry only survives.
const DROP_ATTRS = new Set(['stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill', 'class'])

const round = (n: number) => Math.round(n * 1000) / 1000

function scalePoints(points: string): string {
  return points
    .trim()
    .split(/\s+/)
    .map((pair) =>
      pair
        .split(',')
        .map((v) => String(round(parseFloat(v) * SCALE)))
        .join(','),
    )
    .join(' ')
}

function scaleChild(el: INode): [string, Record<string, string | number>] {
  const attrs: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(el.attributes)) {
    if (DROP_ATTRS.has(k)) continue
    if (el.name === 'path' && k === 'd') {
      attrs.d = svgpath(v).scale(SCALE).round(3).toString()
    } else if (POINTS_TAGS.has(el.name) && k === 'points') {
      attrs.points = scalePoints(v)
    } else if (SCALE_ATTRS[el.name]?.includes(k)) {
      attrs[k] = round(parseFloat(v) * SCALE)
    } else {
      attrs[k] = v
    }
  }
  return [el.name, attrs]
}

export async function normalizeIcon(lucideSvg: string): Promise<{ svgText: string; node: IconNode }> {
  const root = await parse(lucideSvg)
  const children = root.children.filter((c) => c.type === 'element')
  const node: IconNode = children.map(scaleChild)

  // Serialise the owned SVG: root attrs fixed, children carry scaled geometry only.
  const ownedRoot: INode = {
    name: 'svg',
    type: 'element',
    value: '',
    attributes: {
      xmlns: 'http://www.w3.org/2000/svg',
      width: '16',
      height: '16',
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.5',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    },
    children: node.map(([name, attrs]) => ({
      name,
      type: 'element',
      value: '',
      attributes: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, String(v)])),
      children: [],
    })),
  }
  return { svgText: stringify(ownedRoot), node }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx tsx scripts/verify-icons.ts`
Expected: PASS — stroke-math + all normaliser assertions pass; the `[INFO]` line shows the 16-grid plus SVG.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/normalize-icon.ts scripts/verify-icons.ts package.json package-lock.json
git commit -m "feat(icons): 24→16 SVG normaliser (svgson + svgpath), dev-only"
```

---

### Task 3: Generator CLI + produce the 21 owned SVGs and generated nodes

**Files:**
- Create: `src/icons/icon-manifest.json`
- Create: `scripts/generate-icons.ts`
- Modify: `package.json` (add `lucide-static` dev dep + `icons:*` scripts)
- Generated (committed outputs): `src/icons/svg/<name>.svg` ×21, `src/generated/icon-nodes.ts`

**Interfaces:**
- Consumes: `normalizeIcon` (Task 2), `IconNode` (Task 1).
- Produces: `src/generated/icon-nodes.ts` exporting one `IconNode` per code name (e.g. `export const plus: IconNode = [...]`). Task 4 imports these.

- [ ] **Step 1: Install lucide-static**

Run: `npm install -D lucide-static`
Expected: added to `devDependencies`.

- [ ] **Step 2: Write the manifest**

Create `src/icons/icon-manifest.json` (the 21-entry map from Global Constraints):

```json
{
  "check": "check",
  "chevronDown": "chevron-down",
  "code": "code",
  "columns": "columns-2",
  "copy": "copy",
  "download": "download",
  "eye": "eye",
  "film": "film",
  "folderOpen": "folder-open",
  "grid": "grid-2x2",
  "maximize": "maximize",
  "minimize": "minimize-2",
  "minus": "minus",
  "pip": "picture-in-picture-2",
  "pipette": "pipette",
  "plus": "plus",
  "rows": "rows-2",
  "scan": "scan",
  "share": "share-2",
  "shuffle": "shuffle",
  "square": "square"
}
```

- [ ] **Step 3: Write the generator**

Create `scripts/generate-icons.ts`:

```ts
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeIcon } from './lib/normalize-icon'
import type { IconNode } from '../src/icons/create-icon'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SVG_DIR = join(ROOT, 'src/icons/svg')
const MANIFEST = join(ROOT, 'src/icons/icon-manifest.json')
const NODES_OUT = join(ROOT, 'src/generated/icon-nodes.ts')

const lucideDir = join(dirname(require.resolve('lucide-static/package.json')), 'icons')
const manifest: Record<string, string> = JSON.parse(readFileSync(MANIFEST, 'utf8'))

function lucidePath(lucideName: string): string {
  return join(lucideDir, `${lucideName}.svg`)
}

// Read every owned SVG on disk, re-derive its IconNode, and emit icon-nodes.ts.
// Returns the generated file text (for --check without writing).
async function buildNodesFile(): Promise<string> {
  const names = Object.keys(manifest).sort()
  const entries: string[] = []
  for (const name of names) {
    const svg = readFileSync(join(SVG_DIR, `${name}.svg`), 'utf8')
    const { node } = await normalizeIcon(svg) // owned SVG is already 16-grid → SCALE re-applied is wrong
    entries.push(`export const ${name}: IconNode = ${JSON.stringify(node)}`)
  }
  return (
    `// GENERATED by scripts/generate-icons.ts — do not edit by hand.\n` +
    `import type { IconNode } from '@/icons/create-icon'\n\n` +
    entries.join('\n') +
    '\n'
  )
}
```

**STOP — correctness note for the implementer:** `normalizeIcon` scales by `16/24`. Running it
on an already-16-grid owned SVG would scale *again*. Two clean options — pick one and make the
code match:

- **(A, recommended)** Split the normaliser: `normalizeIcon` (scale 24→16, for `add`) and a
  separate `svgToNode(svgText)` (no scaling — just child geometry → `IconNode`, for `gen`). Add
  `svgToNode` to `scripts/lib/normalize-icon.ts` and use it in `buildNodesFile`.
- **(B)** Have `gen` read the *lucide* source (not the owned SVG) via `normalizeIcon`, and write
  both the owned SVG and the node in one pass — then `gen` is the single producer of both and the
  owned SVGs are pure build output.

This plan uses **(A)**. Add to `scripts/lib/normalize-icon.ts`:

```ts
// No scaling — extract child geometry from an already-owned 16-grid SVG.
export async function svgToNode(svgText: string): Promise<IconNode> {
  const root = await parse(svgText)
  return root.children
    .filter((c) => c.type === 'element')
    .map((el) => {
      const attrs: Record<string, string | number> = {}
      for (const [k, v] of Object.entries(el.attributes)) {
        if (DROP_ATTRS.has(k)) continue
        attrs[k] = v
      }
      return [el.name, attrs] as [string, Record<string, string | number>]
    })
}
```

…and in `buildNodesFile` use `const node = await svgToNode(svg)` instead of `normalizeIcon`.

Then complete `scripts/generate-icons.ts`:

```ts
async function gen({ check }: { check: boolean }) {
  const text = await buildNodesFile()
  if (check) {
    const current = readFileSync(NODES_OUT, 'utf8')
    if (current !== text) {
      console.error('✗ src/generated/icon-nodes.ts is out of date — run `npm run icons:gen`')
      process.exit(1)
    }
    console.log('✓ icon-nodes.ts up to date')
    return
  }
  writeFileSync(NODES_OUT, text)
  console.log(`✓ wrote ${NODES_OUT} (${Object.keys(manifest).length} icons)`)
}

// Download one lucide icon into the owned set, then regenerate nodes.
async function add(code: string, lucide: string) {
  if (!lucide) throw new Error('usage: icons:add <codeName> <lucideName>')
  const { svgText } = await normalizeIcon(readFileSync(lucidePath(lucide), 'utf8'))
  mkdirSync(SVG_DIR, { recursive: true })
  writeFileSync(join(SVG_DIR, `${code}.svg`), svgText + '\n')
  manifest[code] = lucide
  writeFileSync(MANIFEST, JSON.stringify(sortKeys(manifest), null, 2) + '\n')
  await gen({ check: false })
  console.log(`✓ added ${code} (lucide: ${lucide})`)
}

// First-time population: write every owned SVG from lucide per the manifest, then gen.
async function seed() {
  mkdirSync(SVG_DIR, { recursive: true })
  for (const [code, lucide] of Object.entries(manifest)) {
    const { svgText } = await normalizeIcon(readFileSync(lucidePath(lucide), 'utf8'))
    writeFileSync(join(SVG_DIR, `${code}.svg`), svgText + '\n')
    console.log(`  ${code} ← ${lucide}`)
  }
  await gen({ check: false })
}

function sortKeys(o: Record<string, string>) {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))
}

const [cmd, a1, a2] = process.argv.slice(2)
const run = {
  gen: () => gen({ check: process.argv.includes('--check') }),
  seed: () => seed(),
  add: () => add(a1, a2),
}[cmd ?? 'gen']
if (!run) { console.error(`unknown command: ${cmd}`); process.exit(1) }
await run()
```

- [ ] **Step 4: Add npm scripts**

Modify `package.json` `scripts`:

```json
"icons:seed": "tsx scripts/generate-icons.ts seed",
"icons:add": "tsx scripts/generate-icons.ts add",
"icons:gen": "tsx scripts/generate-icons.ts gen",
"icons:gen:check": "tsx scripts/generate-icons.ts gen --check",
```

- [ ] **Step 5: Populate the owned set**

Run: `npm run icons:seed`
Expected: 21 lines printed; `src/icons/svg/` now has 21 `.svg` files; `src/generated/icon-nodes.ts` written with 21 exports.

- [ ] **Step 6: Verify the outputs are real (mechanism-engaged)**

Run:
```bash
ls src/icons/svg | wc -l          # expect 21
grep -c "export const" src/generated/icon-nodes.ts   # expect 21
grep -L 'viewBox="0 0 16 16"' src/icons/svg/*.svg    # expect NO output (all 16-grid)
grep -l 'stroke-width="2"' src/icons/svg/*.svg       # expect NO output (none left at 2)
```
Expected: 21, 21, no stray-grid files, no 2px strokes.

- [ ] **Step 7: Confirm --check round-trips**

Run: `npm run icons:gen:check`
Expected: `✓ icon-nodes.ts up to date` (proves gen is deterministic from the owned SVGs).

- [ ] **Step 8: Typecheck**

Run: `npm run build`
Expected: clean (icon-nodes.ts imports the `IconNode` type; still unused by app).

- [ ] **Step 9: Commit**

```bash
git add src/icons/icon-manifest.json scripts/generate-icons.ts scripts/lib/normalize-icon.ts \
  src/icons/svg src/generated/icon-nodes.ts package.json package-lock.json
git commit -m "feat(icons): generator + 21 owned 16px/1.5 SVGs + generated nodes"
```

---

### Task 4: Rewire the registry to the owned icons; cull `ban`

**Files:**
- Modify: `src/components/icons.ts`

**Interfaces:**
- Consumes: `createIcon` (Task 1), all exports of `src/generated/icon-nodes.ts` (Task 3).
- Produces: `export const icons` (21 keys) and `export type IconName = keyof typeof icons` — same names consumers already use, minus `ban`. `export type { LucideIcon }` is **removed**.

- [ ] **Step 1: Confirm `ban` and `LucideIcon` have no consumers**

Run:
```bash
grep -rn '"ban"\|icons\.ban\|icon="ban"' src   # expect no matches
grep -rn 'LucideIcon' src | grep -v 'icons.ts'  # expect no matches
```
Expected: both empty. (If either has a hit, stop and report — the cull assumption is wrong.)

- [ ] **Step 2: Rewrite the registry**

Replace the entire contents of `src/components/icons.ts`:

```ts
/**
 * Centralized icon registry — all app icons in one place.
 * Icons are OWNED, generated from src/icons/svg/*.svg (sourced from lucide, MIT).
 * See docs/research/2026-08-15-owned-iconography-design.md. No runtime lucide dep.
 */

import { createIcon, type IconProps } from '@/icons/create-icon'
import * as nodes from '@/generated/icon-nodes'

export const icons = {
  check: createIcon('check', nodes.check),
  chevronDown: createIcon('chevronDown', nodes.chevronDown),
  code: createIcon('code', nodes.code),
  columns: createIcon('columns', nodes.columns),
  copy: createIcon('copy', nodes.copy),
  download: createIcon('download', nodes.download),
  eye: createIcon('eye', nodes.eye),
  film: createIcon('film', nodes.film),
  folderOpen: createIcon('folderOpen', nodes.folderOpen),
  grid: createIcon('grid', nodes.grid),
  maximize: createIcon('maximize', nodes.maximize),
  minimize: createIcon('minimize', nodes.minimize),
  minus: createIcon('minus', nodes.minus),
  pip: createIcon('pip', nodes.pip),
  pipette: createIcon('pipette', nodes.pipette),
  plus: createIcon('plus', nodes.plus),
  rows: createIcon('rows', nodes.rows),
  scan: createIcon('scan', nodes.scan),
  share: createIcon('share', nodes.share),
  shuffle: createIcon('shuffle', nodes.shuffle),
  square: createIcon('square', nodes.square),
} as const

export type IconName = keyof typeof icons
export type { IconProps }
```

- [ ] **Step 3: Typecheck + lint**

Run: `npm run build && npm run lint`
Expected: clean. If `tsc` flags a consumer that imported `LucideIcon` or used `ban`, that contradicts Step 1 — stop and report.

- [ ] **Step 4: Commit**

```bash
git add src/components/icons.ts
git commit -m "feat(icons): rewire registry to owned icons; drop unused ban"
```

---

### Task 5: Migrate the last lucide consumer (select chevron) and remove the dependency

**Files:**
- Modify: `src/components/ui/select.tsx`
- Modify: `package.json` (remove `lucide-react`)

**Interfaces:**
- Consumes: `icons` registry (Task 4).

- [ ] **Step 1: Swap the chevron**

In `src/components/ui/select.tsx`: remove `import { ChevronDownIcon } from "lucide-react"`. Add
`import { icons } from "@/components/icons"`. Replace the render (was
`<ChevronDownIcon className="size-3.5 opacity-50" />`) with the owned chevron at 16px:

```tsx
const ChevronDown = icons.chevronDown
// ...
<ChevronDown className="size-icon-sm opacity-50" />
```

(`size-icon-sm` = 16px; the owned icon's baked 1.5 stroke is then uniform with every other icon.)

- [ ] **Step 2: Remove the runtime dependency**

Run: `npm uninstall lucide-react`
Expected: removed from `dependencies` in `package.json`.

- [ ] **Step 3: Prove no lucide-react remains in runtime (mechanism-engaged)**

Run: `grep -rn "lucide-react" src`
Expected: **only** `src/components/ui/resizable.tsx` (handled in Task 6). No other file.

- [ ] **Step 4: Typecheck + lint + dev boot**

Run: `npm run build && npm run lint`
Expected: clean. (`build` runs `tsc -b`; a stray lucide-react import would now fail to resolve.)

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/select.tsx package.json package-lock.json
git commit -m "feat(icons): select chevron uses owned icon; remove lucide-react dep"
```

---

### Task 6: Remove dead grip code

**Files:**
- Modify: `src/components/ui/resizable.tsx`

**Rationale:** `GripVerticalIcon` renders only under `{withHandle && ...}`, and no
`<ResizableHandle>` call site in `src/App.tsx` passes `withHandle`. It is dead, and the last
lucide import. Separate commit — its own concern (per the repo Scope guardrail).

- [ ] **Step 1: Confirm still no caller passes `withHandle`**

Run: `grep -rn "withHandle" src`
Expected: matches only inside `src/components/ui/resizable.tsx` (definition), none in `App.tsx`.
If a caller exists, STOP — do not delete; report instead.

- [ ] **Step 2: Remove the grip**

In `src/components/ui/resizable.tsx`: delete the `import { GripVerticalIcon } from "lucide-react"`
line, remove `withHandle` from the component props/type, and delete the entire
`{withHandle && ( ... <GripVerticalIcon className="size-2.5" /> ... )}` block.

- [ ] **Step 3: Prove lucide-react is fully gone**

Run: `grep -rn "lucide-react" src`
Expected: **no matches anywhere.**

- [ ] **Step 4: Typecheck + lint**

Run: `npm run build && npm run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/resizable.tsx
git commit -m "refactor(resizable): remove dead grip icon (unused withHandle)"
```

---

### Task 7: Browser verification — stroke renders at 1.5px on the 16 grid

**Files:** none (verification task). Uses the dev server + `window.__sombra` / Chrome automation.

**Goal:** prove the owned icons actually render at a 16 viewBox with a 1.5px visual stroke, and
that the check can fail (mechanism-engaged).

- [ ] **Step 1: Start the dev server**

Run: `npm run dev` (note the localhost URL; base path is `/sombra/`).

- [ ] **Step 2: Inspect a rendered registry icon**

In the app, open a view with an `IconButton` (e.g. the graph toolbar). Via Chrome automation or
DevTools console, select a rendered icon SVG and read:
```js
const svg = document.querySelector('button svg')
;[svg.getAttribute('viewBox'), getComputedStyle(svg).strokeWidth, svg.getBoundingClientRect().width]
```
Expected: `viewBox` = `"0 0 16 16"` (proves it is the OWNED icon, not a leftover 24-grid lucide
render), rendered width ≈ 16px, computed `stroke-width` ≈ `1.5px`.

- [ ] **Step 3: Inspect the select chevron**

Open a `<Select>` (e.g. a node's enum param in the properties panel). Read the trigger chevron's
`viewBox` and computed stroke-width. Expected: `0 0 16 16`, stroke ≈ 1.5px.

- [ ] **Step 4: Prove the gate can fail, then revert**

Temporarily edit `src/icons/create-icon.tsx` default `strokeWidth = 1.5` → `3`. Reload. Confirm
the icon stroke visibly doubles and the computed value ≈ 3px. Then revert the edit (back to 1.5)
and confirm 1.5px returns. (No commit — this is a throwaway perturbation.)

- [ ] **Step 5: Record the result**

Note the observed values in the PR description / task notes. No commit.

---

### Task 8: Figma mirror (one-time manual grip session)

**Files:** none in-repo except the DB refresh at the end. Figma edits via grip
(`mcp__grip__*`), following the `figma-ds-conformance` skill. Icon component set is `306:236`.

**Goal:** bring the Figma DS icon set to 21 components at a 1.5 stroke, matching the owned set,
and record the `stroke/icon` variable in the DB.

- [ ] **Step 1: Load the skill and pin the file**

Invoke `figma-ds-conformance`. `mcp__grip__set_active_file` → `Sombra`
(`gq5i0l617YkXy0GzAZPtqz`). Re-read `306:236` before mutating (ids change between sessions).

- [ ] **Step 2: Create the stroke variable**

Create a FLOAT variable `stroke/icon = 1.5` in the DS (the collection that already holds
`Sizes`/scalar tokens). Note its `VariableID` for binding.

- [ ] **Step 3: Retag the existing 15 vectors to 1.5**

For each existing variant's vector(s), bind `strokeWeight` to `stroke/icon` and set the value to
1.5. Pre-map before mutating; apply in batches; verify by re-read (per the skill's iron laws).

- [ ] **Step 4: Author the 6 missing components**

Create `code, eye, film, grid, maximize, square` as 16×16 COMPONENTs in the set, geometry from
the owned SVGs (`src/icons/svg/<name>.svg`), stroke bound to `stroke/icon`, ROUND cap/join, stroke
colour bound to the same variable the others use (`VariableID:106:8`). Add each as a variant of
`306:236` (variant `Icon=<kebab-name>`).

- [ ] **Step 5: Sync the DB and audit parity**

Run: `npm run tokens:sync` then `npm run tokens:audit`
Expected: `stroke/icon` lands in `tokens/sombra.ds.json`; audit reports Figma↔DB parity for the
icon set (no unexpected drift).

- [ ] **Step 6: Commit the DB/generated refresh**

```bash
git add tokens/sombra.ds.json src/index.css src/generated/ds.ts src/utils/port-colors.ts
git commit -m "feat(icons): Figma DS mirror — stroke/icon var + 21 components @1.5"
```

---

### Task 9: Attribution, docs, and the change checklist

**Files:**
- Create: `src/icons/svg/NOTICE`
- Modify: `CLAUDE.md`, `AGENTS.md` (System-Wide Change Checklist)

- [ ] **Step 1: Add lucide attribution**

Create `src/icons/svg/NOTICE`:

```
Icons in this directory are derived from Lucide (https://lucide.dev),
licensed under the ISC License. Lucide is a fork of Feather Icons
(MIT). Geometry has been rescaled to a 16px grid with a 1.5px stroke
for Sombra. Original copyright retained by the Lucide contributors.
```

(Verify the exact licence text/name against `node_modules/lucide-static/LICENSE` and match it —
lucide ships under ISC; correct the NOTICE if it differs.)

- [ ] **Step 2: Document the "new icon" flow**

In `CLAUDE.md` (and mirror in `AGENTS.md`) under **System-Wide Change Checklist**, add:

```
- **New icon:** `npm run icons:add <codeName> <lucideName>` (fetches from lucide-static →
  owned 16px/1.5 SVG in src/icons/svg/ → regenerates src/generated/icon-nodes.ts), add the key
  to the `icons` registry (src/components/icons.ts), then mirror it into the Figma DS icon set
  (306:236) at 1.5 stroke. Icons are OWNED — no runtime lucide dependency.
```

Also update the node/count prose if any icon count is referenced (search: `grep -rn "lucide" CLAUDE.md AGENTS.md`).

- [ ] **Step 3: Add the drift guard to the checks (optional but recommended)**

If CI/`prebuild` should catch stale generated nodes, add `icons:gen:check` alongside the existing
`tokens:check` guard wherever that runs. (Do not wire into `predev`/`prebuild` if it would require
lucide-static at every build — `gen:check` only reads the owned SVGs, so it is safe to include.)

- [ ] **Step 4: Commit**

```bash
git add src/icons/svg/NOTICE CLAUDE.md AGENTS.md
git commit -m "docs(icons): lucide attribution + new-icon flow in change checklist"
```

---

## Self-Review

**Spec coverage:**
- Owned 16/1.5 SVGs → Tasks 2, 3. Factory + params → Task 1. Generated data → Task 3. Registry
  rewire + `ban` cull → Task 4. Remove lucide-react → Tasks 5, 6. Figma mirror + `stroke/icon`
  var → Task 8. Tooling (`icons:add`/`gen`/`--check`) → Task 3. Select chevron 14→16 → Task 5.
  Dead grip → Task 6. Verification (mechanism-engaged, gate-can-fail) → Tasks 3, 5, 6, 7.
  Attribution + non-goals recorded → Task 9. Provenance-inversion policy → recorded in spec,
  referenced in Task 4 header comment. **All spec sections covered.**
- Non-goal honoured: no npm package (in-repo `src/icons/`); bespoke SVGs untouched; no runtime
  stroke token (baked + factory default).

**Placeholder scan:** No TBD/TODO. The only deliberately non-literal content is per-icon path
`d` values — correctly so: they are produced by running `icons:seed`, not hand-authored (any
literal here would be a guess). The Task 3 "STOP" note is a real correctness fork with both
branches specified and one chosen (A), not a placeholder.

**Type consistency:** `IconNode` / `IconProps` / `resolveStrokeWidth` / `createIcon` defined in
Task 1 and used unchanged in Tasks 2–4. `normalizeIcon` (scales) vs `svgToNode` (no scale) are
distinct by design — Task 3 calls this out explicitly to avoid a double-scale bug. Registry
key set (21) matches the manifest (21) matches the generated exports (21). `size-icon-sm`
(16px) is the existing token used in Task 5.

**Known risk flagged in-plan:** double-scaling (Task 3 STOP note); lucide licence name — verify
against the shipped LICENSE (Task 9 Step 1).
