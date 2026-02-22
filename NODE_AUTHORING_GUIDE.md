# Node Authoring Guide

Reference for adding new nodes to the Sombra shader graph.

---

## 1. Quick Start

### Minimal node (copy-paste skeleton)

Create `src/nodes/<category>/<name>.ts`:

```ts
import type { NodeDefinition } from '../types'

export const myNode: NodeDefinition = {
  type: 'my_node',           // Unique snake_case ID
  label: 'My Node',          // Display name in palette
  category: 'Math',          // Palette group: Input | Math | Noise | Color | Output
  description: 'Does X',     // Tooltip text

  inputs: [
    { id: 'a', label: 'A', type: 'float', default: 0.0 },
  ],

  outputs: [
    { id: 'result', label: 'Result', type: 'float' },
  ],

  params: [
    { id: 'strength', label: 'Strength', type: 'float', default: 1.0, min: 0.0, max: 2.0, step: 0.1 },
  ],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    return `float ${outputs.result} = ${inputs.a} * ${inputs.strength};`
  },
}
```

### Register it

In `src/nodes/index.ts`, add the import and array entry:

```ts
import { myNode } from './math/my-node'

export const ALL_NODES = [
  // ... existing nodes
  myNode,       // Add to the correct category group
]
```

That's it. The node appears in the palette, compiles to GLSL, and renders on the canvas automatically.

---

## 2. NodeDefinition Reference

### Top-level fields

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `string` | Yes | Unique identifier, snake_case (e.g. `'float_constant'`) |
| `label` | `string` | Yes | Display name in palette and node header |
| `category` | `string` | Yes | Palette grouping: `'Input'`, `'Math'`, `'Noise'`, `'Color'`, `'Output'` |
| `description` | `string` | No | Tooltip in palette |
| `inputs` | `PortDefinition[]` | Yes | Input ports (can be empty `[]`) |
| `outputs` | `PortDefinition[]` | Yes | Output ports |
| `params` | `NodeParameter[]` | No | Tweakable controls (sliders, dropdowns, color pickers) |
| `glsl` | `(ctx: GLSLContext) => string` | Yes | GLSL code generator |
| `dynamicInputs` | `(params) => PortDefinition[]` | No | Variable port count based on params |
| `functionKey` | `string \| ((params) => string)` | No | GLSL function name for fnref outputs |
| `component` | `React.ComponentType` | No | Custom UI below standard controls |

### PortDefinition

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | Unique within the node (e.g. `'value'`, `'coords'`) |
| `label` | `string` | Yes | Displayed next to the handle |
| `type` | `PortType` | Yes | Data type (see table below) |
| `default` | `unknown` | No | Value when unconnected. Special: `'auto_uv'` for vec2 inputs |

### NodeParameter

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | Unique within params |
| `label` | `string` | Yes | UI label |
| `type` | `'float' \| 'vec2' \| 'vec3' \| 'color' \| 'enum'` | Yes | Control type |
| `default` | `number \| string \| [n,n] \| [n,n,n]` | Yes | Initial value |
| `min` | `number` | No | Slider minimum (float only) |
| `max` | `number` | No | Slider maximum (float only) |
| `step` | `number` | No | Slider step increment (float only) |
| `options` | `Array<{value, label}>` | No | Dropdown choices (enum only) |
| `connectable` | `boolean` | No | If true, renders as wirable handle + inline slider |
| `showWhen` | `Record<string, string>` | No | Only visible when other params match values |
| `hidden` | `boolean` | No | If true, stored in data but not rendered |

### Port types

| Type | GLSL | Default format | Handle color (dark) | Handle color (light) |
|---|---|---|---|---|
| `float` | `float` | `1.0` | `#d4d4d8` | `#71717a` |
| `vec2` | `vec2` | `vec2(0.0, 0.0)` | `#34d399` | `#059669` |
| `vec3` | `vec3` | `vec3(0.0, 0.0, 0.0)` | `#60a5fa` | `#2563eb` |
| `vec4` | `vec4` | `vec4(0.0, 0.0, 0.0, 1.0)` | `#a78bfa` | `#7c3aed` |
| `color` | `vec3` (alias) | `vec3(r, g, b)` | `#fbbf24` | `#d97706` |
| `sampler2D` | `sampler2D` | — | `#f472b6` | `#db2777` |
| `fnref` | function name string | `'snoise3d_01'` | `#22d3ee` | `#0891b2` |

### Type coercion (auto-conversion between connected ports)

| From | To | GLSL expression |
|---|---|---|
| `float` | `vec2` / `vec3` / `vec4` | `vec2(v)` / `vec3(v)` / `vec4(v)` |
| `vec2` | `vec3` | `vec3(v, 0.0)` |
| `vec2` | `vec4` | `vec4(v, 0.0, 1.0)` |
| `vec3` | `vec4` | `vec4(v, 1.0)` |
| `vec4` | `vec3` | `v.rgb` |
| `vec3` / `vec4` | `vec2` | `v.xy` |
| `color` | `vec3` | no-op (alias) |

---

## 3. Parameter Patterns

### Float slider

```ts
{ id: 'scale', label: 'Scale', type: 'float', default: 5.0, min: 0.1, max: 20.0, step: 0.1 }
```

Renders as label + numeric input + slider. Value accessed via `ctx.params.scale`.

### Enum dropdown

```ts
{
  id: 'operation', label: 'Operation', type: 'enum', default: 'add',
  options: [
    { value: 'add', label: 'Add' },
    { value: 'multiply', label: 'Multiply' },
  ],
}
```

Renders as label + shadcn Select. Value accessed via `ctx.params.operation`.

### Color picker

```ts
{ id: 'color', label: 'Color', type: 'color', default: [1.0, 0.0, 1.0] }
```

Default is `[r, g, b]` in 0-1 range. Value accessed via `ctx.params.color`.

### Connectable param

```ts
{ id: 'factor', label: 'Factor', type: 'float', default: 0.5, min: 0.0, max: 1.0, step: 0.01, connectable: true }
```

Adds a wirable handle on the left side of the node. When unwired, uses slider value. When wired, receives source node's output. In your GLSL function, **always use `ctx.inputs.factor`** (never `ctx.params.factor`) — the compiler resolves it to either the slider value or the source variable.

**See:** `src/nodes/math/mix.ts` for simplest example.

### Conditional visibility (showWhen)

```ts
{ id: 'boxFreq', label: 'Box Freq', type: 'float', default: 1.0, connectable: true,
  showWhen: { noiseType: 'box' } }
```

Only visible when `params.noiseType === 'box'`. Keys/values are strings, matched with `===`.

**See:** `src/nodes/noise/noise.ts` for full example.

### Hidden param

```ts
{ id: 'inputCount', label: 'Input Count', type: 'float', default: 2, min: 2, max: 8, step: 1, hidden: true }
```

Not rendered in UI. Used for internal state like dynamic input count. ShaderNode.tsx auto-renders +/- buttons when `dynamicInputs` is defined.

### Dynamic inputs

```ts
dynamicInputs: (params) => {
  const count = Math.max(2, Math.min(8, Number(params.inputCount) || 2))
  return Array.from({ length: count }, (_, i) => ({
    id: `in_${i}`,
    label: String.fromCharCode(65 + i),  // A, B, C, D...
    type: 'float' as const,
    default: 0.0,
  }))
},
// Also provide static `inputs` as fallback:
inputs: [
  { id: 'in_0', label: 'A', type: 'float', default: 0.0 },
  { id: 'in_1', label: 'B', type: 'float', default: 0.0 },
],
```

The compiler calls `dynamicInputs(params)` when present, otherwise falls back to static `inputs`. ShaderNode.tsx auto-renders +/- buttons.

**See:** `src/nodes/math/arithmetic.ts` for full example.

---

## 4. GLSL Generation Patterns

The `glsl(ctx)` function receives a `GLSLContext` and returns a GLSL code string. The compiler handles everything else — variable naming, input resolution, type coercion, and shader assembly.

### GLSLContext fields

| Field | Type | What it contains |
|---|---|---|
| `nodeId` | `string` | React Flow node ID (has hyphens) |
| `inputs` | `Record<string, string>` | Port/param IDs mapped to GLSL expressions |
| `outputs` | `Record<string, string>` | Port IDs mapped to output variable names |
| `params` | `Record<string, unknown>` | Raw parameter values |
| `uniforms` | `Set<string>` | Add uniform names here; compiler declares them |
| `functions` | `string[]` | Legacy; prefer `addFunction` instead |
| `functionRegistry` | `Map<string, string>` | Deduplicated GLSL functions |

### Pattern: Simple variable declaration

```ts
// Float Constant — src/nodes/input/float-constant.ts
glsl: (ctx) => {
  const value = ctx.params.value ?? 1.0
  const valueStr = Number.isInteger(value as number) ? `${value}.0` : `${value}`
  return `float ${ctx.outputs.value} = ${valueStr};`
}
```

### Pattern: Using uniforms

```ts
// Time — src/nodes/input/time.ts
glsl: (ctx) => {
  ctx.uniforms.add('u_time')
  return `float ${ctx.outputs.time} = u_time;`
}
```

Available uniforms: `u_time` (float), `u_resolution` (vec2), `u_mouse` (vec2), `u_ref_size` (float).

### Pattern: Multi-line GLSL

```ts
// UV Coordinates — src/nodes/input/uv-coords.ts
glsl: (ctx) => {
  ctx.uniforms.add('u_resolution')
  ctx.uniforms.add('u_ref_size')
  const uv = ctx.outputs.uv
  const c = `${uv}_c`       // Scoped temp variable
  const s = `${uv}_s`       // Scoped temp variable
  return `vec2 ${uv} = (v_uv - 0.5) * u_resolution / u_ref_size + 0.5;
${uv} -= 0.5;
${uv} *= vec2(${ctx.inputs.scaleX}, ${ctx.inputs.scaleY});
float ${c} = cos(${ctx.inputs.rotate});
float ${s} = sin(${ctx.inputs.rotate});
${uv} = vec2(${uv}.x * ${c} - ${uv}.y * ${s}, ${uv}.x * ${s} + ${uv}.y * ${c});
${uv} += vec2(${ctx.inputs.offsetX}, ${ctx.inputs.offsetY}) + 0.5;`
}
```

### Pattern: Function registration (addFunction)

```ts
import { addFunction } from '../types'

glsl: (ctx) => {
  addFunction(ctx, 'hash3', `float hash3(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}`)
  return `float ${ctx.outputs.value} = hash3(vec3(${ctx.inputs.coords}, 0.0));`
}
```

`addFunction` is idempotent — if 5 nodes register `hash3`, it appears in the shader once. **Never push to `ctx.functions` directly.**

### Pattern: Instance-unique functions

When multiple instances of the same node can exist simultaneously, include the node ID in the function key to avoid collisions:

```ts
// FBM — src/nodes/noise/fbm.ts
glsl: (ctx) => {
  const sanitizedId = ctx.nodeId.replace(/-/g, '_')
  const fbmKey = `fbm_${sanitizedId}`

  addFunction(ctx, fbmKey, `float ${fbmKey}(vec3 p, float oct, float lac, float g) {
  // ... loop body uses noiseFn
}`)

  return `float ${ctx.outputs.value} = ${fbmKey}(...);`
}
```

This is only needed when the function body varies per instance (e.g., different noise function wired via fnref). If the function body is always identical, use a shared key.

### Pattern: fnref — producing

Add `functionKey` to your definition and an fnref output port:

```ts
// Noise — src/nodes/noise/noise.ts
functionKey: (params) => {
  const map = { simplex: 'snoise3d_01', value: 'vnoise3d', worley: 'worley3d', box: 'boxnoise3d' }
  return map[(params.noiseType as string) || 'simplex']
},

outputs: [
  { id: 'value', label: 'Value', type: 'float' },
  { id: 'fn', label: 'Fn', type: 'fnref' },
],
```

The compiler resolves `functionKey(params)` and passes the function name string to connected consumer nodes.

### Pattern: fnref — consuming

Accept an fnref input with a fallback default:

```ts
// FBM — src/nodes/noise/fbm.ts
inputs: [
  { id: 'noiseFn', label: 'Noise Fn', type: 'fnref', default: 'snoise3d_01' },
],

glsl: (ctx) => {
  const noiseFn = ctx.inputs.noiseFn   // "snoise3d_01" or wired function name
  registerSimplexFallback(ctx)          // Always register fallback (idempotent)
  return `... ${noiseFn}(p) * amp ...`  // Call it by name
}
```

All fnref noise functions share the signature `float name(vec3 p)`.

### Pattern: auto_uv sentinel

For nodes that accept UV coordinates but should work without explicit wiring:

```ts
inputs: [
  { id: 'coords', label: 'Coords', type: 'vec2', default: 'auto_uv' },
]
```

When unconnected, the compiler generates frozen-reference UV inline:
```glsl
vec2 node_X_auto_uv = (v_uv - 0.5) * u_resolution / u_ref_size + 0.5;
```

### Pattern: Enum-driven GLSL

```ts
glsl: (ctx) => {
  const op = (ctx.params.operation as string) || 'add'
  const symbol = { add: '+', subtract: '-', multiply: '*', divide: '/' }[op] || '+'
  return `float ${ctx.outputs.result} = ${ctx.inputs.in_0} ${symbol} ${ctx.inputs.in_1};`
}
```

### Pattern: Connectable params with loop bounds

GLSL requires constant loop bounds. Use a fixed max with early break:

```ts
// Octaves can be wired to a dynamic value
addFunction(ctx, fbmKey, `float ${fbmKey}(vec3 p, float oct, ...) {
  for (int i = 0; i < 8; i++) {
    if (float(i) >= oct) break;   // Runtime octaves with early exit
    ...
  }
}`)
```

---

## 5. Gotchas

| Issue | Wrong | Right |
|---|---|---|
| Float literals | `return '... = 5;'` | `return '... = 5.0;'` (GLSL ES 3.0 requires decimal) |
| Function registration | `ctx.functions.push(code)` | `addFunction(ctx, key, code)` (deduplicates) |
| Connectable param values | `ctx.params.factor` | `ctx.inputs.factor` (resolved to GLSL expression by compiler) |
| GLSL variable names | `node_${ctx.nodeId}_out` | `node_${ctx.nodeId.replace(/-/g, '_')}_out` (hyphens invalid in GLSL) |
| Temp variable collisions | `float c = cos(...)` | `float ${outputs.uv}_c = cos(...)` (scope with output var) |
| Enum value matching | option `'addition'`, switch `'add'` | option value and switch case must match exactly |
| showWhen types | `showWhen: { octaves: 4 }` | `showWhen: { noiseType: 'box' }` (values are strings, matched via `===`) |
| Dynamic inputs without fallback | only `dynamicInputs` | must also provide static `inputs` array as fallback |
| Output variable naming | done manually | compiler auto-generates as `node_<sanitizedId>_<portId>` — just use `ctx.outputs.portId` |

---

## 6. Figma DS Checklist

When a new node is added to the code, a matching template should be created in the Figma design system file (`gq5i0l617YkXy0GzAZPtqz`).

### Steps

1. **Open Templates page** in the Figma file
2. **Create an instance** of the Node Card organism component
3. **Override the Title** text property with the node's `label`
4. **Toggle boolean properties** to show only the sections your node needs:
   - `showOutput1`, `showOutput2` — output handles
   - `showInput1` through `showInput5` — input handles
   - `showConnectable1` through `showConnectable5` — connectable param rows
   - `showDynamicButtons` — +/- buttons for dynamic inputs
   - `showEnum1`, `showEnum2` — enum dropdowns
   - `showSlider1`, `showSlider2` — non-connectable float sliders
   - `showColorPicker` — color picker
   - `showParamSeparator` — separator line before params section
5. **Override labels** on each visible Labeled Handle, slider, and enum
6. **Swap Handle variants** to match port types:
   - Each Labeled Handle has variants: `position` (left/right) x `portType` (float/vec2/vec3/vec4/color/sampler2D/fnref/default)
   - Swap to the correct portType for each handle
7. **Set connected state** on handles in scene templates (Default Graph, Sombra App) — swap to `connected=true` variant

### Separator rule

A separator line (`border-t border-edge-subtle`) appears in the node UI only when:
- There are non-connectable params (enums, regular sliders) — separator goes above them
- OR there's a custom component AND no non-connectable params — separator goes above it
- Nodes with ONLY pure inputs and connectable params have NO separator

### Variable collections reference

Key variable collections (full IDs in Claude memory file `figma-ds.md`):
- **UI Colors** (17:7) — surface, fg, edge, indigo tokens with Dark/Light modes
- **Port Types** (17:21) — handle stroke colors with Dark/Light modes
- **Spacing** (17:914) — xs(4), sm(6), md(8), lg(12), xl(16), 2xl(24)
- **Radius** (17:921) — sm(4), md(8), lg(10), full(9999)
- **Sizes** (43:3517) — handle(12), button-sm(20), input-sm(22), input-md(28), swatch(24), node-min-w(160), thumb(16), track-h(6)

---

## 7. Node Inventory

| Type | Label | Category | File | Features |
|---|---|---|---|---|
| `float_constant` | Number | Input | `input/float-constant.ts` | — |
| `color_constant` | Color | Input | `input/color-constant.ts` | color param |
| `vec2_constant` | Vec2 | Input | `input/vec2-constant.ts` | — |
| `uv_coords` | UV Coordinates | Input | `input/uv-coords.ts` | connectable (5 SRT params) |
| `time` | Time | Input | `input/time.ts` | uniform |
| `resolution` | Resolution | Input | `input/resolution.ts` | uniform |
| `arithmetic` | Arithmetic | Math | `math/arithmetic.ts` | enum, dynamicInputs, hidden |
| `trig` | Trig | Math | `math/trig.ts` | enum, connectable |
| `mix` | Mix | Math | `math/mix.ts` | connectable |
| `smoothstep` | Smoothstep | Math | `math/smoothstep.ts` | — |
| `remap` | Remap | Math | `math/remap.ts` | — |
| `turbulence` | Turbulence | Math | `math/turbulence.ts` | — |
| `ridged` | Ridged | Math | `math/ridged.ts` | — |
| `noise` | Noise | Noise | `noise/noise.ts` | enum, connectable, fnref output, auto_uv, showWhen, addFunction |
| `fbm` | FBM | Noise | `noise/fbm.ts` | connectable (4), enum, fnref input, auto_uv, instance-unique function |
| `domain_warp` | Domain Warp | Noise | `noise/domain-warp.ts` | connectable, fnref input, auto_uv, addFunction |
| `hsv_to_rgb` | HSV to RGB | Color | `color/hsv-to-rgb.ts` | GLSL helper function |
| `brightness_contrast` | Brightness/Contrast | Color | `color/brightness-contrast.ts` | connectable |
| `color_ramp` | Color Ramp | Color | `color/color-ramp.ts` | enum, hidden param, custom component (ColorRampEditor), presets |
| `pixel_grid` | Pixel Grid | Post-process | `postprocess/pixel-grid.ts` | connectable (2), enum, addFunction (bayer + SDF), gl_FragCoord |
| `bayer_dither` | Bayer Dither | Post-process | `postprocess/bayer-dither.ts` | addFunction (bayer), gl_FragCoord |
| `quantize_uv` | Quantize UV | Post-process | `postprocess/quantize-uv.ts` | connectable, gl_FragCoord, frozen-ref UV output |
| `fragment_output` | Fragment Output | Output | `output/fragment-output.ts` | master output (one per graph) |

All files are under `src/nodes/`. Use the closest match as a starting template for new nodes.

---

## File organization

```
src/nodes/
├── types.ts            # NodeDefinition, PortDefinition, NodeParameter, GLSLContext, addFunction
├── registry.ts         # NodeRegistry singleton, registerNode/registerNodes
├── type-coercion.ts    # Coercion rules, coerceType, areTypesCompatible
├── index.ts            # ALL_NODES array, initializeNodeLibrary, re-exports
├── input/              # Constants, UV, time, resolution
├── math/               # Arithmetic, trig, mix, smoothstep, remap, turbulence, ridged
├── noise/              # Noise, FBM, domain warp
├── color/              # HSV to RGB, brightness/contrast, color ramp
├── postprocess/        # Pixel grid, bayer dither
└── output/             # Fragment output
```

**Compiler:** `src/compiler/glsl-generator.ts` (main), `topological-sort.ts`, `use-live-compiler.ts`
**UI:** `src/components/ShaderNode.tsx` (node renderer), `NodeParameters.tsx` (param controls), `NodePalette.tsx` (palette)
