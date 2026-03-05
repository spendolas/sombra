# Node Templates

## Overview

23 node templates on the Figma Templates page. Each template is a **COMPONENT** that composes child instances (Node Header, Labeled Handles, Connectable Param Rows, Float Sliders, Enum Selects, etc.) configured for that node type.

**Figma Page:** Templates
**Figma URL:** [Open Templates page](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=44:3164)

## Template Inventory

| Template | Figma ID | Category | Inputs | Outputs | Connectable Params | Regular Params | Custom Component |
|---|---|---|---|---|---|---|---|
| Number | `123:1815` | Input | 0 | 1 (float) | 0 | 1 (value) | — |
| Color | `123:1816` | Input | 0 | 1 (vec3) | 0 | 1 (color) | — |
| Vec2 | `123:1817` | Input | 0 | 1 (vec2) | 0 | 2 (x, y) | — |
| UV Transform | `123:1819` | Input | 0 | 1 (vec2) | 5 (scaleX, scaleY, rotate, offsetX, offsetY) | 0 | — |
| Time | `123:1822` | Input | 0 | 1 (float) | 0 | 0 | — |
| Resolution | `123:1823` | Input | 0 | 1 (vec2) | 0 | 0 | — |
| Random | `123:1828` | Input | 0 | 1 (float) | 1 (seed) | 0 | — |
| Arithmetic | `123:1824` | Math | 2+ (dynamic) | 1 (float) | 0 | 1 (operation) | +/- buttons |
| Trig | `123:1829` | Math | 1 (x) | 1 (result) | 2 (freq, amp) | 1 (function) | — |
| Mix | `123:1830` | Math | 2 (a, b) | 1 (result) | 1 (factor) | 0 | — |
| Remap | `123:1831` | Math | 1 (x) | 1 (result) | 4 (inMin, inMax, outMin, outMax) | 0 | — |
| Smoothstep | `123:1818` | Distort | 1 (value) | 1 (result) | 2 (min, max) | 0 | — |
| Turbulence | `123:1820` | Distort | 1 (x) | 1 (result) | 0 | 0 | — |
| Ridged | `123:1821` | Distort | 1 (x) | 1 (result) | 0 | 0 | — |
| Noise | `123:1812` | Noise | 2 (coords, phase) | 1 (value) | 2 (scale, seed) | 1 (noiseType) | — |
| FBM | `123:1813` | Noise | 2 (coords, phase) | 1 (value) | 5 (octaves, lacunarity, gain, scale, seed) | 2 (noiseType, fractalMode) | — |
| Warp UV | `123:1814` | Transform | 2 (coords, phase) | 2 (warped, warpedPhase) | 3 (strength, frequency, seed) | 1 (noiseType) | — |
| HSV to RGB | `123:1832` | Color | 3 (h, s, v) | 1 (rgb) | 0 | 0 | — |
| Brightness/Contrast | `123:1833` | Color | 1 (color) | 1 (result) | 2 (brightness, contrast) | 0 | — |
| Color Ramp | `123:1834` | Color | 1 (value) | 1 (color) | 0 | 1 (interpolation) | ColorRampEditor |
| Dither | `123:1825` | Effect | 1 (color) | 1 (result) | 2 (pixelSize, dither) | 1 (shape) | — |
| Quantize UV | `123:1827` | Transform | 0 | 1 (uv) | 1 (pixelSize) | 0 | — |
| Fragment Output | `123:1835` | Output | 1 (color) | 0 | 0 | 0 | — |

## Representative Screenshots

### Noise Template
Full node card with: header "Noise", output (Value float), inputs (Coords vec2, Phase float), connectable params (Scale, Seed with sliders), regular param (Noise Type enum select).

### Color Ramp Template
Full node card with: header "Color Ramp", output (Color vec3), input (Value float), regular param (Interpolation enum), custom component (ColorRampEditor with gradient bar, stops, +/- buttons, preset dropdown).

## Structure

Every template follows this internal structure:
1. **Node Header** instance (`111:488`) — 14px Semi Bold title, `surface/raised` bg, FILL width
2. **Content frame:** (bg-surface-elevated, p-3, gap-y-2)
   - Output LabeledHandles (position=right)
   - Input LabeledHandles (position=left)
   - Dynamic Input Controls (if `dynamicInputs` defined)
   - Connectable Param Rows (handle + slider)
   - Separator (if regular params follow)
   - Regular Params (FloatSlider, EnumSelect, ColorInput)
   - Custom Component (if `definition.component` exists)

## Variable Binding Status

All 23 templates audited:
- **Headers:** 23/23 use Node Header component instances (14px Semi Bold)
- **Colors:** 0 unbound — all fills, strokes, text colors bound to V2 variables
- **Layout:** 0 unbound — all padding, gap, radius bound to V2 variables
- **Port colors:** All handle strokes bound to Port Types collection
- **Float Sliders:** SombraSlider style — filled track with no visible thumb, indigo range fill

## Parity: ✅ All 23 templates match app source
