# Component Sandboxes

Dev-only harnesses for building/reviewing components in isolation. Nothing here
ships to Pages (not in `rollupOptions.input`; guarded by `npm run verify:sandbox`).

## Rules
- A harness **imports the real component** from `@/components/…` — never a copy
  of its JSX. Harness code = mount + prop toggles + fixtures only.
- A control/toggle for **every** prop; exercise non-default states.
- **DS tokens only** for harness chrome (`bg-surface`, `text-fg`, `border-edge`…).
- **Fixtures, not live data** — deterministic props so a render is reproducible.

## Open one
- Shell + nav: `npm run sandbox` → pick from the left, or `sandbox.html?c=<name>`.
- Chromeless: `sandbox.html?c=<name>&solo=1`.
- Standalone entry (own module graph): `<name>-sandbox.html`.

## Add one
1. Write `src/sandbox/harnesses/<name>.tsx` — `export default` the harness.
2. Add a line to `src/sandbox/registry.ts` (`SANDBOXES`).
3. `npm run sandbox:gen` (emits the standalone `.html` + `-main.tsx`).
4. **Restart the dev server** — Tailwind misses new-file creates on Dropbox's
   fs-watcher and silently no-ops novel classes.

## Workflow gate
A sandbox exists and passes a visual check **before** a shared component is
plugged into the app.
