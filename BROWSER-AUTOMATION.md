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
| Export graph JSON | `sombra.exportGraph()` |
| Import graph JSON | `sombra.importGraph({nodes, edges})` |
| Manual compile | `sombra.compile()` |

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

### `sombra.exportGraph()` / `sombra.importGraph(graph)`

Export the graph as `{ nodes, edges }` JSON. Import replaces the current graph entirely.

---

## Node Types (23 total)

### Input

| Type | Label | Outputs | Key Params |
|---|---|---|---|
| `uv_coordinates` | UV Coordinates | `uv` (vec2) | `scaleX`, `scaleY`, `rotate`, `offsetX`, `offsetY` (all connectable) |
| `color_constant` | Color | `color` (color/vec3) | `value` ([r,g,b] 0-1) |
| `float_constant` | Number | `value` (float) | `value` (float) |
| `vec2_constant` | Vec2 | `value` (vec2) | `x`, `y` (floats) |
| `time` | Time | `time` (float) | `speed` (float) |
| `resolution` | Resolution | `resolution` (vec2) | — |
| `random` | Random | `value` (float) | `seed` (float) |

### Math

| Type | Label | Inputs | Outputs | Key Params |
|---|---|---|---|---|
| `arithmetic` | Arithmetic | `in_0`..`in_N` (float, dynamic 2-8) | `result` (float) | `operation` (enum: add/subtract/multiply/divide), `inputCount` (hidden) |
| `trig` | Trig | `input` (float) | `result` (float) | `function` (enum: sin/cos/tan/abs), `frequency` (connectable), `amplitude` (connectable) |
| `mix` | Mix | `a` (float), `b` (float) | `result` (float) | `factor` (connectable, 0-1) |
| `smoothstep` | Smoothstep | `input` (float) | `result` (float) | `edge0`, `edge1` |
| `remap` | Remap | `input` (float) | `result` (float) | `inMin`, `inMax`, `outMin`, `outMax` |
| `turbulence` | Turbulence | `input` (float) | `result` (float) | — |
| `ridged` | Ridged | `input` (float) | `result` (float) | — |

### Noise

| Type | Label | Inputs | Outputs | Key Params |
|---|---|---|---|---|
| `noise` | Noise | `coords` (vec2, auto_uv), `phase` (float) | `value` (float), `fn` (fnref) | `scale` (connectable), `noiseType` (enum: simplex/value/worley/worley2d/box), `boxFreq` (connectable, shown for box), `seed` (connectable) |
| `fbm` | FBM | `coords` (vec2, auto_uv), `phase` (float), `noiseFn` (fnref) | `value` (float) | `scale` (connectable), `octaves` (connectable), `lacunarity` (connectable), `gain` (connectable), `fractalMode` (enum: standard/turbulence/ridged) |
| `domain_warp` | Domain Warp | `coords` (vec2, auto_uv), `phase` (float), `noiseFn` (fnref) | `warped` (vec2) | `strength` (connectable), `frequency` (connectable) |

### Color

| Type | Label | Inputs | Outputs | Key Params |
|---|---|---|---|---|
| `hsv_to_rgb` | HSV to RGB | `h` (float), `s` (float), `v` (float) | `rgb` (vec3) | — |
| `brightness_contrast` | Brightness/Contrast | `color` (vec3) | `color` (vec3) | `brightness` (connectable), `contrast` (connectable) |
| `color_ramp` | Color Ramp | `t` (float) | `color` (vec3) | `interpolation` (enum: smooth/linear/constant), `stops` (hidden, array of `{position, color}`) |

### Post-process

| Type | Label | Inputs | Outputs | Key Params |
|---|---|---|---|---|
| `pixel_grid` | Pixel Grid | `color` (vec3) | `color` (vec3) | `pixelSize` (connectable), `shape` (enum: circle/diamond/triangle), `dither` (connectable) |
| `bayer_dither` | Bayer Dither | `color` (vec3) | `color` (vec3) | `levels` (float) |
| `quantize_uv` | Quantize UV | — | `uv` (vec2) | `pixelSize` (connectable) |

### Output

| Type | Label | Inputs |
|---|---|---|
| `fragment_output` | Fragment Output | `color` (vec3) |

---

## Port Types & Compatibility

| Type | Color | Can connect to |
|---|---|---|
| `float` | `#d4d4d8` (gray) | float, vec2, vec3, vec4 (auto-expanded) |
| `vec2` | `#34d399` (green) | vec2, vec3, vec4 |
| `vec3` | `#60a5fa` (blue) | vec3, vec4, color |
| `vec4` | `#a78bfa` (purple) | vec4 |
| `color` | `#fbbf24` (amber) | color, vec3 |
| `fnref` | `#22d3ee` (cyan) | fnref only |

Type coercion is automatic. `float → vec3` becomes `vec3(v, v, v)`.

---

## Key Concepts

### Auto-UV

Noise nodes have `coords` inputs with `default: 'auto_uv'`. When unconnected, the compiler generates screen-space UV automatically — no need to wire a UV Coordinates node for basic use.

### Connectable Params

Params marked `connectable: true` appear as both a slider AND an input handle on the node. When wired, the connection overrides the slider value. Target them by their param ID:

```js
sombra.connect(timeId, noiseId, 'time', 'scale')  // animate noise scale
```

### fnref (Function References)

The Noise node has an `fn` output of type `fnref` — it passes a GLSL function name (not a value). FBM and Domain Warp accept a `noiseFn` fnref input to use a custom noise function:

```js
const noise = sombra.createNode('noise', {x:0, y:0}, {noiseType: 'worley'})
const fbm = sombra.createNode('fbm', {x:300, y:0})
sombra.connect(noise, fbm, 'fn', 'noiseFn')  // FBM now uses Worley noise
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

The Color Ramp node stores gradient stops in `params.stops`:

```js
sombra.setParams(rampId, {
  interpolation: 'smooth',
  stops: [
    { position: 0.0, color: [0.1, 0.0, 0.2] },
    { position: 0.5, color: [0.4, 0.2, 0.8] },
    { position: 1.0, color: [1.0, 0.9, 0.3] },
  ]
})
```

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

// Wire: Time → Noise.phase, Noise.fn → FBM.noiseFn, FBM.value → Ramp.t, Ramp.color → Output.color
s.connect(time,  noise,  'time',  'phase')
s.connect(noise, fbm,    'fn',    'noiseFn')
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
const edgeToRemove = graph.edges.find(e => e.sourceHandle === 'fn')
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
// → [{id:'coords', type:'vec2'}, {id:'phase', type:'float'}, {id:'noiseFn', type:'fnref'}]
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
```
