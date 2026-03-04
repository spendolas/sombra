# Figma↔Code Design System Sync — Universal Guide

> A methodology for making Figma the single source of truth for all visual
> properties in code. Every spacing, size, typography, and radius value in
> code traces to a named Figma variable or text style.

---

## 1. Figma Foundation

### 1.1 Variable Collections

Create these Figma variable collections. Each variable gets a unique ID
that the code references in comments for traceability.

| Collection | Purpose | Example Variables |
|---|---|---|
| **Spacing** | Padding, gap, margin | xs(4), sm(6), md(8), lg(12), xl(16), 2xl(24) |
| **Sizes** | Fixed dimensions (handles, icons, inputs) | handle(12), icon-sm(16), btn-sm(20), input-h(24) |
| **Radius** | Border radius | sm(4), md(8), lg(10), full(9999) |

### 1.2 Text Styles

Create named text styles that bundle font-size, weight, letter-spacing,
line-height, and text-transform into single reusable styles.

| Style Name | Properties | Usage |
|---|---|---|
| heading/title | 14px SemiBold LH 150% | Component titles |
| heading/section | 12px SemiBold 0.05em UPPER LH 150% | Section headers |
| body/default | 12px Regular LH 150% | General body text |
| label/param | 10px Regular LH 150% | Parameter labels |
| mono/value | 12px Regular Mono LH 150% | Code/numeric values |

### 1.3 Auto-Layout Rules

Every frame in Figma that contains children uses auto-layout with:

- **Direction** bound to vertical or horizontal
- **Padding** (top/right/bottom/left) bound to Spacing variables
- **Item spacing** bound to a Spacing variable
- **Child sizing**: Fill Container, Hug Contents, or Fixed (bound to Sizes variable)

---

## 2. Code Foundation (Tailwind CSS v4)

### 2.1 CSS Variable Layer — `index.css :root`

Every Figma variable becomes a CSS custom property. Comment includes
the Figma Variable ID for traceability.

```css
:root {
  /* Spacing (Figma: Spacing collection) */
  --sp-xs:  4px;   /* spacing/xs   VariableID:xxx:xx */
  --sp-sm:  6px;   /* spacing/sm   VariableID:xxx:xx */
  --sp-md:  8px;   /* spacing/md   VariableID:xxx:xx */
  --sp-lg:  12px;  /* spacing/lg   VariableID:xxx:xx */
  --sp-xl:  16px;  /* spacing/xl   VariableID:xxx:xx */
  --sp-2xl: 24px;  /* spacing/2xl  VariableID:xxx:xx */

  /* Sizes (Figma: Sizes collection) */
  --sz-handle: 12px;  /* size/handle VariableID:xxx:xx */
  --sz-icon-sm: 16px; /* size/icon-sm VariableID:xxx:xx */
  /* ... */

  /* Computed (derived from variables) */
  --handle-offset: calc(var(--sz-handle) / 2 + var(--sp-sm));
}
```

### 2.2 Tailwind Registration — `@theme inline`

Register CSS vars as Tailwind utilities so they generate
`gap-*`, `p-*`, `m-*`, `w-*`, `h-*`, `size-*`, `min-w-*` classes.

```css
@theme inline {
  /* Spacing → gap/padding/margin utilities */
  --spacing-xs: var(--sp-xs);
  --spacing-md: var(--sp-md);
  --spacing-lg: var(--sp-lg);

  /* Sizes → w-*/h-* utilities (register as spacing) */
  --spacing-input-h: var(--sz-input-h);

  /* Sizes → size-* utilities */
  --size-handle: var(--sz-handle);

  /* Radius → rounded-* utilities */
  --radius-sm: 4px;  /* Figma radius/sm */

  /* Min-width → min-w-* utilities */
  --min-width-node: var(--sz-node-min-w);
}
```

### 2.3 Typography Utilities — `@utility`

Each Figma text style becomes a single Tailwind utility class
using Tailwind v4's `@utility` feature.

```css
@utility text-section {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  line-height: 1.5;
}

@utility text-param {
  font-size: 10px;
  font-weight: 400;
  line-height: 1.5;
}
```

**Rule**: Color classes (`text-fg`, `text-fg-dim`) stay separate —
they're not part of text styles.

---

## 3. The Auto-Layout Paradigm

### 3.1 Core Mapping

Every flex container in code corresponds to a Figma auto-layout frame:

| Figma Property | CSS | Tailwind |
|---|---|---|
| Direction: VERTICAL | `flex-direction: column` | `flex flex-col` |
| Direction: HORIZONTAL | `flex-direction: row` | `flex` or `flex flex-row` |
| `paddingTop/Right/Bottom/Left` | `padding` | `p-{token}`, `px-{token}`, `py-{token}` |
| `itemSpacing` | `gap` | `gap-{token}` |
| Child sizing: FILL | `flex: 1` | `flex-1` |
| Child sizing: HUG | `width/height: auto` | (default) |
| Child sizing: FIXED | explicit dimension | `w-{token}`, `h-{token}`, `size-{token}` |

### 3.2 Anti-Patterns (Never Use)

| Bad | Good | Why |
|---|---|---|
| `space-y-*` / `space-x-*` | `flex flex-col gap-*` / `flex gap-*` | Figma uses `itemSpacing` (gap), not margin on children |
| Hardcoded px values | Token classes (`gap-md`, `p-lg`, `size-btn-sm`) | Must map to a Figma variable |
| `!important` sizing on repeated elements | Centralized CSS rule | Single source of truth |
| Bare `rounded` | `rounded-sm` or explicit | Ambiguous value, use named token |

### 3.3 Absolute-Positioned Elements (Handles, Overlays)

When Figma uses auto-layout children but code requires
`position: absolute` (e.g., React Flow handles):

1. Define a **computed offset**: `calc(element-size / 2 + visual-gap)`
2. Apply as padding on the sibling content: `px-handle-offset`
3. The offset auto-adjusts if element size changes

---

## 4. Workflow

### When a Figma variable changes

1. Designer updates variable in Figma (e.g., `spacing/lg`: 12 → 14)
2. Dev updates **one CSS var**: `--sp-lg: 14px;`
3. Every usage across the codebase updates automatically

### When a Figma text style changes

1. Designer updates text style in Figma
2. Dev updates **one `@utility` block** in `index.css`
3. Every usage updates automatically

### When adding a new component

1. Designer builds component using existing Figma variables
2. Dev builds component using existing token classes
3. **No new CSS needed** — vocabulary already exists

### When adding a new Figma variable

1. Create variable in Figma collection
2. Add CSS var in `:root` with Variable ID comment
3. Register in `@theme inline`
4. Token utility immediately available project-wide

---

## 5. Verification Checklist

For any component, verify Figma↔Code parity:

- [ ] Every padding value uses a spacing token (`p-md`, `px-lg`)
- [ ] Every gap uses a spacing token (`gap-sm`, `gap-md`)
- [ ] Every fixed dimension uses a size token (`size-btn-sm`, `h-input-h`)
- [ ] Typography uses a single text style class (`text-section`, `text-param`)
- [ ] Border radius uses a named token (`rounded-sm`, `rounded-md`)
- [ ] No `space-y-*` or `space-x-*` — use `gap-*` on flex parent
- [ ] No bare `rounded` — use explicit `rounded-sm`/`rounded-md`/etc.
- [ ] No `!important` sizing on repeated elements — use centralized CSS rule
- [ ] CSS var comment includes Figma Variable ID

---

## 6. File Structure

```
project/
├── src/
│   ├── index.css          # :root vars + @theme inline + @utility text styles
│   └── components/
│       ├── ui/            # Third-party component library (separate token system)
│       └── *.tsx          # All use token classes, never raw numbers
├── .figma/
│   ├── FIGMA_CODE_SYNC.md        # This guide
│   ├── IMPLEMENTATION_GUIDE.md   # Project-specific component mapping
│   └── wiki/                     # Per-component documentation
└── CLAUDE.md              # Token reference table for AI assistants
```

---

## 7. Implementation Playbook

### Phase 1: Audit

1. List every Figma variable collection (Spacing, Sizes, Radius) with variable IDs
2. List every Figma text style with all properties
3. Grep the codebase for hardcoded values: `text-[Npx]`, `gap-N`, `p-N`, `w-N`, `h-N`, `rounded`, `space-y-*`
4. Map each hardcoded value to the closest Figma variable
5. Identify values with no Figma variable yet — create new variables

### Phase 2: Foundation

1. Add all CSS variables to `:root` in `index.css` with Variable ID comments
2. Register in `@theme inline` for Tailwind utility generation
3. Add centralized CSS rules for repeated elements (e.g., handle sizing)
4. Fix any radius mismatches between Tailwind defaults and Figma tokens
5. Create `@utility` blocks for all text styles

### Phase 3: Migration

Work in dependency order — foundation components first, composed components last:

1. **Core layout** (base components used everywhere)
2. **Feature components** (highest hardcoded-value density)
3. **Sidebar / secondary UI**
4. **Shell / app layout**

For each file:
- Replace `space-y-*` → `flex flex-col gap-*`
- Replace hardcoded spacing → token classes
- Replace hardcoded sizing → token classes
- Replace multi-class typography → single `@utility` class
- Replace bare `rounded` → explicit `rounded-sm`/`rounded-md`

### Phase 4: Figma Sync

1. Create any new Figma variables identified in the audit
2. Fix any Figma components that don't match the corrected code
3. Update variable bindings on Figma components as needed

### Phase 5: Documentation

1. Create this guide (`.figma/FIGMA_CODE_SYNC.md`)
2. Update project `CLAUDE.md` with token mapping reference
3. Add verification steps to CI or PR review checklist

---

## 8. Token Naming Convention

### CSS Variables

| Layer | Prefix | Example |
|---|---|---|
| Spacing | `--sp-` | `--sp-md`, `--sp-lg` |
| Sizes | `--sz-` | `--sz-handle`, `--sz-btn-sm` |
| Computed | `--` (no prefix) | `--handle-offset` |

### Tailwind Registration

| Figma Collection | `@theme inline` namespace | Generated utilities |
|---|---|---|
| Spacing | `--spacing-*` | `gap-*`, `p-*`, `px-*`, `py-*`, `m-*` |
| Sizes (as spacing) | `--spacing-*` | `h-*`, `w-*` (for height/width) |
| Sizes (as size) | `--size-*` | `size-*` (for equal width+height) |
| Sizes (as min-width) | `--min-width-*` | `min-w-*` |
| Radius | `--radius-*` | `rounded-*` |

### Typography

| Figma Text Style | Tailwind Utility |
|---|---|
| `heading/node-title` | `text-node-title` |
| `heading/section` | `text-section` |
| `body/default` | `text-body` |
| `label/param` | `text-param` |
| `mono/value` | `text-mono-value` |

---

## 9. Exclusion Rules

Not everything needs tokenization. Exclude:

| Category | Example | Why |
|---|---|---|
| **Functional hit areas** | Resize handle `h-1.5`, corner grab `w-3 h-3` | Interaction targets, not design tokens |
| **Third-party internals** | shadcn button `h-9`, radix sizes | Separate component library token system |
| **Runtime-dynamic values** | Inline `style={{ left: pos.x }}` | Computed at runtime, not designable |
| **One-off layout constants** | `MIN_W = 200` (JS constant) | Functional constraint, not a design variable |

---

## 10. Scaling to Multiple Projects

This guide is project-agnostic. To adopt in a new project:

1. **Copy this file** to `.figma/FIGMA_CODE_SYNC.md`
2. **Audit Figma** — list your variable collections, text styles, and IDs
3. **Set up `index.css`** — `:root` vars + `@theme inline` + `@utility` blocks
4. **Migrate components** — follow Phase 3 dependency order
5. **Verify** — use the checklist in Section 5 for each component

The methodology works with any Figma variable structure and any
Tailwind v4 project. The specific token names and values change;
the architecture and workflow stay the same.
