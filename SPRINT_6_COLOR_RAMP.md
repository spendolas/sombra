# Sprint 6 — Color Ramp Implementation Guide

## What This Is

Implementation spec for the Color Ramp node — a multi-stop gradient mapper (`float 0-1 → vec3 color`). This is Phase 2 Sprint 6 of Sombra, the biggest single-node addition remaining.

**Design decisions already made:**
- Global interpolation mode (not per-stop) — one enum dropdown for the whole ramp
- Presets: 6 spectra-pixel-bg palettes (colors TBD — see Presets section)
- UX reference: Redshift Ramp node (compact gradient bar + draggable stops)

---

## Deliverables

### File 1: `src/nodes/color/color-ramp.ts`

**Node definition following the `NodeDefinition` interface in `src/nodes/types.ts`.**

| Field | Value |
|-------|-------|
| `type` | `'color_ramp'` |
| `label` | `'Color Ramp'` |
| `category` | `'Color'` |
| `description` | `'Map a float value to a color gradient'` |

**Input port:**

```typescript
inputs: [
  { id: 't', label: 'Value', type: 'float', default: 0.5 }
]
```

`t` should be connectable (`connectable: true` on the param, NOT the input port — follow the pattern in `brightness-contrast.ts` where connectable params appear as both handle and slider). Actually, for Color Ramp, `t` is a pure input port (not a parameter), so just define it as an input. The slider-driven `t` behavior comes naturally from wiring a Float Constant.

**Output port:**

```typescript
outputs: [
  { id: 'color', label: 'Color', type: 'vec3' }
]
```

**Parameters:**

```typescript
params: [
  {
    id: 'interpolation',
    label: 'Interpolation',
    type: 'enum',
    default: 'smooth',
    options: [
      { value: 'smooth', label: 'Smooth' },
      { value: 'linear', label: 'Linear' },
      { value: 'constant', label: 'Constant' },
    ],
  },
  {
    id: 'stops',
    label: 'Stops',
    type: 'float',        // type doesn't matter for hidden params
    default: 0,           // actual default set in component init
    hidden: true,         // not rendered by NodeParameters
  },
]
```

The `stops` param stores the actual array: `Array<{ position: number; color: [number, number, number] }>`. It's typed as `float` with `hidden: true` because the custom component manages it entirely. The real data lives in `node.data.params.stops`.

**Default stops value (set when node is created):**

```typescript
[
  { position: 0.0, color: [0.0, 0.0, 0.0] },    // black
  { position: 1.0, color: [1.0, 1.0, 1.0] },    // white
]
```

This should be set as the `defaults` in the node definition or handled by the component on first render if `data.stops` is undefined.

**GLSL generator:**

```typescript
glsl: (ctx) => {
  const { inputs, outputs, params } = ctx
  const interp = (params.interpolation as string) || 'smooth'

  // Read stops, sort by position
  let stops = params.stops as Array<{ position: number; color: [number, number, number] }>
  if (!stops || stops.length < 2) {
    stops = [
      { position: 0, color: [0, 0, 0] },
      { position: 1, color: [1, 1, 1] },
    ]
  }
  stops = [...stops].sort((a, b) => a.position - b.position)

  const lines: string[] = []
  const c = outputs.color
  const t = inputs.t

  // Initialize with first stop color
  const [r0, g0, b0] = stops[0].color
  lines.push(`vec3 ${c} = vec3(${flt(r0)}, ${flt(g0)}, ${flt(b0)});`)

  // Chain mix() calls for each subsequent stop
  for (let i = 1; i < stops.length; i++) {
    const prev = stops[i - 1]
    const curr = stops[i]
    const [r, g, b] = curr.color
    const colorExpr = `vec3(${flt(r)}, ${flt(g)}, ${flt(b)})`

    let factor: string
    if (Math.abs(curr.position - prev.position) < 0.0001) {
      // Same position — hard step regardless of mode
      factor = `step(${flt(curr.position)}, ${t})`
    } else if (interp === 'smooth') {
      factor = `smoothstep(${flt(prev.position)}, ${flt(curr.position)}, ${t})`
    } else if (interp === 'linear') {
      factor = `clamp((${t} - ${flt(prev.position)}) / (${flt(curr.position)} - ${flt(prev.position)}), 0.0, 1.0)`
    } else {
      // constant
      factor = `step(${flt(curr.position)}, ${t})`
    }

    lines.push(`${c} = mix(${c}, ${colorExpr}, ${factor});`)
  }

  return lines.join('\n  ')
}
```

Helper for float formatting (add at top of file or inline):
```typescript
function flt(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : `${n}`
}
```

**Component field:**

```typescript
component: ColorRampEditor   // imported from '@/components/ColorRampEditor'
```

**Pattern files to reference:**
- `src/nodes/color/brightness-contrast.ts` — simple color node structure
- `src/nodes/noise/noise.ts` — complex node with params access in glsl
- `src/nodes/math/arithmetic.ts` — hidden params pattern

---

### File 2: `src/components/ColorRampEditor.tsx`

**Custom React component for the gradient editor.**

**Props:** `{ nodeId: string; data: Record<string, unknown> }` (per `types.ts:104`)

**Core state:**
- Read stops from `data.stops` (fallback to default black-white if undefined)
- Selected stop index (local React state)
- Update stops via `useGraphStore(s => s.updateNodeData)`

**Layout:**

```
┌──────────────────────────────┐
│  ██ gradient bar (24px) ███  │  CSS linear-gradient, rounded, full width
│  ▼    ▼         ▼        ▼  │  stop markers (colored circles, 10-12px)
│  [🎨] 45%        [+] [-]   │  selected stop: color picker + position + add/remove
│  [preset ▼]                  │  preset dropdown
└──────────────────────────────┘
```

**Gradient bar:**

Use CSS `background: linear-gradient(to right, ...)` computed from sorted stops. Each stop becomes a color-stop in the gradient. Convert RGB 0-1 to CSS `rgb()` values.

```typescript
const gradientCSS = sortedStops
  .map(s => `rgb(${Math.round(s.color[0]*255)}, ${Math.round(s.color[1]*255)}, ${Math.round(s.color[2]*255)}) ${s.position * 100}%`)
  .join(', ')
// style={{ background: `linear-gradient(to right, ${gradientCSS})` }}
```

Note: inline `style` is justified here because CSS gradient values are dynamic runtime data, not Sombra design tokens.

**Stop markers:**

Position absolutely below the gradient bar. Each marker is a small circle (`w-3 h-3 rounded-full`) with background color matching the stop's color. Selected marker gets a ring (`ring-2 ring-indigo`).

**Dragging stops:**

```typescript
const handlePointerDown = (e: React.PointerEvent, index: number) => {
  e.stopPropagation()  // prevent React Flow node drag
  setSelectedIndex(index)
  const bar = barRef.current!
  const rect = bar.getBoundingClientRect()

  const onMove = (e: PointerEvent) => {
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    updateStop(index, { ...stops[index], position: x })
  }
  const onUp = () => {
    document.removeEventListener('pointermove', onMove)
    document.removeEventListener('pointerup', onUp)
  }
  document.addEventListener('pointermove', onMove)
  document.addEventListener('pointerup', onUp)
}
```

**CRITICAL:** Add className `nodrag nowheel` to the gradient bar container and stop markers. React Flow respects these classes and won't initiate node drag or zoom on these elements. Without this, dragging a stop would drag the entire node.

**Add stop:** Click on gradient bar → calculate position from click X, interpolate color from neighboring stops, insert new stop, select it.

**Remove stop:** Delete selected stop (button disabled when ≤ 2 stops).

**Color picker:** HTML `<input type="color">` for selected stop. Follow the hex conversion pattern from `NodeParameters.tsx` (lines 184-211):
```typescript
const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0')
const hexColor = `#${toHex(r)}${toHex(g)}${toHex(b)}`
```

**Preset buttons:** Small labeled buttons or a `<Select>` dropdown. Each preset replaces `stops` entirely. Preset data stored as constants (separate file or top of component).

**Updating the store:**

```typescript
const updateNodeData = useGraphStore(s => s.updateNodeData)

function updateStops(newStops: ColorStop[]) {
  updateNodeData(nodeId, {
    params: { ...data, stops: newStops }
  })
}
```

**Styling:**
- Use Sombra design tokens: `bg-surface-raised`, `border-edge`, `text-fg-dim`, etc.
- Gradient bar: inline `style` for the dynamic gradient (justified — runtime computed)
- Stop marker colors: inline `style` for background-color (justified — per-stop runtime data)
- Everything else: Tailwind utility classes only

**Pattern files to reference:**
- `src/components/NodeParameters.tsx` lines 184-211 — color picker hex conversion
- `src/components/ShaderNode.tsx` lines 72-81 — handleParamChange / updateNodeData pattern

---

### File 3: Modify `src/nodes/index.ts`

Add at the top with other color imports:
```typescript
import { colorRampNode } from './color/color-ramp'
```

Add to `ALL_NODES` array in the Color section:
```typescript
// Color
hsvToRgbNode,
brightnessContrastNode,
colorRampNode,          // ← new
```

Node count: 19 → 20.

---

## What NOT to Change

- **`src/compiler/glsl-generator.ts`** — no changes. The `glsl()` function on the node definition handles everything. `ctx.params.stops` is available via the standard params pipeline.
- **`src/nodes/types.ts`** — no changes. `component` field and `Record<string, unknown>` params already handle arrays.
- **`src/components/ShaderNode.tsx`** — already renders `definition.component` at lines 290-295.
- **`src/components/PropertiesPanel.tsx`** — already renders `definition.component` at lines 218-232.
- **`src/components/NodeParameters.tsx`** — stops managed by custom component, not the param system.

---

## Presets

**6 palette presets from spectra-pixel-bg.** User will provide exact colors. Placeholder structure:

```typescript
interface ColorStop {
  position: number
  color: [number, number, number]
}

interface Preset {
  name: string
  stops: ColorStop[]
}

// All presets: 5 stops evenly spaced at 0.0, 0.25, 0.5, 0.75, 1.0
// Colors from spectra-pixel-bg, converted from hex to RGB floats (0-1)

const PRESETS: Preset[] = [
  {
    name: 'Cobalt Drift',
    stops: [
      { position: 0.0,  color: [0.020, 0.027, 0.051] },  // #05070d
      { position: 0.25, color: [0.137, 0.231, 0.416] },  // #233b6a
      { position: 0.5,  color: [0.235, 0.435, 1.000] },  // #3c6fff
      { position: 0.75, color: [0.549, 0.776, 1.000] },  // #8cc6ff
      { position: 1.0,  color: [0.663, 0.729, 0.839] },  // #a9bad6
    ],
  },
  {
    name: 'Violet Ember',
    stops: [
      { position: 0.0,  color: [0.039, 0.027, 0.063] },  // #0a0710
      { position: 0.25, color: [0.165, 0.059, 0.231] },  // #2a0f3b
      { position: 0.5,  color: [0.416, 0.122, 0.820] },  // #6a1fd1
      { position: 0.75, color: [1.000, 0.416, 0.835] },  // #ff6ad5
      { position: 1.0,  color: [0.957, 0.725, 0.882] },  // #f4b9e1
    ],
  },
  {
    name: 'Teal Afterglow',
    stops: [
      { position: 0.0,  color: [0.016, 0.031, 0.039] },  // #04080a
      { position: 0.25, color: [0.059, 0.184, 0.227] },  // #0f2f3a
      { position: 0.5,  color: [0.110, 0.624, 0.651] },  // #1c9fa6
      { position: 0.75, color: [0.412, 0.753, 0.702] },  // #69c0b3
      { position: 1.0,  color: [0.831, 0.929, 0.882] },  // #d4ede1
    ],
  },
  {
    name: 'Solar Ember',
    stops: [
      { position: 0.0,  color: [0.063, 0.024, 0.020] },  // #100605
      { position: 0.25, color: [0.231, 0.059, 0.039] },  // #3b0f0a
      { position: 0.5,  color: [0.533, 0.153, 0.102] },  // #88271a
      { position: 0.75, color: [0.741, 0.361, 0.141] },  // #bd5c24
      { position: 1.0,  color: [1.000, 0.820, 0.541] },  // #ffd18a
    ],
  },
  {
    name: 'Citrus Pulse',
    stops: [
      { position: 0.0,  color: [0.059, 0.027, 0.020] },  // #0f0705
      { position: 0.25, color: [0.227, 0.118, 0.047] },  // #3a1e0c
      { position: 0.5,  color: [0.478, 0.247, 0.086] },  // #7a3f16
      { position: 0.75, color: [0.612, 0.322, 0.114] },  // #9c521d
      { position: 1.0,  color: [0.839, 0.627, 0.361] },  // #d6a05c
    ],
  },
  {
    name: 'Rose Heat',
    stops: [
      { position: 0.0,  color: [0.071, 0.020, 0.027] },  // #120507
      { position: 0.25, color: [0.231, 0.039, 0.094] },  // #3b0a18
      { position: 0.5,  color: [0.639, 0.090, 0.247] },  // #a3173f
      { position: 0.75, color: [1.000, 0.294, 0.431] },  // #ff4b6e
      { position: 1.0,  color: [1.000, 0.753, 0.784] },  // #ffc0c8
    ],
  },
]
```

---

## Verification

1. `npm run build` — no TypeScript errors
2. `npm run lint` — clean
3. `npm run dev` → manual test:
   - Drag "Color Ramp" from palette onto canvas
   - Verify default black-to-white gradient preview appears in node
   - Wire: Noise `value` → Color Ramp `t`, Color Ramp `color` → Fragment Output `color`
   - See colored noise in shader preview
   - Drag stops — gradient and shader update live
   - Change stop colors via picker — updates live
   - Switch interpolation (smooth/linear/constant) — visible difference
   - Add stop (click gradient bar or + button) — new stop appears
   - Remove stop (- button) — stop removed, min 2 enforced
   - Load preset — all stops replaced
   - Open PropertiesPanel — same gradient editor works at wider width

---

## Implementation Order

1. `color-ramp.ts` — node definition with GLSL generator, hardcoded 2-stop default
2. Register in `index.ts`
3. Test: add node, wire it, verify GLSL output compiles and renders
4. `ColorRampEditor.tsx` — gradient bar + stop markers + color pickers
5. Wire component into node definition
6. Test: full interactive gradient editing
7. Add presets
8. Polish: drag feel, visual alignment, edge cases

---

## Delete This File

This is a one-time implementation guide. Delete `SPRINT_6_COLOR_RAMP.md` after the sprint is complete and changes are committed.
