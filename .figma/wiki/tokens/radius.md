# Radius

**Figma Collection:** Radius (`VariableCollectionId:106:33`)
**Modes:** Single mode (no dark/light variant)
**Usage:** Corner radius on cards, buttons, inputs, handles

## Token Table

| Variable | Figma ID | Value (px) | Tailwind Class | Match |
|---|---|---|---|---|
| sm/4 | `106:34` | 4 | `rounded-sm` (4px via `calc(var(--radius) - 4px)` → `0.625rem - 4px ≈ 6px`) | ⚠️ |
| md/8 | `106:35` | 8 | `rounded-md` (8px via `calc(var(--radius) - 2px)` → `0.625rem - 2px ≈ 8px`) | ✅ |
| lg/10 | `106:36` | 10 | `rounded-lg` (10px via `var(--radius)` → `0.625rem = 10px`) | ✅ |
| full/9999 | `106:37` | 9999 | `rounded-full` (9999px) | ✅ |

## shadcn Radius Base

The app uses shadcn's `--radius: 0.625rem` (10px) as the base. Tailwind computes radius classes from this:

```
--radius-sm:  calc(0.625rem - 4px) ≈ 6px   ← Figma says 4px
--radius-md:  calc(0.625rem - 2px) ≈ 8px   ← Figma says 8px ✅
--radius-lg:  0.625rem = 10px               ← Figma says 10px ✅
```

## Usage Map

| Component | Token | Value | Tailwind | Match |
|---|---|---|---|---|
| Handle | full/9999 | 9999px | `rounded-full` | ✅ |
| Node Card | md/8 | 8px | `rounded-md` | ✅ |
| Float Slider thumb | full/9999 | 9999px | `rounded-full` | ✅ |
| Float Slider track | full/9999 | 9999px | `rounded-full` | ✅ |
| Enum Select | sm/4 | 4px | `rounded-sm` | ⚠️ |
| Palette Item | sm/4 | 4px | `rounded-sm` | ⚠️ |
| Zoom Bar | sm/4 | 4px | `rounded-sm` | ⚠️ |
| Floating Preview | md/8 | 8px | `rounded-md` | ✅ |

## Notes

- **⚠️ sm/4 discrepancy**: Figma token is 4px, but shadcn's `rounded-sm` computes to ~6px. Components using `sm/4` in Figma render at 4px, while the app's `rounded-sm` is ~6px. This is a known minor difference — the visual impact is negligible at these small values.
- `md/8` and `lg/10` are exact matches.
- `full/9999` (9999px) is used for all circular elements (handles, slider thumbs/tracks).
- All radius properties across all 22 components are bound to V2 collection variables (`106:*`).

## Parity: ⚠️ 3/4 exact match, 1 minor discrepancy (sm/4: 4px vs ~6px)
