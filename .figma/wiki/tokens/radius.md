# Radius

**Figma Collection:** Radius (`VariableCollectionId:17:921`)
**Modes:** Single mode (no dark/light variant)
**Usage:** Corner radius on cards, buttons, inputs, handles

## Token Table

| Variable | Figma ID | Value (px) | Tailwind Class | Match |
|---|---|---|---|---|
| radius/sm | `17:922` | 4 | `rounded-sm` (4px via `calc(var(--radius) - 4px)` → `0.625rem - 4px ≈ 6px`) | ⚠️ |
| radius/md | `17:923` | 8 | `rounded-md` (8px via `calc(var(--radius) - 2px)` → `0.625rem - 2px ≈ 8px`) | ✅ |
| radius/lg | `17:924` | 10 | `rounded-lg` (10px via `var(--radius)` → `0.625rem = 10px`) | ✅ |
| radius/full | `17:925` | 9999 | `rounded-full` (9999px) | ✅ |

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
| Handle | radius/full | 9999px | `rounded-full` | ✅ |
| Node Card | radius/md | 8px | `rounded-md` | ✅ |
| Float Slider thumb | radius/full | 9999px | `rounded-full` | ✅ |
| Float Slider track | radius/full | 9999px | `rounded-full` | ✅ |
| Enum Select | radius/sm | 4px | `rounded-sm` | ⚠️ |
| Palette Item | radius/sm | 4px | `rounded-sm` | ⚠️ |
| Zoom Bar | radius/sm | 4px | `rounded-sm` | ⚠️ |
| Floating Preview | radius/md | 8px | `rounded-md` | ✅ |

## Notes

- **⚠️ radius/sm discrepancy**: Figma token is 4px, but shadcn's `rounded-sm` computes to ~6px. Components using `radius/sm` in Figma render at 4px, while the app's `rounded-sm` is ~6px. This is a known minor difference — the visual impact is negligible at these small values.
- `radius/md` and `radius/lg` are exact matches.
- `radius/full` (9999px) is used for all circular elements (handles, slider thumbs/tracks).

## Parity: ⚠️ 3/4 exact match, 1 minor discrepancy (radius/sm: 4px vs ~6px)
