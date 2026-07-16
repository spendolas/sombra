# Sombra Browser Automation Guide

Instructions for the Claude Chrome extension (or any browser automation tool) to programmatically create, wire, and manipulate nodes in Sombra via JavaScript injection.

## Prerequisites

Sombra must be running in the browser tab (dev server or deployed). On load, the app installs a dev bridge at `window.__sombra` (aliased as `sombra` in examples below).

```js
const sombra = window.__sombra
```

If `window.__sombra` is `undefined`, the page hasn't finished loading or the bridge is missing.

---

## Quick Reference

| Action | Code |
|---|---|
| List node types | `sombra.listNodeTypes()` |
| Describe a node type | `sombra.describeNode('noise')` |
| Create a node | `sombra.createNode('noise', {x:200, y:100}, {scale:8})` |
| Connect nodes | `sombra.connect(srcId, tgtId, 'value', 'color')` |
| Update params | `sombra.setParams(id, {scale: 12})` |
| Move a node | `sombra.moveNode(id, 300, 200)` |
| Remove a node | `sombra.removeNode(id)` |
| Remove an edge | `sombra.removeEdge(edgeId)` |
| Clear graph | `sombra.clearGraph()` |
| Describe current graph | `sombra.describeGraph()` |
| Get compiled shader | `sombra.getFragmentShader()` |
| Export graph (.sombra) | `sombra.exportGraph()` → `{ sombra: 1, nodes, edges }` |
| Import graph (.sombra) | `sombra.importGraph({sombra?, nodes, edges})` |
| Manual compile | `sombra.compile()` |
| Share URL for current graph | `sombra.shareGraph()` |
| Compile IR→WGSL directly | `sombra.compileGraphIR(nodes, edges)` |
| GPU-validate WGSL | `sombra.validateWGSL(code)` / `validateAllWGSL()` / `validateAllSubgraphWGSL()` |
| Renderer instance | `sombra.renderer` (`.backend`, full ShaderRenderer API) |
| Raw store access | `sombra.stores.graph/compiler/settings` (zustand: `.getState()`) |

---

## API Reference

### `sombra.createNode(type, position?, paramOverrides?) → nodeId`

Creates a node and adds it to the graph. Returns the new node's string ID.

- **type** `string` — Node type key (see Node Types below)
- **position** `{x, y}` — Canvas position in pixels. Default `{x:0, y:0}`
- **paramOverrides** `object` — Override default param values

```js
const noise = sombra.createNode('noise', {x: 200, y: 100}, {
  scale: 8,
  noiseType: 'worley'
})
```

### `sombra.connect(sourceId, targetId, sourcePort?, targetPort?) → edgeId`

Connects an output port to an input port. Returns the new edge's string ID.

- **sourcePort** — defaults to the first output of the source node
- **targetPort** — defaults to the first input of the target node
- If the target input already has a connection, the old one is replaced (single-wire-per-input)

```js
sombra.connect(noiseId, outputId, 'value', 'color')
```

**Connectable params** are also valid targets. They share the same port ID as the param:

```js
// Wire a float into the noise node's 'scale' connectable param
sombra.connect(numberId, noiseId, 'value', 'scale')
```

### `sombra.setParams(nodeId, params)`

Merges new param values into an existing node.

```js
sombra.setParams(noiseId, { scale: 12, noiseType: 'value' })
```

### `sombra.moveNode(nodeId, x, y)`

Repositions a node on the canvas.

### `sombra.removeNode(nodeId)`

Deletes a node and all edges connected to it.

### `sombra.removeEdge(edgeId)`

Deletes a single edge.

### `sombra.clearGraph()`

Removes all nodes and edges.

### `sombra.describeGraph()`

Returns a JSON description of the current graph:

```js
{
  nodes: [{ id, type, position: {x,y}, params: {...} }, ...],
  edges: [{ id, source, target, sourceHandle, targetHandle }, ...]
}
```

### `sombra.describeNode(type)`

Returns the full definition of a node type: inputs, outputs, params with their ranges and defaults.

```js
sombra.describeNode('fbm')
// → { type, label, category, inputs: [...], outputs: [...], params: [...], ... }
```

### `sombra.listNodeTypes()`

Returns an array of `{ type, label, category }` for every registered node.

### `sombra.compile()`

Manually triggers shader compilation and pushes the result to the renderer. Returns `{ success, fragmentShader, vertexShader, errors }`.

### `sombra.getFragmentShader()`

Returns the current compiled fragment shader source string (or `null`).

### `sombra.exportGraph() → SombraFile`

Returns the current graph as a versioned `.sombra` JSON object:

```js
{
  sombra: 1,           // file format version
  nodes: [...],        // React Flow node array
  edges: [...]         // React Flow edge array
}
```

### `sombra.importGraph(graph)`

Replaces the current graph from a `.sombra` file or bare snapshot. Accepts both formats:

```js
// Versioned .sombra format
sombra.importGraph({ sombra: 1, nodes: [...], edges: [...] })

// Bare format (backward compatible)
sombra.importGraph({ nodes: [...], edges: [...] })
```

Import is undoable — the previous graph is pushed to the undo stack. Validates node types and graph structure; throws on invalid input.

---

### `sombra.shareGraph() → url`

Returns a compact share URL (`viewer.html#g=<base64url(deflate)>`) for the current graph. Image nodes embed their `imageData` (chunked base64 — large but functional).

### `sombra.renderer`

The live `ShaderRenderer` instance (WebGPU or WebGL2). `sombra.renderer.backend` reports which. Full interface (`src/renderer/types.ts`): `render()`, `updateUniforms()`, `setAnchor()`, `uploadImageTexture()`, etc. Useful for automation that must force a frame (`render()`) since rAF does not fire in hidden tabs.

### Store actions worth knowing (`sombra.stores.graph.getState()`)

| Action | Notes |
|---|---|
| `undo()` / `redo()` | Param edits are undoable (coalesced per node within a sliding 800ms window); deletes are atomic (node + connected edges = one entry) |
| `removeElements(nodeIds, edgeIds)` | Atomic multi-delete — one history entry |
| `replaceEdge(oldEdgeId, newEdge)` | Atomic reconnect (enforces single-wire-per-input) |
| `updateNodeData(id, {params})` | What `setParams` calls under the hood |

### Forcing the WebGL2 backend

Append `?backend=webgl2` to the editor URL — the only way to exercise the fallback in a WebGPU-capable browser. Disables the IR/WGSL path (`useIR=false`) so IR failures can't false-flag a working GL render.

---

## `.sombra` File Format

Sombra graphs are saved as `.sombra` files — JSON with a version envelope:

```json
{
  "sombra": 1,
  "nodes": [...],
  "edges": [...]
}
```

- **`sombra`** — file format version (integer). Distinct from `GRAPH_SCHEMA_VERSION` used for localStorage.
- **`nodes` / `edges`** — same shape as React Flow's node/edge arrays (position, data, handles, etc.)
- **Settings are NOT included** — preview mode, split sizes, etc. are UI preferences, not graph content.
- **File extension:** `.sombra` (also accepts `.json` for convenience)

The **GraphToolbar** in the top-left of the canvas provides Save (download) and Open (upload) buttons for `.sombra` files.

---

## Node Types (41 total)

### Input

| Type | Label | Inputs | Outputs | Params |
|---|---|---|---|---|
| `uv_transform` | UV Transform | `coords` (vec2, auto_uv) | `uv` (vec2) | `srt_scaleX` (connectable), `srt_scaleY` (connectable), `srt_rotate` (connectable), `srt_translateX` (connectable), `srt_translateY` (connectable) |
| `color_constant` | Color | — | `color` (color, RGBA) | `color` |
| `float_constant` | Number | — | `value` (float) | `value` |
| `vec2_constant` | Vec2 | — | `value` (vec2) | `x`, `y` |
| `time` | Time | — | `time` (float) | `speed` (connectable) |
| `resolution` | Resolution | — | `resolution` (vec2) | — |
| `random` | Random | — | `value` (float) | `min` (connectable), `max` (connectable), `decimals` |
| `image` | Image | `coords` (vec2) | `color` (color, RGBA — sampled rgb+a), `alpha` (float, unchanged separate alpha port) | `fitMode` (enum: contain/cover), `srt_scale` (connectable), `srt_rotate` (connectable), `srt_translateX` (connectable), `srt_translateY` (connectable) |

### Math

| Type | Label | Inputs | Outputs | Params |
|---|---|---|---|---|
| `arithmetic` | Arithmetic | `in_0`..`in_N` (float, dynamic) | `result` (float) | `operation` (enum: add/subtract/multiply/divide) |
| `trig` | Trig | `value` (float) | `result` (float) | `func` (enum: sin/cos/tan/abs), `frequency` (connectable), `amplitude` (connectable) |
| `mix` | Mix | `a` (color), `b` (color) | `result` (color) | `factor` (connectable) |
| `remap` | Remap | `value` (float), `inMin` (float), `inMax` (float), `outMin` (float), `outMax` (float) | `result` (float) | — |
| `clamp` | Clamp | `value` (float) | `result` (float) | `min` (connectable), `max` (connectable) |
| `power` | Power | `base` (float) | `result` (float) | `exponent` (connectable) |
| `round` | Round | `value` (float) | `result` (float) | `mode` (enum: floor/ceil/fract/round/sign) |
| `smoothstep` | Smoothstep | `x` (float) | `result` (float) | `min` (connectable), `max` (connectable) |

### Noise

| Type | Label | Inputs | Outputs | Params |
|---|---|---|---|---|
| `noise` | Noise | `coords` (vec2, auto_uv), `phase` (float) | `value` (float) | `srt_scale` (connectable), `srt_translateX` (connectable), `srt_translateY` (connectable), `noiseType` (enum: simplex/value/worley/worley_fast/worley2d/box), `seed` (connectable) |
| `fbm` | FBM | `coords` (vec2, auto_uv), `phase` (float) | `value` (float) | `srt_scale` (connectable), `srt_translateX` (connectable), `srt_translateY` (connectable), `noiseType` (enum: simplex/value/worley/worley_fast/worley2d/box), `fractalMode` (enum: standard/turbulence/ridged), `octaves` (connectable), `lacunarity` (connectable), `gain` (connectable), `seed` (connectable) |

### Color

| Type | Label | Inputs | Outputs | Params |
|---|---|---|---|---|
| `hsv_to_rgb` | HSV to RGB | `h` (float), `s` (float), `v` (float) | `rgb` (color, RGBA — alpha always 1.0) | — |
| `brightness_contrast` | Brightness/Contrast | `color` (color) | `result` (color) | `brightness` (connectable), `contrast` (connectable), `preserveAlpha` (bool, default false — when true, only rgb channels are affected and alpha passes through unchanged) |
| `color_ramp` | Color Ramp | `t` (float) | `color` (color, RGBA — stops carry alpha) | `interpolation` (enum: smooth/linear/constant) |
| `invert` | Invert | `color` (color) | `result` (color) | `preserveAlpha` (bool, default false — when true, only rgb channels are inverted and alpha passes through unchanged) |
| `grayscale` | Grayscale | `color` (color, RGBA in) | `result` (float, unchanged) | `mode` (enum: luminance/average/lightness) |
| `posterize` | Posterize | `color` (color) | `result` (color) | `levels` (connectable), `preserveAlpha` (bool, default false — when true, only rgb channels are posterized and alpha passes through unchanged) |

### Distort

| Type | Label | Inputs | Outputs | Params |
|---|---|---|---|---|
| `turbulence` | Turbulence | `value` (float) | `result` (float) | — |
| `ridged` | Ridged | `value` (float) | `result` (float) | — |
| `warp` | Warp | `source` (color, textureInput), `coords` (vec2, auto_uv), `phase` (float) | `color` (color, RGBA — full vec4 sampled), `warped` (vec2), `warpedPhase` (float) | `srt_scale` (connectable), `srt_translateX` (connectable), `srt_translateY` (connectable), `noiseType` (enum: simplex/value/worley/worley_fast/worley2d/box), `strength` (connectable), `seed` (connectable), `warpDepth` (enum: 2/3), `edge` (enum: clamp/repeat/mirror) |
| `polar_coords` | Polar Coordinates | `source` (color, textureInput), `coords` (vec2, auto_uv) | `color` (color, RGBA — full vec4 sampled), `polar` (vec2) | `mode` (enum: forward/inverse), `centerX` (connectable), `centerY` (connectable) |
| `tile` | Tile | `source` (color, textureInput), `coords` (vec2, auto_uv) | `color` (color, RGBA — full vec4 sampled), `uv` (vec2) | `countX` (connectable), `countY` (connectable), `mirror` (enum: none/x/y/xy) |

### Effect

| Type | Label | Inputs | Outputs | Params |
|---|---|---|---|---|
| `pixelate` | Pixelate | `source` (color, textureInput) | `color` (color, RGBA — full vec4 sampled), `uv` (vec2) | `pixelSize` (connectable) |
| `reeded_glass` | Reeded Glass | `source` (color, textureInput) | `color` (color, RGBA — full vec4 sampled/frosted), `coords` (vec2) | `srt_scale` (connectable), `srt_rotate` (connectable), `srt_translateX` (connectable), `srt_translateY` (connectable), `ribWidth` (connectable), `ior` (connectable), `curvature` (connectable), `frost` (connectable), `direction` (enum: vertical/horizontal), `ribType` (enum: straight/wave/circular/noise), `waveShape` (enum: sine/triangle/square/sawtooth/chevron/u_shape; when ribType=wave), `noiseType` (enum: simplex/value/worley; when ribType=noise), `amplitude` (connectable; when ribType=wave|circular|noise), `wavelength` (connectable; when ribType=wave|circular|noise) |
| `dither` | Dither | `color` (color) | `result` (color, RGBA — alpha masked through) | `pixelSize` (connectable), `shape` (enum: square/circle/diamond/triangle), `threshold` (connectable), `dither` (connectable; when shape=circle) |

### Output

| Type | Label | Inputs | Outputs | Params |
|---|---|---|---|---|
| `fragment_output` | Fragment Output | `color` (vec4, default `[0,0,0,1]`) | — | `alpha` (connectable; default 1.0), `alphaOp` (enum: replace/multiply/max/add/subtract/min/difference; default multiply), `quality` (enum: adaptive/low/medium/high), `anchor` (enum: tl/tc/tr/cl/center/cr/bl/bc/br; anchor-grid) |

### Pattern

| Type | Label | Inputs | Outputs | Params |
|---|---|---|---|---|
| `checkerboard` | Checkerboard | `coords` (vec2, auto_uv) | `color` (color), `value` (float) | `srt_scale` (connectable), `srt_rotate` (connectable), `srt_translateX` (connectable), `srt_translateY` (connectable), `tileMode` (enum: cellSize/density), `cellSize` (connectable; when tileMode=cellSize), `density` (connectable; when tileMode=density), `softness` (connectable), `colorA` (connectable), `colorB` (connectable) |
| `stripes` | Stripes | `coords` (vec2, auto_uv) | `color` (color), `value` (float) | `srt_scale` (connectable), `srt_rotate` (connectable), `srt_translateX` (connectable), `srt_translateY` (connectable), `width` (connectable), `gap` (connectable), `softness` (connectable), `colorA` (connectable), `colorB` (connectable) |
| `dots` | Dots | `coords` (vec2, auto_uv) | `color` (color), `value` (float) | `srt_scale` (connectable), `srt_rotate` (connectable), `srt_translateX` (connectable), `srt_translateY` (connectable), `gapX` (connectable), `gapY` (connectable), `radius` (connectable), `aspect` (connectable), `softness` (connectable), `colorA` (connectable), `colorB` (connectable) |
| `gradient` | Gradient | `coords` (vec2, auto_uv) | `color` (color, RGBA — stops carry alpha), `value` (float) | `srt_scale` (connectable), `srt_rotate` (connectable), `srt_translateX` (connectable), `srt_translateY` (connectable), `gradientType` (enum: linear/radial/angular/diamond), `interpolation` (enum: smooth/linear/constant) |

### Vector

| Type | Label | Inputs | Outputs | Params |
|---|---|---|---|---|
| `split_vec3` | Split Vec3 | `vector` (vec3) | `x` (float), `y` (float), `z` (float) | — |
| `combine_vec3` | Combine Vec3 | `x` (float), `y` (float), `z` (float) | `vector` (vec3) | — |
| `split_vec2` | Split Vec2 | `vector` (vec2) | `x` (float), `y` (float) | — |
| `combine_vec2` | Combine Vec2 | `x` (float), `y` (float) | `vector` (vec2) | — |

---

## Port Types & Compatibility

| Type | Color | Can connect to |
|---|---|---|
| `float` | `#d4d4d8` (gray) | float, vec2, vec3, vec4, color (broadcast) |
| `vec2` | `#34d399` (green) | float (.x), vec2, vec3, vec4, color |
| `vec3` | `#60a5fa` (blue) | float (.x), vec2 (.xy), vec3, vec4, color |
| `vec4` | `#a78bfa` (purple) | float (.x), vec2 (.xy), vec3 (.rgb), vec4, color |
| `color` | `#fbbf24` (amber) | float (.x), vec2 (.xy), vec3, vec4, color |
| `sampler2D` | `#f472b6` (pink) | sampler2D (texture-input ports; creates a pass boundary) |

`color` is RGBA — a distinct, vec4-backed port type (not a `vec3` alias). It
coerces symmetrically with `vec3`: `vec3 → color` appends alpha `1.0`,
`color → vec3` drops alpha (`.rgb`). `color ↔ vec4` pass through unchanged
(same underlying shape). `float → color` broadcasts to an opaque gray
(`vec4(vec3(v), 1.0)`); `color → float` extracts `.x`. Rules live in
`src/nodes/type-coercion.ts` (GLSL) and `coerceTypeForIR` in
`src/compiler/ir-compiler.ts` (WGSL) — keep in parity.

---

## Key Concepts

### Auto-UV

Noise nodes have `coords` inputs with `default: 'auto_uv'`. When unconnected, the compiler generates screen-space UV automatically — no need to wire a UV Coordinates node for basic use.

### Connectable Params

Params marked `connectable: true` appear as both a slider AND an input handle on the node. When wired, the connection overrides the slider value. Target them by their param ID:

```js
sombra.connect(timeId, noiseId, 'time', 'scale')  // animate noise scale
```

### Dynamic Inputs

The Arithmetic node has 2-8 float inputs. Control the count via the hidden `inputCount` param:

```js
const math = sombra.createNode('arithmetic', {x:0, y:0}, {
  operation: 'add',
  inputCount: 4  // creates in_0, in_1, in_2, in_3
})
```

### Color Ramp Stops

The Color Ramp node stores gradient stops in `params.stops`. Each stop's `color`
is RGBA — a 3-tuple `[r, g, b]` (legacy, alpha defaults to `1.0`) or a
4-tuple `[r, g, b, a]`:

```js
sombra.setParams(rampId, {
  interpolation: 'smooth',
  stops: [
    { position: 0.0, color: [0.1, 0.0, 0.2] },
    { position: 0.5, color: [0.4, 0.2, 0.8, 0.6] },
    { position: 1.0, color: [1.0, 0.9, 0.3] },
  ]
})
```

### Fragment Output: Color, Alpha & Premultiplication

The `color` input is `vec4`. A `vec3` source coerces with alpha `1.0`; a `vec4` or `color` source's real alpha passes through unchanged. The connectable `alpha` input (default `1.0`) is combined with that color-derived alpha via the `alphaOp` param (`replace/multiply/max/add/subtract/min/difference`, default `multiply`) to produce the final alpha `a`. The node's actual write is premultiplied: `vec4(rgb * a, a)`. Graphs that never touch alpha (`a = 1`) render pixel-identical to before — output stays opaque.

```js
sombra.setParams(outputId, { alphaOp: 'multiply' })
sombra.connect(alphaSourceId, outputId, 'value', 'alpha')
```

Both the WebGL2 and WebGPU renderers clear the canvas to transparent (`a = 0`) before drawing, so any non-opaque output composites over the host page — relevant for embeds, shared-link previews, and `viewer.html`. This is separate from the editor's own backdrop (see **Settings Control** — `previewBackground`), which is a view-only checker/solid/none backdrop behind the preview canvas and never affects the rendered/exported output.

### Legacy-graph alpha behavior changes

Nodes whose alpha output changes for pre-RGBA-migration graphs (all previously assumed opaque, `a = 1.0` throughout):

- `invert`, `posterize`, `brightness_contrast` — now edit alpha along with RGB by default. Set `preserveAlpha: true` to restore the old opaque-passthrough behavior (only RGB channels are affected; alpha passes through unchanged).
- `dither` (`pixel_grid` template) — masks color by multiplying with the computed shape/dither mask (`result = color * mask`), which now also multiplies alpha. A legacy opaque dither graph gets transparent holes wherever the mask is `0` (masked-out cells). This is by-design (RGBA) and has **no `preserveAlpha` opt-out** — if opaque output is required, follow the dither node with an explicit alpha override (e.g. wire a constant `1.0` into the downstream Fragment Output's `alpha` with `alphaOp: 'replace'`).

---

## Auto-Compilation

The app auto-compiles after any graph change (100ms debounce). You normally don't need to call `sombra.compile()` manually — just create/connect/update nodes and the preview updates live.

If auto-compile is disabled:

```js
sombra.stores.settings.getState().setAutoCompile(false)  // disable
sombra.compile()  // manual trigger
```

---

## Raw Store Access

For advanced manipulation, the three Zustand stores are exposed directly:

```js
sombra.stores.graph.getState()      // { nodes, edges, addNode, removeNode, ... }
sombra.stores.compiler.getState()   // { fragmentShader, errors, ... }
sombra.stores.settings.getState()   // { previewMode, splitDirection, ... }
```

Subscribe to state changes:

```js
sombra.stores.graph.subscribe(state => {
  console.log('Graph changed:', state.nodes.length, 'nodes')
})
```

The node registry is also available:

```js
sombra.registry.get('noise')       // full NodeDefinition
sombra.registry.getAll()           // all definitions
sombra.registry.getCategories()    // ['Color', 'Input', 'Math', 'Noise', ...]
```

---

## Example: Build a Complete Shader

```js
const s = window.__sombra

// Start fresh
s.clearGraph()

// Create nodes
const time   = s.createNode('time',            {x: 0,   y: 0},   {speed: 0.3})
const noise  = s.createNode('noise',           {x: 250, y: 0},   {scale: 6, noiseType: 'simplex'})
const fbm    = s.createNode('fbm',             {x: 500, y: 0},   {octaves: 4, lacunarity: 2.0, gain: 0.5})
const ramp   = s.createNode('color_ramp',      {x: 750, y: 0})
const output = s.createNode('fragment_output',  {x: 1000, y: 0})

// Wire: Time → Noise.phase, FBM.value → Ramp.t, Ramp.color → Output.color
s.connect(time,  noise,  'time',  'phase')
s.connect(fbm,   ramp,   'value', 't')
s.connect(ramp,  output, 'color', 'color')

// Set color ramp palette
s.setParams(ramp, {
  stops: [
    { position: 0.0, color: [0.05, 0.0, 0.15] },
    { position: 0.3, color: [0.2, 0.05, 0.5] },
    { position: 0.6, color: [0.1, 0.4, 0.8] },
    { position: 1.0, color: [0.9, 0.95, 1.0] },
  ]
})
```

---

## Example: Inspect and Modify Existing Graph

```js
const s = window.__sombra

// See what's in the graph
const graph = s.describeGraph()
console.log(graph.nodes)  // [{id, type, position, params}, ...]
console.log(graph.edges)  // [{id, source, target, sourceHandle, targetHandle}, ...]

// Find the noise node
const noiseNode = graph.nodes.find(n => n.type === 'noise')
if (noiseNode) {
  // Change it to Worley noise with higher scale
  s.setParams(noiseNode.id, { noiseType: 'worley', scale: 15 })
}

// Find and remove a specific edge
const edgeToRemove = graph.edges.find(e => e.sourceHandle === 'value')
if (edgeToRemove) s.removeEdge(edgeToRemove.id)
```

---

## Example: Discover Node Capabilities

```js
const s = window.__sombra

// What node types are available?
console.table(s.listNodeTypes())

// What does the FBM node accept?
const fbm = s.describeNode('fbm')
console.log('Inputs:', fbm.inputs)
// → [{id:'coords', type:'vec2'}, {id:'phase', type:'float'}]
console.log('Params:', fbm.params)
// → [{id:'scale', connectable:true, min:0.1, max:50, default:5}, ...]
```

---

## Settings Control

```js
const settings = sombra.stores.settings.getState()

// Switch preview mode
settings.setPreviewMode('floating')     // or 'docked', 'fullwindow'
settings.setSplitDirection('horizontal') // or 'vertical' (for docked mode)

// Adjust layout
settings.setSplitPct('vertical', 40)    // 40% preview in vertical split
settings.setFloatingPosition({x: 100, y: 100})
settings.setFloatingSize({width: 600, height: 400})

// Preview backdrop (view-only — never baked into the render/export)
settings.previewBackground   // { mode: 'checker' | 'solid' | 'none', color: string }, default { mode: 'checker', color: '#1a1a2e' }
settings.setPreviewBackground({ mode: 'solid', color: '#000000' })
```
