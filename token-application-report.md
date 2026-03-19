# Token Application Audit Report

**Date:** 2026-03-08
**Scope:** All 27 components in `sombra.ds.json` (69 parts)
**Pipeline:** Figma bound variables -> DB ComponentPart fields -> generated ds.ts classes -> component code className

## Summary

| Layer | Check | Result |
|-------|-------|--------|
| A | Figma -> DB | 15 diffs found, 10 fixed, 5 accepted exceptions |
| B | DB -> ds.ts | PASS (`tokens:check` clean) |
| C | ds.ts -> Code | All 69 parts wired; 1 cross-component leak fixed; 12 inline patterns noted |
| Final | `npm run build` | PASS |
| Final | `npm run drift:check` | PASS (no token/component drift) |

## Layer A: Figma -> DB Fixes Applied

### DB Edits (10 total)

| # | Component.Part | Change | Reason |
|---|----------------|--------|--------|
| 1 | nodeCard.header | Removed `justify: "between"` | Figma uses `primaryAxisAlignItems: MIN` + FILL child (`title` has `flex-1`) |
| 2 | floatSlider.labelRow | Removed `justify: "between"` | Figma uses MIN + inner wrapper with `w-full justify-between` |
| 3 | randomDisplay.root | Removed `justify: "between"` | Figma uses MIN + FILL child |
| 4 | randomDisplay.value | Added `flex-1` to extra | Matches Figma FILL sizing on value text (pushes button right) |
| 5 | previewToolbar.root | Changed `align: "center"` -> `align: "start"` | Figma `counterAxisAlignItems: MIN` = `items-start` |
| 6 | previewToolbar.wrapper | Changed `align: "center"` -> `align: "start"` | Same |
| 7 | enumSelect.trigger | Updated figmaNodeId `106:285` -> `354:6` | Old node deleted; replacement is Instance of Select Frame |
| 8 | colorInput.input | Updated figmaNodeId `106:291` -> `354:13` | Old node deleted; replacement is Instance of Color Swatch |
| 9 | *(no DB change)* | False positive: gradientEditor.bar | RECTANGLE has no `layoutMode` — audit script returned incomplete data |
| 10 | *(no DB change)* | False positive: randomDisplay.value textStyle | Hardcoded audit map had stale key; DB already correct |

### Accepted Exceptions (5)

These Figma nodes are shapes (ELLIPSE/RECTANGLE) where layout properties don't apply:

| Component.Part | Figma Type | Why Exception |
|----------------|-----------|---------------|
| handle.root | ELLIPSE | Circle shape — no layout/padding/gap |
| gradientEditor.bar | RECTANGLE | Bar shape — only visual properties |
| gradientEditor.stopHandle | ELLIPSE | Circle marker — no layout |
| gradientEditor.stopHandleSelected | *(shadow state)* | Applied via conditional class |
| gradientEditor.stopMarkers | FRAME | Container for absolute-positioned handles |

## Layer B: DB -> ds.ts

`npm run tokens:check` — PASS. All 27 components, 69 parts match between DB and generated `ds.ts`.

## Layer C: ds.ts -> Component Code

### All Parts Wired (PASS)

Every ds.ts part key is referenced in its corresponding component file. No part is missing a code reference.

| Component | Parts | Status |
|-----------|-------|--------|
| nodeCard | root, header, title, content, footer | All wired via base-node.tsx |
| floatingPreview | root | Wired |
| fullWindowOverlay | root | Wired |
| nodePalette | root, categoryGroup, itemList | All wired |
| propertiesPanel | root, nodeInfo, portRow, paramSection | All wired |
| zoomBar | root | Wired |
| previewToolbar | root, wrapper | All wired |
| paletteItem | root | Wired |
| categoryHeader | root | Wired |
| button | root + 12 state variants | All wired (root on element, states via className) |
| handle | root | Wired |
| separator | root | Wired |
| sliderTrack | track, fill | All wired |
| labeledHandle | root, label | All wired |
| floatSlider | root, labelRow, label, value, input | All wired |
| enumSelect | root, label, trigger, content, item | All wired |
| colorInput | root, label, input | All wired |
| connectableParamRow | root, innerFrame | All wired |
| gradientEditor | root, bar, stopMarkers, stopHandle, stopHandleSelected, controlsRow, positionText | All wired |
| randomDisplay | root, value | All wired |
| graphToolbar | root | Wired |
| previewPanel | root | Wired |
| miniMap | root | Wired (FlowCanvas.tsx) |
| textGhostButton | root | Wired (IconButton.tsx) |
| selectFrame | root | Wired (select.tsx) |
| colorSwatch | root | Wired (ColorRampEditor.tsx) |
| icon | root | Reference-only (no code wiring needed) |

### Fix Applied

**IconButton.tsx cross-component leak**: Was using `ds.randomDisplay.value` for button label text styling. After `flex-1` was added to `randomDisplay.value` (Layer A fix #4), this would have leaked `flex-1` into button labels. Fixed by replacing with inline `tabular-nums` — the button state class (`ds.button.textGhost`) already provides `text-mono-value` + color.

### Inline Patterns Noted (not blocking)

These are inline visual classes in component code that don't have corresponding ds parts. They are candidates for future DS migration but are not token application mismatches:

| File | Pattern | Notes |
|------|---------|-------|
| ShaderNode.tsx:92 | `bg-surface-raised border border-edge rounded-sm` | Unknown-node error fallback |
| ShaderNode.tsx:176 | `text-param text-fg-muted` | Dynamic input count |
| ShaderNode.tsx:226-229 | `text-param text-fg-subtle/muted` | Connected source labels |
| ShaderNode.tsx:243 | `text-[10px] text-fg-muted` | Performance warning |
| ShaderNode.tsx:253,264 | `border-t border-edge-subtle` | Section separators |
| PropertiesPanel.tsx | `text-section text-fg-dim` (x7) | Section headings |
| PropertiesPanel.tsx | `text-category-meta`, `text-node-title`, etc. | Node metadata text |
| select.tsx:52 | `rounded-md border shadow-md` | shadcn primitive base layer |
| select.tsx:75 | `rounded-sm cursor-default` etc. | shadcn SelectItem base |

These use Sombra text style utilities (`text-param`, `text-section`, etc.) and color tokens correctly. They just aren't routed through `ds.*` part references. Adding DS parts for these would require creating corresponding Figma component parts first (per the golden rule).

## Verification

```
npm run tokens:check  -- PASS (generated files match DB)
npm run build         -- PASS (0 errors, 0 warnings)
npm run drift:check   -- PASS (no token drift, no component drift)
```

## Files Modified

| File | Changes |
|------|---------|
| `tokens/sombra.ds.json` | 8 edits (3 removed justify, 1 added flex-1, 2 changed align, 2 updated figmaNodeIds) |
| `src/generated/ds.ts` | Auto-regenerated |
| `src/components/IconButton.tsx` | Removed cross-component `ds.randomDisplay.value` reference |
