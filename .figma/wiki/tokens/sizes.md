# Sizes

**Figma Collection:** Sizes (`VariableCollectionId:106:38`)
**Modes:** Single mode (no dark/light variant)
**Usage:** Fixed dimensions for interactive elements — handles, buttons, inputs, thumbnails

## Token Table

| Variable | Figma ID | Value (px) | Code Value | Tailwind Class | Match |
|---|---|---|---|---|---|
| handle | `106:39` | 12 | 12px | `!w-3 !h-3` | ✅ |
| icon/sm | `106:40` | 16 | 16px | `w-4 h-4` | ✅ |
| icon/md | `106:41` | 20 | 20px | `w-5 h-5` | ✅ |
| btn/sm | `106:42` | 20 | 20px | `w-5 h-5` | ✅ |
| input/h | `106:43` | 24 | 24px | `w-6 h-6` | ✅ |
| select/h | `106:44` | 28 | 28px | `h-7` | ✅ |
| slider/track | `106:45` | 6 | 6px | `h-1.5` | ✅ |
| slider/thumb | `106:46` | 16 | 16px | `h-4 w-4` | ✅ |
| node/min-w | `106:47` | 160 | 160px | `min-w-[160px]` | ✅ |

## Usage Map

| Component | Token | Figma | Code | Match |
|---|---|---|---|---|
| Handle (all variants) | handle | 12×12 | `!w-3 !h-3` (12px) | ✅ |
| Icon components | icon/sm | 16×16 | `w-4 h-4` (16px) | ✅ |
| PlusMinus Button | btn/sm | 20×20 | `w-5 h-5` (20px) | ✅ |
| Color swatch | input/h | 24×24 | `w-6 h-6` (24px) | ✅ |
| Float Slider container | select/h | h=28 | `h-7` (28px) | ✅ |
| Node Card | node/min-w | min-w=160 | `min-w-[160px]` | ✅ |
| Float Slider thumb | slider/thumb | 16×16 | `h-4 w-4` (16px) | ✅ |
| Float Slider track | slider/track | h=6 | `h-1.5` (6px) | ✅ |

## Notes

- All size tokens have exact 1:1 matches between Figma and code.
- `!w-3 !h-3` on Handle uses `!important` to override React Flow's default handle sizing.
- `min-w-[160px]` on Node Card uses an arbitrary value because Tailwind has no 160px utility.
- `icon/md` and `btn/sm` share the same 20px value but serve different semantic roles (icons vs buttons).
- All size properties across all 22 components are bound to V2 collection variables (`106:*`).

## Parity: ✅ All 9 size tokens match
