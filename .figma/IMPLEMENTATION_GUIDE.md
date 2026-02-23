# Figma-First Implementation Guide

This document is the complete reference for any Claude Code agent implementing designs from the Sombra Figma file. After the parity alignment sprint, Figma is the **single source of truth** for all visual decisions.

---

## 1. Workflow Protocol

```
1. User provides a Figma URL (node-id or frame link)
2. Agent calls `get_design_context` (MCP Figma tool) to get screenshot + code hints
3. Agent reads the design:
   a. What components does it use? → Match against Code Connect table (Section 4)
   b. What variables are bound? → Map to CSS vars + Tailwind classes (Section 2)
   c. What spacing/radius/size tokens? → Map to Tailwind utilities (Section 2)
4. Agent checks codebase for existing components that match
5. Agent writes code using existing components, tokens, and patterns
6. Agent verifies with `npm run dev` + visual comparison
```

### Reading a Figma Design

**Extract file key and node ID from URL:**
- `figma.com/design/:fileKey/:fileName?node-id=:nodeId` → convert `-` to `:` in nodeId
- `figma.com/design/:fileKey/branch/:branchKey/:fileName` → use branchKey as fileKey

**Figma file key:** `gq5i0l617YkXy0GzAZPtqz`

**MCP tools for reading:**
- `get_design_context` — primary tool, returns code hints + screenshot + design tokens
- `get_screenshot` — visual reference at specified zoom
- `get_variable_defs` — all variable collections with current values
- `get_metadata` — component structure and properties

**Plugin API for deep inspection** (via `mcp__claude-in-chrome__javascript_tool`):
```js
(async () => {
  const node = await figma.getNodeByIdAsync('17:161');
  // Read boundVariables, fills, strokes, layout properties
  return JSON.stringify(node.boundVariables);
})()
```

---

## 2. Variable → Code Translation Table

### UI Colors (13 variables × Dark/Light modes)

| Figma Variable | CSS Variable | Tailwind Class | Usage Pattern |
|---|---|---|---|
| `surface/default` | `--surface` | `bg-surface` | App background, canvas |
| `surface/alt` | `--surface-alt` | `bg-surface-alt` | Side panel backgrounds |
| `surface/raised` | `--surface-raised` | `bg-surface-raised` | Card headers, input bg, toolbar |
| `surface/elevated` | `--surface-elevated` | `bg-surface-elevated` | Card body, hover states, dropdowns |
| `fg/default` | `--fg` | `text-fg` | Primary text, node titles |
| `fg/dim` | `--fg-dim` | `text-fg-dim` | Secondary text, inactive icons |
| `fg/subtle` | `--fg-subtle` | `text-fg-subtle` | Parameter labels (10px) |
| `fg/muted` | `--fg-muted` | `text-fg-muted` | Disabled text, IDs, hints |
| `edge/default` | `--edge` | `border-edge` | Primary borders, dividers |
| `edge/subtle` | `--edge-subtle` | `border-edge-subtle` | Subtle borders, node separators |
| `indigo/default` | `--indigo` | `bg-indigo` / `text-indigo` | Selection, active state |
| `indigo/hover` | `--indigo-hover` | `bg-indigo-hover` | Accent hover |
| `indigo/active` | `--indigo-active` | `bg-indigo-active` | Accent pressed |

All Sombra color tokens work with any Tailwind utility prefix: `bg-`, `text-`, `border-`, `ring-`, etc.

### Port Type Colors (8 variables × Dark/Light modes)

Port colors are NOT CSS variables — they are hardcoded in `src/utils/port-colors.ts` and applied via inline `style={{ }}` on handles and edges (justified exception: dynamic runtime values).

| Figma Variable | Dark Hex | Type |
|---|---|---|
| `float` | `#d4d4d8` | Scalar values |
| `vec2` | `#34d399` | 2D vectors |
| `vec3` | `#60a5fa` | 3D vectors |
| `vec4` | `#a78bfa` | 4D vectors |
| `color` | `#fbbf24` | Color values |
| `sampler2D` | `#f472b6` | Textures |
| `fnref` | `#22d3ee` | Function references |
| `default` | `#6b7280` | Untyped/fallback |

**Code pattern:**
```tsx
import { getPortColor } from '../utils/port-colors'
<BaseHandle handleColor={getPortColor(portType)} connected={isConnected} />
```

### Spacing (6 tokens)

| Figma Variable | Value | Tailwind Equivalent |
|---|---|---|
| `spacing/xs` | 4px | `gap-1`, `p-1`, `px-1`, `py-1` |
| `spacing/sm` | 6px | `gap-1.5`, `p-1.5` |
| `spacing/md` | 8px | `gap-2`, `p-2` |
| `spacing/lg` | 12px | `gap-3`, `p-3` |
| `spacing/xl` | 16px | `gap-4`, `p-4` |
| `spacing/2xl` | 24px | `gap-6`, `p-6` |

### Radius (4 tokens)

| Figma Variable | Value | Tailwind Class |
|---|---|---|
| `radius/sm` | 4px | `rounded` (via `--radius-sm`) |
| `radius/md` | 8px | `rounded-md` |
| `radius/lg` | 10px | `rounded-lg` |
| `radius/full` | 9999px | `rounded-full` |

### Sizes (9 tokens)

| Figma Variable | Value | Usage |
|---|---|---|
| `size/handle` | 12px | `!w-3 !h-3` on handles |
| `size/icon-xs` | 16px | `size-4` toolbar icons |
| `size/button-sm` | 20px | `w-5 h-5` +/- buttons |
| `size/input-sm` | 22px | Connectable param inputs |
| `size/swatch` | 24px | `h-6` color swatches, value inputs |
| `size/input-md` | 28px | `h-7` select triggers |
| `size/node-min-w` | 160px | `min-w-[160px]` node cards |
| `size/thumb` | 16px | `size-4` slider thumbs |
| `size/track-h` | 6px | `h-1.5` slider tracks |

### Justified Exceptions (no variable needed)

| Value | Where | Why |
|---|---|---|
| `#000000` / `bg-black` | Preview containers | WebGL canvas bg, `bg-surface` shows navy tint |
| `#6699ff` | Color Input swatch | Represents user's actual color value |
| `2px radius` | MiniMap viewport rect | UI indicator, no matching token |

---

## 3. Component Reuse Lookup

When the Figma design uses a known component, use the corresponding React component:

### Atoms
```
Figma: Handle → <BaseHandle handleColor={getPortColor(type)} connected={bool} />
Figma: Separator → <Separator />  (from src/components/ui/separator.tsx)
```

### Molecules
```
Figma: Labeled Handle → <LabeledHandle type="source|target" position={Position.Left|Right}
                          id={portId} title={label}
                          handleColor={getPortColor(type)} connected={bool} />

Figma: Float Slider → <FloatSlider param={paramDef} value={num} onChange={fn} disabled={bool} />
Figma: Enum Select  → <EnumSelect param={paramDef} value={str} onChange={fn} />
Figma: Color Input   → <ColorInput param={paramDef} value={[r,g,b]} onChange={fn} />
Figma: Preview Toolbar → <PreviewToolbar className="..." />
Figma: Preview Panel   → <PreviewPanel targetRef={ref} />
Figma: Gradient Editor → <ColorRampEditor nodeId={id} data={params} />
Figma: Zoom Bar        → <ZoomSlider position="bottom-left" />
```

### Organisms
```
Figma: Node Card → ShaderNode (auto-generated from NodeDefinition in registry, not manually coded)
Figma: Node Palette → <NodePalette />  (auto-reads from nodeRegistry)
Figma: Properties Panel → <PropertiesPanel />  (reads selected node from store)
Figma: Floating Preview → <FloatingPreview targetRef={ref} />
Figma: Full Window Overlay → <FullWindowOverlay targetRef={ref} />
```

---

## 4. Code Connect Mapping Table

Complete mapping of every Figma component to its React source:

### Atoms
| Figma Component | Node ID | Source File | React Component |
|---|---|---|---|
| Handle | `17:161` | `src/components/base-handle.tsx` | `BaseHandle` |
| Palette Item | `17:248` | `src/components/NodePalette.tsx` | (inline) |
| PlusMinus Button | `17:258` | `src/components/ShaderNode.tsx` | (inline) |
| Category Header | `37:96` | `src/components/NodePalette.tsx` | (inline `<h3>`) |
| Port Type Badge | `37:131` | `src/components/PropertiesPanel.tsx` | (inline) |
| Separator | `37:132` | `src/components/ui/separator.tsx` | `Separator` |

### Molecules
| Figma Component | Node ID | Source File | React Component |
|---|---|---|---|
| Labeled Handle | `37:181` | `src/components/labeled-handle.tsx` | `LabeledHandle` |
| Float Slider | `17:234` | `src/components/NodeParameters.tsx` | `FloatSlider` |
| Enum Select | `17:235` | `src/components/NodeParameters.tsx` | `EnumSelect` |
| Color Input | `17:240` | `src/components/NodeParameters.tsx` | `ColorInput` |
| Zoom Bar | `17:314` | `src/components/zoom-slider.tsx` | `ZoomSlider` |
| Connectable Param Row | `37:200` | `src/components/ShaderNode.tsx` | (inline) |
| Gradient Editor | `50:4208` | `src/components/ColorRampEditor.tsx` | `ColorRampEditor` |
| Preview Toolbar | `86:100` | `src/components/PreviewToolbar.tsx` | `PreviewToolbar` |
| Preview Panel | `86:173` | `src/components/PreviewPanel.tsx` | `PreviewPanel` |

### Organisms
| Figma Component | Node ID | Source File | React Component |
|---|---|---|---|
| Node Card | `88:2435` | `src/components/ShaderNode.tsx` | `ShaderNode` |
| Node Palette | `39:289` | `src/components/NodePalette.tsx` | `NodePalette` |
| Properties Panel | `39:393` | `src/components/PropertiesPanel.tsx` | `PropertiesPanel` |
| Floating Preview | `86:261` | `src/components/FloatingPreview.tsx` | `FloatingPreview` |
| Full Window Overlay | `86:286` | `src/components/FullWindowOverlay.tsx` | `FullWindowOverlay` |

---

## 5. New Component Checklist

When the Figma design uses a component that doesn't exist in code yet:

1. **Identify the atomic level** (atom / molecule / organism)
2. **Check if existing DS components compose it** — reuse first, compose before creating new
3. **Create the React component:**
   - Use `cn()` from `@/lib/utils` for className merging
   - Use Sombra token utility classes only — never raw hex values
   - Use `@/components/ui/` shadcn primitives where applicable
   - Follow the file pattern of neighboring components (PascalCase, named export)
   - Place in `src/components/` (or `src/components/ui/` for shadcn primitives)
4. **Register if needed:**
   - Node types → register in `src/nodes/index.ts`
   - shadcn primitives → `npx shadcn@latest add <component>`
5. **Update documentation:**
   - `.figma/wiki/` — add wiki page for the new component (see existing pages for format)
   - `memory/figma-ds.md` — add component ID to the relevant section

---

## 6. New Node Type Checklist

When the Figma design specifies a new shader node:

1. **Read the Figma template** to extract:
   - Inputs: count, types (`float`, `vec2`, `vec3`, `vec4`, `color`, `sampler2D`, `fnref`), labels
   - Outputs: count, types, labels
   - Parameters: type (`float`/`enum`/`color`), min/max/default, connectable flag, showWhen conditions
   - Custom component (if any): gradient editor, special controls

2. **Create the node definition** — `src/nodes/<category>/<name>.ts`
   - Follow `NODE_AUTHORING_GUIDE.md` for the full skeleton
   - Define `NodeDefinition` with inputs, outputs, params, GLSL generator
   - Set `functionKey` if the node produces a `fnref` output

3. **Register in `src/nodes/index.ts`:**
   ```ts
   import { myNodeDef } from './<category>/<name>'
   // Add to the appropriate category in registrations
   ```

4. **Test:**
   ```bash
   npm run dev
   ```
   - Drag node from palette → verify handles appear with correct colors
   - Connect to other nodes → verify GLSL compiles
   - Adjust params → verify live preview updates

5. **Create matching Figma template** using Node Card instance:
   - Toggle boolean properties for visible sections
   - Set handle types and labels
   - Configure param controls

---

## 7. Typography Reference

All text in Figma uses Inter. Map to Tailwind:

| Figma Style | Font | Tailwind Class | Used For |
|---|---|---|---|
| Node title | Inter Semi Bold 14px | `text-sm font-semibold text-fg` | Node Card header |
| Body text | Inter Regular 12px | `text-xs text-fg` | Select triggers, labels |
| Param label | Inter Regular 10px | `text-[10px] text-fg-subtle` | Float slider, enum labels |
| Count display | Inter Regular 10px | `text-[10px] text-fg-muted` | Dynamic input count |
| Category header | Inter Semibold 10px uppercase | `text-[10px] font-semibold uppercase tracking-wider text-fg-subtle` | Palette & panel sections |
| Port type | Inter Mono 10px | `text-[10px] font-mono text-fg-muted` | Port type badges |

---

## 8. Layout Patterns

### Three-Panel App Layout (`src/App.tsx`)
```
┌──────────┬────────────────────────────────────┬──────────┐
│  Palette  │             Center                 │Properties│
│   12%     │      FlowCanvas + Preview          │   12%    │
│           │   (multi-mode, see below)          │          │
└──────────┴────────────────────────────────────┴──────────┘
```

Uses `react-resizable-panels` with min/max constraints. Panels bg: `bg-surface-alt`. Canvas bg: `bg-surface`.

### Preview Modes

| Mode | Layout | Figma Scene |
|---|---|---|
| Docked Vertical | Canvas top, preview bottom (70/30 split) | `40:19498` |
| Docked Horizontal | Canvas left, preview right (70/30 split) | `86:1214` |
| Floating | Full canvas + 400×300 floating window | `86:1527` |
| Full Window | Black overlay covering everything | `86:1610` |

### Node Card Structure

```
┌─────────────────────────────────────┐
│ Header (bg-surface-raised)          │  px-3 py-2
│   Title (text-sm font-semibold)     │
├─────────────────────────────────────┤
│ Content                             │  p-3 gap-y-2
│   Output handles (right-aligned)    │
│   Input handles (left-aligned)      │
│   Dynamic +/- buttons (centered)    │
│   Connectable param rows (handle+slider)│
│   ──────── separator ────────       │  (only before enums/custom)
│   Regular params (enums, sliders)   │
│   Custom component (gradient, etc.) │
└─────────────────────────────────────┘
```

Min width: 160px. Background: `bg-surface-elevated`. Border: `border-edge-subtle` (normal) or `border-indigo` (selected).

---

## 9. Verification Protocol

After implementing any code change from a Figma design:

1. **Lint check:**
   ```bash
   npm run lint
   ```
   No TypeScript errors allowed.

2. **Visual inspection:**
   ```bash
   npm run dev
   ```
   Compare against Figma source at the same dimensions.

3. **Token compliance:**
   - Grep for raw hex values — only allowed in `src/utils/port-colors.ts` and `bg-black` containers
   - All colors should use Tailwind utility classes (`bg-surface`, `text-fg-dim`, `border-edge`, etc.)
   - No inline `style={{ }}` for Sombra tokens (only for React Flow props and dynamic `handleColor`)

4. **Component reuse:**
   - Check that new code uses existing components rather than reimplementing
   - Verify the correct token is used (e.g., `text-fg-subtle` for param labels, not `text-fg-dim`)

5. **Documentation update:**
   - If new components were created, add wiki page in `.figma/wiki/` and activate Code Connect
   - If new node types were added, verify they appear in NODE_AUTHORING_GUIDE.md inventory

---

## 10. Variable Collection Quick Reference

For Plugin API access, use these collection and variable IDs:

| Collection | ID | Variables |
|---|---|---|
| UI Colors | `VariableCollectionId:17:7` | 13 + white(48:4147) |
| Port Types | `VariableCollectionId:17:21` | 8 |
| Spacing | `VariableCollectionId:17:914` | 6 |
| Radius | `VariableCollectionId:17:921` | 4 |
| Sizes | `VariableCollectionId:43:3517` | 9 |

**Variable ID format for Plugin API:** `VariableID:17:12` (prefix required)

**Key variable IDs:**
| Variable | Full ID |
|---|---|
| surface/default | `VariableID:17:8` |
| surface/alt | `VariableID:17:9` |
| surface/raised | `VariableID:17:10` |
| surface/elevated | `VariableID:17:11` |
| fg/default | `VariableID:17:12` |
| fg/dim | `VariableID:17:13` |
| fg/subtle | `VariableID:17:14` |
| fg/muted | `VariableID:17:15` |
| edge/default | `VariableID:17:16` |
| edge/subtle | `VariableID:17:17` |
| indigo/default | `VariableID:17:18` |
| spacing/xs | `VariableID:17:915` |
| spacing/sm | `VariableID:17:916` |
| spacing/md | `VariableID:17:917` |
| spacing/lg | `VariableID:17:918` |
| spacing/xl | `VariableID:17:919` |
| radius/sm | `VariableID:17:922` |
| radius/md | `VariableID:17:923` |
| radius/lg | `VariableID:17:924` |
| radius/full | `VariableID:17:925` |
| size/handle | `VariableID:43:3518` |
| size/node-min-w | `VariableID:43:3523` |
| white | `VariableID:48:4147` |
