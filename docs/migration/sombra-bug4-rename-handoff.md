# Sombra — Bug 4 Fix + Viewer Rename — Agent Handoff

Two small tasks. Fix and verify both before reporting back.

---

## Task 1: Bug 4 — Preview freezes `u_ref_size` at wrong canvas size

**Symptom:** Reproducible sequence:
1. Open editor at normal window size → Preview looks correct
2. Go fullscreen → Preview still correct
3. Reload while fullscreen → Preview looks wrong — pattern appears simplified/zoomed-out
4. Minimize from fullscreen → Preview still looks wrong
5. Reload at normal size → Preview looks correct again

The reloaded fullscreen Preview matches the Viewer output, suggesting both freeze `u_ref_size` from the raw canvas dimensions rather than the panel-constrained size.

**This is new since Phase 0.** The async factory refactor changed when the first render happens relative to canvas layout.

**Root cause:** `u_ref_size` is frozen as `min(canvas.clientWidth, canvas.clientHeight)` on the first valid render. The Phase 0 async factory init + Bug 2 fix (compile immediately after factory resolves) likely triggers the first render before the editor layout has stabilized — so in fullscreen, `ref_size` freezes at the fullscreen canvas dimensions instead of the panel dimensions.

**Investigation steps:**
1. Find where `ref_size` is set/frozen in `renderer.ts`
2. Trace the init sequence: factory creates renderer → Bug 2 fix compiles graph → first render fires → `ref_size` freezes. Determine if the canvas has reached its final layout dimensions at the point `ref_size` is captured.
3. Check if there's a timing gap — the canvas element may exist at fullscreen size before the editor layout constrains it to the panel.

**Fix direction:** Ensure `ref_size` is frozen from the canvas dimensions *after* layout has stabilized. Options:
- Defer `ref_size` capture until after a `requestAnimationFrame` or `ResizeObserver` callback confirms stable dimensions
- Don't freeze `ref_size` on the very first render — wait until the canvas has been resized at least once by the layout system
- If the Viewer legitimately needs different `ref_size` behavior (it's always fullscreen), that's fine — but the editor Preview must freeze from the panel-constrained size, not the raw canvas size

**Verify:**
- [ ] Open editor at normal size → Preview correct
- [ ] Go fullscreen → Preview still correct
- [ ] Reload while fullscreen → Preview looks the same as before reload (not simplified)
- [ ] Minimize → Preview still correct
- [ ] Reload at normal size → Preview still correct
- [ ] `tsc --noEmit` and `npm run build` clean

---

## Task 2: Rename `preview.html` → `viewer.html`

We're standardizing terminology across the project:
- **Preview** = the live shader render in the editor
- **Thumbs** = the 80×80 per-node previews  
- **Viewer** = the standalone page (currently `preview.html`)

### Changes needed:
1. Rename `preview.html` → `viewer.html`
2. Update the share button link in the editor to point to `viewer.html` instead of `preview.html`
3. Search the codebase for any other references to `preview.html` (build config, vite config, comments, documentation) and update them
4. If `viewer.ts` already has the correct name, great. If it's called `preview.ts` or similar, rename it too for consistency.

**Do not rename** anything related to the Preview (editor render panel) or the PreviewRenderer/PreviewScheduler (thumbnail system) — those names are correct in their current context.

### Verify:
- [ ] `viewer.html` loads correctly in browser
- [ ] Share button in editor links to `viewer.html`
- [ ] No remaining references to `preview.html` in the codebase
- [ ] `tsc --noEmit` and `npm run build` clean

---

## Constraints

- These are isolated fixes — do not touch the IR pipeline, backends, or node files
- Do not start Phase 2a
- Report back with what was changed so the fixes can be visually verified
