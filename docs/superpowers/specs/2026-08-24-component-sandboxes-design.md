# Component Sandboxes — design

**Date:** 2026-08-24
**Status:** approved-for-spec-review
**Related rules:** [[sandbox-components-before-plugging-in]], [[sombra-sandboxes-are-local-only]], [[tailwind-new-file-stale-scan]]

## Problem

We built five one-off sandbox harnesses (`color-picker`, `editor-chrome`,
`segmented-control`, `srt-renderer`, plus `ds-preview`) with no shared
convention: three files each (`X-sandbox.html` + `src/X-sandbox-main.tsx` +
`src/pages/XSandbox.tsx`), a growing pile of root `.html`, no discovery, no
codified rule. Before new nodes start landing (each with new/reworked
components), we want the sandbox pattern to be a **convention with infra**, not
a set of copies.

## Core principle — the propagation contract

A sandbox is a **harness** (mount + prop toggles + fixture data) that
**imports the real component** from `src/components/`. It never forks the
component's JSX. Both the routed shell and the standalone entry import the
*same* harness module, which imports the *same* component — so a change to
`src/components/X.tsx` flows to every view with nothing to reconcile. The DS
layer propagates one level down: edit the component's classes → if they live in
`ds.<component>`, regenerate tokens and every consumer updates.

The instant someone pastes a component's JSX into a harness "to try
something," propagation breaks. The rule, stated flat: **harnesses contain
harness code only; they import the component under test.**

## Decisions (locked)

1. **Hybrid shape.** A routed shell is the default home + discovery nav; each
   harness is *also* openable as its own standalone Vite dev entry for
   true module-graph isolation when debugging.
2. **Standalone = true separate Vite entry**, but **dev-server-only**. Vite
   serves any root `.html` in dev; `rollupOptions.input` controls only the
   *prod* build. Harness `.html` files are NOT added to `input`, so they never
   reach the Pages deploy. Isolation and out-of-prod are therefore not in
   tension.
3. **This change = infra + migrate the 5 existing.** No new component
   harnesses authored this round.
4. **All dev/sandbox views are local-only.** `ds-preview` and `embed-tester`
   are removed from `rollupOptions.input`. Prod build input shrinks to
   `main` (index) + `viewer` only. `viewer.html` stays — it is a real feature
   (embed/share URLs decode to it), not a dev tool.
5. **`ds-preview`** is migrated into the shell as a harness (dev-only).
   **`embed-tester`** stays its own dev-only entry (it is a UMD tester, not a
   component harness) — just no longer public.

## Architecture

### File home
```
src/sandbox/
  registry.ts          name → { title, group, load: () => import(harness) }
  SandboxShell.tsx     nav + ?c= router + &solo= chromeless mode
  harnesses/
    color-picker.tsx
    segmented-control.tsx
    editor-chrome.tsx
    srt-renderer.tsx
    ds-preview.tsx
  fixtures/            deterministic props, colocated
  README.md            the convention (see below)
sandbox.html           shell entry (dev-only)
src/sandbox-main.tsx   mounts SandboxShell
<name>-sandbox.html    thin standalone entry per harness (CODEGEN'd, dev-only)
src/<name>-sandbox-main.tsx  thin standalone main (CODEGEN'd)
```
All harness code lives under `src/sandbox/` — visually separate from shipped
code, but inside the TS-strict graph so `tsc -b` catches a harness referencing a
prop the component dropped (cheapest anti-rot defense).

### Registry (single source of the harness list)
```ts
// src/sandbox/registry.ts
export interface SandboxEntry {
  name: string          // url slug, e.g. 'color-picker'
  title: string         // nav label
  group: string         // nav grouping, e.g. 'Controls' | 'Chrome' | 'DS'
  load: () => Promise<{ default: React.ComponentType }>
}
export const SANDBOXES: SandboxEntry[] = [
  { name: 'color-picker', title: 'Color Picker', group: 'Controls',
    load: () => import('./harnesses/color-picker') },
  // …
]
```
Every harness default-exports a component. The registry is the *only* place the
list is declared; the shell nav and the codegen script both read it.

### Shell + routing
`sandbox.html → src/sandbox-main.tsx → SandboxShell`:
- Reads `?c=<name>` → looks up registry → lazy-renders that harness.
- Left-nav lists all `SANDBOXES` grouped by `group`; clicking sets `?c=`.
- `&solo=1` renders the harness with no nav chrome (chromeless in-shell view).
- Unknown/empty `?c` → nav landing page.
- Shell chrome uses **DS tokens** so the backdrop reads as Sombra, not a
  bootstrap page. A harness render error is caught by an error boundary so one
  broken harness doesn't blank the whole shell.

### Hybrid isolation without boilerplate rot
Each harness also gets a thin standalone entry — `<name>-sandbox.html` +
`src/<name>-sandbox-main.tsx` — that mounts just the harness (own Vite dev
module graph, nothing else loads). These two files are **generated** from
`registry.ts` by `scripts/gen-sandbox-entries.ts`, with a `:check` guard that
fails CI if they diverge (mirrors `icons:gen:check`). Adding a harness =
add 1 registry line + run `npm run sandbox:gen`. Generated files carry a
"DO NOT EDIT — generated from registry.ts" banner.

Scripts (package.json):
- `sandbox:gen` — regenerate standalone entries from the registry
- `sandbox:gen:check` — CI guard, fail if generated output is stale
- `sandbox` (optional) — `vite` pointed at `sandbox.html` if a distinct base helps

### Dev-only guarantee (verification)
1. **Prod-input assertion.** A check asserts `rollupOptions.input` contains
   exactly `{ main, viewer }` — no `sandbox`, no `*-sandbox`, no `ds-preview`,
   no `embed-tester`. Perturb by adding an entry → the check must fail.
2. **Import-boundary assertion.** No file outside `src/sandbox/**` may import
   from `src/sandbox/**`, and `main.tsx` must not reach it — mirrors the
   embed-bundle boundary check (`verify-embed-bundle.ts`). This is the
   mechanism-engaged half: it proves the sandbox code cannot be pulled into the
   app bundle by an import, independent of the input-list check.

## Migration of the 5

For each of `color-picker`, `segmented-control`, `editor-chrome`,
`srt-renderer`:
- Move the harness logic from `src/pages/<X>Sandbox.tsx` into
  `src/sandbox/harnesses/<x>.tsx` as a default-export component that imports the
  real component and exposes a prop-toggle panel.
- Delete the old `src/pages/<X>Sandbox.tsx` and `src/<x>-sandbox-main.tsx`.
- Regenerate the standalone `.html` + `-main.tsx` via `sandbox:gen` (same URLs
  keep working).
- Add a registry line.

`ds-preview`: same migration into `src/sandbox/harnesses/ds-preview.tsx`;
remove `dsPreview` from `rollupOptions.input`; delete
`src/ds-preview-main.tsx` + `src/pages/DSPreview.tsx` (folded into the harness).

`embed-tester`: leave the harness/page as-is, only remove `embedTester` from
`rollupOptions.input` so it stops deploying. It is not entered in the registry
(not a component harness); it remains reachable at `embed-tester.html` in dev.

`vite.config.ts` `rollupOptions.input` after migration:
```ts
input: {
  main:   resolve(__dirname, 'index.html'),
  viewer: resolve(__dirname, 'viewer.html'),
}
```

## README convention (the durable rule)

`src/sandbox/README.md` codifies [[sandbox-components-before-plugging-in]]:
- Harness imports the **real** component — never a copy.
- A toggle/control for **every** prop; exercise non-default states.
- **DS tokens only** in harness chrome.
- **Fixtures, not live data** — deterministic props so a render is reproducible.
- **Restart the dev server when adding a new harness** — Tailwind misses the
  file create on Dropbox's fs-watcher and silently no-ops novel classes
  ([[tailwind-new-file-stale-scan]]).
- Adding a harness: write `harnesses/<name>.tsx` (default export) → add a
  registry line → `npm run sandbox:gen` → restart dev server.
- **Workflow gate:** a sandbox exists and passes visual check *before* a shared
  component is plugged into the app.

## Out of scope (later, not this change)

- New harnesses for un-sandboxed components (sliders, format menu, gizmo, ramp
  editor). Author each when its component is next touched.
- Folding `embed-tester` into the shell.

## Testing / verification

- `tsc -b` green (harnesses in the strict graph).
- `npm run lint` green.
- `sandbox:gen:check` green (generated entries match registry).
- Prod-input assertion: input === `{ main, viewer }`.
- Import-boundary assertion: nothing outside `src/sandbox/**` imports it.
- Manual: dev server → `sandbox.html` nav lists 5 → each `?c=` renders → each
  `&solo=1` renders chromeless → each standalone `<name>-sandbox.html` renders.
- `npm run build` → confirm `dist/` contains no `*sandbox*`, no `ds-preview`,
  no `embed-tester` output.
