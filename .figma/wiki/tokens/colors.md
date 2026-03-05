# Colors

Two Figma variable collections govern all colors in the design system.

---

## UI Colors

**Figma Collection:** UI Colors (`VariableCollectionId:106:2`)
**Modes:** Dark, Light
**CSS Location:** `src/index.css` `:root` block
**Tailwind Registration:** `src/index.css` `@theme inline` block as `--color-*`

### Surface

| Variable | Figma ID | Dark | Light | CSS Variable | Tailwind | Match |
|---|---|---|---|---|---|---|
| surface/default | `106:3` | `#0f0f1a` | `#f0f0f6` | `--surface` | `bg-surface` | ✅ |
| surface/alt | `106:4` | `#1a1a2e` | `#e4e4ee` | `--surface-alt` | `bg-surface-alt` | ✅ |
| surface/raised | `106:5` | `#252538` | `#d4d4e2` | `--surface-raised` | `bg-surface-raised` | ✅ |
| surface/elevated | `106:6` | `#2d2d44` | `#ffffff` | `--surface-elevated` | `bg-surface-elevated` | ✅ |

### Foreground

| Variable | Figma ID | Dark | Light | CSS Variable | Tailwind | Match |
|---|---|---|---|---|---|---|
| fg/default | `106:7` | `#e8e8f0` | `#1a1a2e` | `--fg` | `text-fg` | ✅ |
| fg/dim | `106:8` | `#b8b8c8` | `#3a3a52` | `--fg-dim` | `text-fg-dim` | ✅ |
| fg/subtle | `106:9` | `#88889a` | `#5a5a6e` | `--fg-subtle` | `text-fg-subtle` | ✅ |
| fg/muted | `106:10` | `#5a5a6e` | `#8888a0` | `--fg-muted` | `text-fg-muted` | ✅ |

### Edge

| Variable | Figma ID | Dark | Light | CSS Variable | Tailwind | Match |
|---|---|---|---|---|---|---|
| edge/default | `106:11` | `#3a3a52` | `#d4d4e2` | `--edge` | `border-edge` | ✅ |
| edge/subtle | `106:12` | `#2a2a3e` | `#e4e4ee` | `--edge-subtle` | `border-edge-subtle` | ✅ |

### Indigo (Accent)

| Variable | Figma ID | Dark | Light | CSS Variable | Tailwind | Match |
|---|---|---|---|---|---|---|
| indigo/default | `106:13` | `#6366f1` | `#4f46e5` | `--indigo` | `bg-indigo` / `text-indigo` | ✅ |
| indigo/hover | `106:14` | `#818cf8` | `#6366f1` | `--indigo-hover` | `bg-indigo-hover` | ✅ |
| indigo/active | `106:15` | `#4f46e5` | `#3730a3` | `--indigo-active` | `bg-indigo-active` | ✅ |

### Utility

| Variable | Figma ID | Dark | Light | CSS Variable | Tailwind | Match |
|---|---|---|---|---|---|---|
| white | `106:16` | `#ffffff` | `#ffffff` | (literal) | — | ✅ |

**Total UI Colors: 14 variables, all matched**

---

## Port Types

**Figma Collection:** Port Types (`VariableCollectionId:106:17`)
**Modes:** Dark, Light
**Code Location:** `src/utils/port-colors.ts` — `PORT_COLORS` constant map
**Usage:** Handle borders, edge strokes, port-type badges (applied via inline `style` — justified exception)

| Variable | Figma ID | Dark | Light | Code (`PORT_COLORS`) | Match |
|---|---|---|---|---|---|
| float | `106:18` | `#d4d4d8` | `#71717a` | `'#d4d4d8'` | ✅ |
| vec2 | `106:19` | `#34d399` | `#059669` | `'#34d399'` | ✅ |
| vec3 | `106:20` | `#60a5fa` | `#2563eb` | `'#60a5fa'` | ✅ |
| vec4 | `106:21` | `#a78bfa` | `#7c3aed` | `'#a78bfa'` | ✅ |
| color | `106:22` | `#fbbf24` | `#d97706` | `'#fbbf24'` | ✅ |
| sampler2D | `106:23` | `#f472b6` | `#db2777` | `'#f472b6'` | ✅ |
| default | `106:25` | `#6b7280` | `#6b7280` | `'#6b7280'` | ✅ |

**Total Port Types: 7 variables, all matched**

---

## Notes

- The app currently implements **dark mode only**. Light mode values exist in Figma for future use.
- All Sombra tokens use hex values. The separate shadcn/ui tokens use oklch and are not part of this DS.
- Port colors use inline `style={{ }}` because they're dynamic per-port-type — this is a justified exception to the "no inline styles" rule.
- `white` (`106:16`) is used for specific fills (e.g., gradient stop markers) that must remain white in both modes.
- All color variables in all 21 components are bound to V2 collection variables (`106:*`).

## Parity: ✅ All 21 color variables match
