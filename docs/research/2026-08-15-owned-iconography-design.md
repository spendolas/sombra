# Owned iconography — design spec

**Date:** 2026-08-15 · **Status:** design approved, pending spec review
**Branch (proposed):** `feat/owned-icons`

## Problem

Icons drift in stroke weight because two systems disagree on the grid:

- **Code** uses `lucide-react` — every icon is a fixed 24×24 viewBox with `stroke-width: 2`.
  Rendered at 16px (`--sz-icon-sm`) the browser scales 24→16 (×0.667), so the visible stroke
  is `2 × 0.667 = 1.33px`. The select chevron renders at 14px → **1.17px**.
- **Figma** authors icons at 16×16 with `strokeWeight: 2` → a true **2px** stroke.

Neither is intentional and they don't match each other. We want a single, owned answer:
**all icons 16px with a 1.5px stroke**, sourced into our own repo instead of pulled from a
third-party runtime dependency.

## Goals

1. Every app icon renders at a true **1.5px** stroke, at any display size.
2. The repo **owns** the icon SVGs (16×16, `stroke="currentColor"`, 1.5, round caps) as
   plain, diffable, committed files.
3. Distribute them to ourselves the way lucide does — a tiny factory + generated per-icon
   data, tree-shakeable, param-capable (`size`, `strokeWidth`, `absoluteStrokeWidth`), no
   runtime dependency.
4. Remove `lucide-react` from the runtime.
5. The Figma DS icon set mirrors the owned set (21 components @ 1.5) for design parity.

## Non-goals

- Publishing a standalone npm package. Icons live **in-repo** (`src/icons/`) until a second
  consumer exists. YAGNI.
- Normalising bespoke SVG graphics (gizmo overlay, typed edges, image-uploader dropzone) —
  those are graphics, not icon components. Out of scope.
- A runtime stroke-width token that the app reads per-render. Stroke is baked into the owned
  SVG (and the factory default); the DS variable governs the *source*, not runtime.

## Provenance policy — deliberate inversion of the golden rule

The project's golden rule is "Figma is the source of truth." **For icons we deliberately
invert this:** the repo owns the SVGs; Figma is kept as a *mirror* for design parity. Icon
geometry originates from lucide (MIT), is normalised and committed to the repo, and the
Figma DS component set is updated to match. This is a conscious, scoped exception recorded
here so it is not "corrected" later. Colours, spacing, radius, sizes, text styles, and all
other tokens remain Figma-first and unchanged.

## Architecture

```
lucide-static (dev dep, geometry source)
      │  icons:add <name>  — download + normalise
      ▼
src/icons/svg/<name>.svg          ← OWNED. 16×16 viewBox, stroke="currentColor",
      │                              stroke-width 1.5, round cap/join, fill none
      │  icons:gen  — parse + emit
      ▼
src/generated/icon-nodes.ts       ← generated. one IconNode (children-as-data) per icon
      │
      ▼
src/icons/create-icon.tsx         ← ~35-line factory (the whole runtime)
      │
      ▼
src/components/icons.ts           ← registry: IconName → createIcon(name, node)
      │
      ▼
consumers (IconButton, ColorSwatch, select chevron, DSPreview, …) — API unchanged
```

### Runtime — `src/icons/create-icon.tsx`

The entire shipped runtime. Base viewBox is **16** (our grid), so `absoluteStrokeWidth`
math uses base 16, not lucide's 24.

```tsx
const BASE = 16
type IconNode = Array<[tag: string, attrs: Record<string, string | number>]>
type IconProps = Omit<React.SVGProps<SVGSVGElement>, 'ref'> & {
  size?: number
  absoluteStrokeWidth?: boolean
}

export function createIcon(name: string, node: IconNode) {
  const Comp = forwardRef<SVGSVGElement, IconProps>(
    ({ size = 16, strokeWidth = 1.5, absoluteStrokeWidth, className, ...rest }, ref) => (
      <svg
        ref={ref}
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={absoluteStrokeWidth ? (Number(strokeWidth) * BASE) / Number(size) : strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        {...rest}
      >
        {node.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
      </svg>
    ),
  )
  Comp.displayName = `Icon(${name})`
  return Comp
}
```

Because `stroke`, `stroke-width`, and cap/join are set on the parent `<svg>` and are
inheritable SVG presentation attributes, the generated child elements carry no per-element
stroke — they inherit, exactly like lucide. `currentColor` lets consumers theme via
`text-*` classes (as they do today).

### Generated data — `src/generated/icon-nodes.ts`

One export per icon, children-as-data (no JSX, no `dangerouslySetInnerHTML`):

```ts
export const plus: IconNode = [['path', { d: 'M8 3.33v9.34M3.33 8h9.34' }]]
```

### Registry — `src/components/icons.ts`

Same shape and `IconName` type consumers already use; now backed by our components:

```ts
import { createIcon } from '@/icons/create-icon'
import * as nodes from '@/generated/icon-nodes'
export const icons = {
  plus: createIcon('plus', nodes.plus),
  // …
} as const
export type IconName = keyof typeof icons
```

Consumers (`IconButton`, `ColorSwatch`, `DSPreview`, `EmbedModal`, `RgbaColorPicker`) are
untouched — they still do `icons[name]`.

## Icon set

**Cull:** `ban` — unused anywhere and absent from Figma. Registry drops 22 → **21**.

**Registry ↔ Figma name map** (camelCase code ↔ kebab Figma variant):

| code | figma variant | in Figma today | source |
|---|---|---|---|
| check | check | ✓ | lucide `check` |
| chevronDown | chevron-down | ✓ | lucide `chevron-down` |
| columns | columns | ✓ | lucide `columns-2` |
| copy | copy | ✓ | lucide `copy` |
| download | download | ✓ | lucide `download` |
| folderOpen | folder-open | ✓ | lucide `folder-open` |
| minimize | minimize | ✓ | lucide `minimize-2` |
| minus | minus | ✓ | lucide `minus` |
| pip | pip | ✓ | lucide `picture-in-picture-2` |
| pipette | pipette | ✓ | lucide `pipette` |
| plus | plus | ✓ | lucide `plus` |
| rows | rows | ✓ | lucide `rows-2` |
| scan | scan | ✓ | lucide `scan` |
| share | share | ✓ | lucide `share-2` |
| shuffle | shuffle | ✓ | lucide `shuffle` |
| code | code | **✗ add** | lucide `code` |
| eye | eye | **✗ add** | lucide `eye` |
| film | film | **✗ add** | lucide `film` |
| grid | grid | **✗ add** | lucide `grid-2x2` |
| maximize | maximize | **✗ add** | lucide `maximize` |
| square | square | **✗ add** | lucide `square` |

All 21 geometries originate from lucide-static, normalised uniformly (so the existing 15 are
re-derived from the same source rather than exported from their older Figma vectors — one
uniform pipeline, no mixed provenance).

## Normalisation (generation-time, dev-only)

lucide SVGs are 24-grid. To produce true 16px originals:

1. Parse the lucide SVG (dev dep, e.g. `svgson`).
2. Transform all geometry by `16/24` (scale path/line/circle coords). A path-data transform
   lib (e.g. `svgpath`) handles `d`; primitive attrs (`x`, `cx`, `points`, …) scale directly.
3. Set `viewBox="0 0 16 16"`, `stroke="currentColor"`, `stroke-width="1.5"`, round caps,
   `fill="none"`. Strip per-element stroke so the parent cascades.
4. Optimise (svgo) with coordinate rounding to ~3 dp.
5. Write `src/icons/svg/<name>.svg` (the owned copy) and emit its `IconNode` into
   `src/generated/icon-nodes.ts`.

All of the above are **dev/build-time** deps — none ship in the app or embed bundle.

## Tooling (npm scripts)

- `icons:add <name>` — read a lucide icon by its lucide name from the committed
  `lucide-static` dev dependency, normalise, write the owned SVG, regenerate `icon-nodes.ts`.
  This is "download their icons to our repo when needed." **v1 decision:** source is the
  committed `lucide-static` dev dep (deterministic, offline, versioned), not a CDN fetch.
- `icons:gen` — regenerate `icon-nodes.ts` from all `src/icons/svg/*.svg` (run after a
  hand-edit). Add a `--check` mode for CI drift (mirrors `tokens:check`).
- `icons:figma-sync` — **deferred (post-v1).** For v1 the Figma mirror is a one-time manual
  grip session (see "Figma work" below), not an automated script. Automating repo→Figma
  component creation with correct variable bindings is fiddly and higher-risk; revisit once
  the manual flow is understood.

## Figma work (the mirror)

Done once as part of this project, via grip (`figma-ds-conformance`):

1. Add FLOAT variable `stroke/icon = 1.5` to the DS.
2. Bind every icon vector's `strokeWeight` to it and set 2 → 1.5.
3. Create the 6 missing components (`code, eye, film, grid, maximize, square`) at 16×16 from
   the owned geometry, same var bindings, added to set `306:236`.

The `stroke/icon` variable flows through the existing `figma-pull` → `sombra.ds.json` path
for traceability (recorded in the DB; the app does not read it at runtime).

**v1 decision:** this Figma mirror is a **one-time manual grip session**, not automated
(`icons:figma-sync` is deferred post-v1).

## Other code changes

- **`ui/select.tsx`** — replace the raw `ChevronDownIcon` (lucide) with our chevronDown; it
  renders at 16px via the factory so the baked 1.5 stroke is uniform (was 14px → drop the
  `size-3.5` special size).
- **`ui/resizable.tsx`** — remove the dead grip: the `GripVerticalIcon` import, the
  `withHandle` block, and the unused `withHandle` prop (no call site passes it; handles are
  `bg-transparent` by design). This is the last lucide import outside the registry.
- **`package.json`** — remove `lucide-react` from dependencies; add the dev-only
  normalisation deps.

## Commits (one concern each — per the repo's Scope guardrail)

1. Icon runtime + generated data + registry + owned SVGs + tooling (the icon system).
2. Migrate consumers off lucide-react + select chevron; remove `lucide-react` dep.
3. Remove dead grip code in `ui/resizable.tsx`.
4. Figma sync (`stroke/icon` var + 21 components @ 1.5) — separate, DS surface.

## Verification

- `npm run lint`, `npm run build` (tsc) — clean.
- `npm run icons:gen -- --check` — generated data matches the owned SVGs.
- Grep gate: **zero** `lucide-react` imports remain in `src/` (mechanism-engaged — the whole
  point is the dep is gone; assert it, then confirm the build still succeeds).
- Browser (dev server): for a registry icon at 16px and the select chevron, read the rendered
  `<svg viewBox>` (`0 0 16 16`) and computed stroke width, assert the on-screen stroke ≈
  **1.5px**. Mechanism-engaged: assert `viewBox` is the 16 grid (not 24) — proves the icon is
  the owned one, not a leftover lucide render — then confirm 1.5px. Perturb the factory
  strokeWidth to 3 and confirm the check fails.
- Visual spot-check vs the previous lucide render at 16px: shapes match (they're the same
  geometry, re-gridded), stroke is heavier where it was 1.33 and lighter where it was 2.
- `npm run verify:embed:bundle` — confirm the embed bundle still pulls in no React/icons
  (icons.ts is editor-half; the player never imported it — assert unchanged).

## Risks

- **lucide license.** lucide is MIT. Vendoring its geometry is permitted with attribution;
  add a `src/icons/svg/LICENSE`/NOTICE crediting lucide.
- **Path rescale precision.** 24→16 transform can introduce sub-pixel coordinate noise;
  svgo rounding to 3 dp mitigates. Spot-check the densest icons (`film`, `grid`, `pipette`).
- **Figma automation depth.** Creating 6 new components via grip with correct var bindings
  is fiddly; treat `icons:figma-sync` as a stretch and fall back to a manual grip session.
- **`absoluteStrokeWidth` + numeric size.** The factory's math requires a numeric `size`
  prop; consumers that size via CSS class only would miscompute. Default `size = 16` in the
  factory covers the common path; document that non-16 renders must pass `size`.

## Resolved decisions (2026-08-15)

1. **Figma sync:** one-time **manual** grip session for v1; automated `icons:figma-sync`
   deferred post-v1.
2. **Icon source:** committed **`lucide-static`** dev dependency (deterministic, offline,
   versioned); no CDN fetch.
