# Typography

**Figma:** 11 local text styles (heading/*, body/*, label/*, mono/*, port-row/*)
**Font Family:** Inter (Regular, Semi Bold)
**Code Location:** Tailwind utility classes in component files
**Base Defaults:** `font-family: Inter, system-ui, Avenir, Helvetica, Arial, sans-serif` · `line-height: 1.5` · `font-weight: 400` (set in `src/index.css` `:root`)

## Text Style Table

| # | Style Name | Size | Weight | Letter Spacing | Text Case | Line Height | Tailwind Equivalent | Parity |
|---|---|---|---|---|---|---|---|---|
| 1 | `heading/node-title` | 14px | Semi Bold (600) | 0 | none | 150% | `text-sm font-semibold` | ✅ |
| 2 | `heading/section` | 12px | Semi Bold (600) | 0.6px | UPPER | 150% | `text-xs font-semibold uppercase tracking-wider` | ✅ |
| 3 | `heading/category` | 10px | Semi Bold (600) | 0.5px | UPPER | 150% | `text-[10px] font-semibold uppercase tracking-wider` | ✅ |
| 4 | `body/default` | 12px | Regular (400) | 0 | none | 150% | `text-xs` | ✅ |
| 5 | `body/description` | 12px | Regular (400) | 0 | none | 162.5% | `text-xs leading-relaxed` | ✅ |
| 6 | `body/handle` | 13px | Regular (400) | 0 | none | 150% | inherited from `.react-flow__node { font-size: 13px }` | ✅ |
| 7 | `label/param` | 10px | Regular (400) | 0 | none | 150% | `text-[10px]` | ✅ |
| 8 | `label/category-meta` | 10px | Regular (400) | 0.25px | UPPER | 150% | `text-[10px] uppercase tracking-wide` | ✅ |
| 9 | `mono/value` | 12px | Regular (400) | 0 | none | 150% | `font-mono text-xs tabular-nums` | ✅ |
| 10 | `mono/id` | 10px | Regular (400) | 0 | none | 150% | `text-[10px] font-mono` | ✅ |
| 11 | `port-row/type` | 11px | Regular (400) | 0 | none | 150% | `text-[11px]` | ✅ |

## Typography Hierarchy

1. **Headings** (Semi Bold) — Node titles, section headers, category headers
2. **Body** (Regular) — Default labels, descriptions, handle port labels
3. **Labels** (Regular, small) — Parameter labels, category meta, hints
4. **Mono** (Regular, semantic) — Numeric values, IDs, port types
5. **Port Row** (Regular, 11px) — Properties Panel input/output rows

## Usage Map

| Style | Component Usage |
|---|---|
| `heading/node-title` | Node Header title, Properties Panel node name |
| `heading/section` | Properties Panel "PROPERTIES" header |
| `heading/category` | Category Header, Node Palette category labels |
| `body/default` | Palette Item, Plus Minus buttons, Float Slider value, Enum Select value |
| `body/description` | Properties Panel node description |
| `body/handle` | All Labeled Handle port labels (32 variants) |
| `label/param` | Float Slider label, Color Input label, Connectable Param Row labels, Gradient Editor position |
| `label/category-meta` | Properties Panel category label in info card |
| `mono/value` | Zoom Bar percentage, Random Display value |
| `mono/id` | Properties Panel node ID |
| `port-row/type` | Properties Panel input/output port type labels |

## Figma Style IDs

| Style | Figma ID |
|---|---|
| heading/node-title | `S:ae1da69bb6e4f63f683fb1463dfc6bac4c6a9c33,` |
| heading/section | `S:c40fb50e44a65585b2fa14095888cde6cf1a5994,` |
| heading/category | `S:0626cc9a604f91df61f45fcd2c78aaa0076713b3,` |
| body/default | `S:d3ec751216e3caa16d6257f4b9ea912007bb561f,` |
| body/description | `S:fb93df82ffa6661b87498ddbc01d54b00cbf514e,` |
| body/handle | `S:548a13de59211b1cff9cded59773a198a81ed501,` |
| label/param | `S:ede2674e59e24f8d3286655ebf7669b90cc307c4,` |
| label/category-meta | `S:9d4a978168442f111b562b37f9bb8e4de8d3c700,` |
| mono/value | `S:9d5974b42e594da7c6af1dddcd76fa67ac64e3d7,` |
| mono/id | `S:1181640d2c3fd5f4a7bc505ecd6f710e0ce5b517,` |
| port-row/type | `S:3b18697fb26ac85ea535f18904098a0fcde17d2c,` |

## Notes

- Font family is Inter throughout. Monospace styles (`mono/*`) use Inter in Figma but `font-mono` (system `ui-monospace`) in code — this is a known Figma limitation since Inter is not monospace. The styles are named `mono/*` for semantic clarity.
- `tabular-nums` (Tailwind) maps to the OpenType `tnum` feature. In Figma, tabular figures can be enabled per-node but not on the text style itself.
- The 13px font size comes from `.react-flow__node { font-size: 13px }` in `src/index.css`. All Labeled Handle text nodes inherit this size. In Figma, this is represented by the `body/handle` text style.
- `body/description` uses a relaxed line height (162.5% = Tailwind `leading-relaxed`) for better readability in multi-line descriptions.
- Letter spacing values use pixel units for precision: `tracking-wider` (0.05em) = 0.6px at 12px / 0.5px at 10px. `tracking-wide` (0.025em) = 0.25px at 10px.
- All 86 TEXT nodes across 22 components are bound to text styles. Zero unbound text nodes.

## Parity: ✅ All 11 text styles match
