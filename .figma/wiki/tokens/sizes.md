# Sizes

**Figma Collection:** Sizes (`VariableCollectionId:43:3517`)
**Modes:** Single mode (no dark/light variant)
**Usage:** Fixed dimensions for interactive elements — handles, buttons, inputs, thumbnails

## Token Table

| Variable | Figma ID | Value (px) | Code Value | Tailwind Class | Match |
|---|---|---|---|---|---|
| size/handle | `43:3518` | 12 | 12px | `!w-3 !h-3` | ✅ |
| size/icon-xs | `86:2` | 16 | 16px | `w-4 h-4` | ✅ |
| size/button-sm | `43:3519` | 20 | 20px | `w-5 h-5` | ✅ |
| size/input-sm | `43:3520` | 22 | 22px | `h-[22px]` | ✅ |
| size/input-md | `43:3521` | 28 | 28px | `h-7` | ✅ |
| size/swatch | `43:3522` | 24 | 24px | `w-6 h-6` | ✅ |
| size/node-min-w | `43:3523` | 160 | 160px | `min-w-[160px]` | ✅ |
| size/thumb | `43:3524` | 16 | 16px | `h-4 w-4` (slider thumb) | ✅ |
| size/track-h | `43:3525` | 6 | 6px | `h-1.5` | ✅ |

## Usage Map

| Component | Token | Figma | Code | Match |
|---|---|---|---|---|
| Handle (all variants) | size/handle | 12×12 | `!w-3 !h-3` (12px) | ✅ |
| Icon components | size/icon-xs | 16×16 | `w-4 h-4` (16px) | ✅ |
| PlusMinus Button | size/button-sm | 20×20 | `w-5 h-5` (20px) | ✅ |
| Enum Select trigger | size/input-sm | h=22 | `h-[22px]` | ✅ |
| Float Slider container | size/input-md | h=28 | `h-7` (28px) | ✅ |
| Color swatch | size/swatch | 24×24 | `w-6 h-6` (24px) | ✅ |
| Node Card | size/node-min-w | min-w=160 | `min-w-[160px]` | ✅ |
| Float Slider thumb | size/thumb | 16×16 | `h-4 w-4` (16px) | ✅ |
| Float Slider track | size/track-h | h=6 | `h-1.5` (6px) | ✅ |

## Notes

- All size tokens have exact 1:1 matches between Figma and code.
- `!w-3 !h-3` on Handle uses `!important` to override React Flow's default handle sizing.
- `h-[22px]` on Enum Select uses an arbitrary value because Tailwind has no 22px utility.
- `min-w-[160px]` on Node Card uses an arbitrary value for the same reason.

## Parity: ✅ All 9 size tokens match
