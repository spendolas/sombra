# Spacing

**Figma Collection:** Spacing (`VariableCollectionId:17:914`)
**Modes:** Single mode (no dark/light variant)
**Usage:** Padding, gap, margin values throughout all components

## Token Table

| Variable | Figma ID | Value (px) | Common Tailwind Classes | Match |
|---|---|---|---|---|
| spacing/xs | `17:915` | 4 | `p-1`, `gap-1` | ✅ |
| spacing/sm | `17:916` | 6 | `gap-1.5`, `px-1.5` | ✅ |
| spacing/md | `17:917` | 8 | `p-2`, `gap-2` | ✅ |
| spacing/lg | `17:918` | 12 | `p-3`, `gap-3` | ✅ |
| spacing/xl | `17:919` | 16 | `p-4`, `gap-4` | ✅ |
| spacing/2xl | `17:920` | 24 | `p-6`, `gap-6` | ✅ |

## Usage Map

| Component | Property | Token | Value | Tailwind |
|---|---|---|---|---|
| Node Card header | padding-x | lg (12) | 12px | `px-3` |
| Node Card header | padding-y | md (8) | 8px | `py-2` |
| Node Card content | padding | lg (12) | 12px | `p-3` |
| Node Card content | gap | md (8) | 8px | `gap-y-2` |
| Float Slider | track padding | xs (4) | 4px | `p-1` |
| Node Palette | item gap | xs (4) | 4px | `gap-1` |
| Node Palette | section gap | md (8) | 8px | `gap-2` |
| Labeled Handle | label gap | sm (6) | 6px | `gap-1.5` |
| Connectable Param Row | handle inset-left | xl (16) | 16px | `left-4` (absolute) |

## Notes

- Tailwind's spacing scale (1=4px, 2=8px, 3=12px, etc.) maps cleanly to the Figma token values.
- `spacing/sm` (6px) maps to Tailwind `1.5` (6px) — less common but used for tight label gaps.
- Some Figma paddings use compound values (e.g., `paddingLeft=12, paddingRight=12`) which map to `px-3`.

## Parity: ✅ All 6 spacing tokens match
