# Visual Parity Report
Generated: 2026-03-07

## Summary

| Metric | Count |
|--------|-------|
| Components inspected | 27 |
| Parts inspected | 69 |
| Figma MCP calls | 17 |
| Mismatches found | 10 |
| Mismatches fixed | 10 |
| New tokens created | 0 |
| Blocked | 1 (accepted exception) |

## Fixes Applied

### 1. Token linkage: fill "black" to "overlay/scrim" (3 components)

| Component | Part | Before | After |
|-----------|------|--------|-------|
| floatingPreview | root | `bg-black` | `bg-overlay-scrim` |
| fullWindowOverlay | root | `bg-black` | `bg-overlay-scrim` |
| previewPanel | root | `bg-black` | `bg-overlay-scrim` |

Both resolve to #000000. Fix corrects token linkage to the Figma `overlay/scrim` variable.

### 2. FloatingPreview shadow: shadow-2xl to exact Figma spec

| Property | Before | After |
|----------|--------|-------|
| shadow | `shadow-2xl` (0 25px 50px -12px, 25%) | `shadow-[0_8px_24px_0px_rgba(0,0,0,0.5)]` |

Figma effect `shadow/floating`: DROP_SHADOW, #00000080, offset (0,8), blur 24, spread 0.

### 3. NodeCard selected shadow: generic to indigo glow

| Property | Before | After |
|----------|--------|-------|
| selected shadow | `shadow-lg` (generic dark) | `shadow-[0_0_8px_2px_rgba(99,102,241,0.4)]` |

Figma effect `shadow/selection-glow`: DROP_SHADOW, #6366F166, offset (0,0), blur 8, spread 2.

### 4. PropertiesPanel nodeInfo: added layout + gap

| Property | Before | After |
|----------|--------|-------|
| layout | (missing) | `flex flex-col` |
| gap | (missing) | `gap-md` (8px) |

Figma has auto-layout vertical with itemSpacing 8px.

### 5. PropertiesPanel paramSection: added layout + gap

| Property | Before | After |
|----------|--------|-------|
| layout | (missing) | `flex flex-col` |
| gap | (missing) | `gap-lg` (12px) |

Figma has auto-layout vertical with itemSpacing 12px.

### 6. ZoomBar: added vertical alignment

| Property | Before | After |
|----------|--------|-------|
| align | (missing) | `items-center` |

Figma has counterAxisAlignItems: CENTER.

### 7. GraphToolbar: added vertical alignment

| Property | Before | After |
|----------|--------|-------|
| align | (missing) | `items-center` |

Figma has counterAxisAlignItems: CENTER.

### 8. ColorInput input: corrected fill token

| Property | Before | After |
|----------|--------|-------|
| fill | `bg-surface-raised` (#252538) | `bg-surface-alt` (#1a1a2e) |

Figma Color Swatch component uses `surface/alt` variable for default background.

## Per-Component Results

### Organisms

| Component | dsKey | Parts | Diffs | Status |
|-----------|-------|-------|-------|--------|
| Node Card | nodeCard | 5 | 1 (shadow) | FIXED |
| Floating Preview | floatingPreview | 1 | 2 (fill, shadow) | FIXED |
| Full Window Overlay | fullWindowOverlay | 1 | 1 (fill) | FIXED |
| Node Palette | nodePalette | 3 | 0 | PASS |
| Properties Panel | propertiesPanel | 4 | 2 (nodeInfo, paramSection) | FIXED |
| Preview Panel | previewPanel | 1 | 1 (fill) | FIXED |

### Molecules

| Component | dsKey | Parts | Diffs | Status |
|-----------|-------|-------|-------|--------|
| Zoom Bar | zoomBar | 1 | 1 (align) | FIXED |
| Preview Toolbar | previewToolbar | 2 | 0 | PASS |
| Labeled Handle | labeledHandle | 2 | 0 | PASS |
| Float Slider | floatSlider | 5 | 0 | PASS |
| Enum Select | enumSelect | 4 | 0 | PASS |
| Color Input | colorInput | 3 | 1 (input fill) | FIXED |
| Connectable Param Row | connectableParamRow | 2 | 0 | PASS |
| Gradient Editor | gradientEditor | 6 | 0 | PASS |
| Random Display | randomDisplay | 2 | 0 | PASS |
| MiniMap | miniMap | 1 | 0 | PASS (ref only) |
| Graph Toolbar | graphToolbar | 1 | 1 (align) | FIXED |

### Atoms

| Component | dsKey | Parts | Diffs | Status |
|-----------|-------|-------|-------|--------|
| Palette Item | paletteItem | 1 | 0 | PASS |
| Category Header | categoryHeader | 1 | 0 | PASS |
| Button | button | 13 | 0 | PASS |
| Handle | handle | 1 | 0 | PASS |
| Separator | separator | 1 | 0 | PASS |
| Slider Track | sliderTrack | 2 | 0 | PASS |
| Icon | icon | 1 | 0 | PASS |
| Text Ghost Button | textGhostButton | 1 | 0 | PASS (ref only) |
| Select Frame | selectFrame | 1 | 0 | PASS (ref only) |
| Color Swatch | colorSwatch | 1 | 0 | PASS |

## New Tokens Created

None. All fixes used existing tokens.

## Accepted Exceptions

| Component | File | Issue | Reason |
|-----------|------|-------|--------|
| MiniMap mask | FlowCanvas.tsx:179 | `rgba(15,15,26,0.85)` hardcoded | React Flow MiniMap requires resolved CSS color for SVG fill. Value is `--surface` (#0f0f1a) at 85% opacity. Cannot use `var()` in SVG attribute context. |
| Handle bg | base-handle.tsx:28 | `var(--surface-elevated)` inline | Runtime dynamic fallback for unconnected handle background. Port-type color applied dynamically. |
| Error fallback | ShaderNode.tsx:92 | Inline error state styling | Intentional — error states use `text-error` which is a DS token, rest is structural. |

## Post-Parity Drift Report

```
Token drift: None
Component drift: None
Variant drift: 8 informational items (DB parts don't map 1:1 to Figma variants — expected)
```

## Verification

- `npm run tokens:check` — PASS (generated files match DB)
- `npm run drift:check` — 0 token drift, 0 component drift
- `npm run build` — PASS (production build succeeds)
