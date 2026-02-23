# Node Templates

## Overview

24 node templates on the Figma Templates page. Each template is a COMPONENT that composes a Node Card organism with specific LabeledHandles, ConnectableParamRows, and NodeParameters configured for that node type.

**Figma Page:** Templates
**Figma URL:** [Open Templates page](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=44:3164)

## Template Inventory

| Template | Figma ID | Category | Inputs | Outputs | Connectable Params | Regular Params | Custom Component |
|---|---|---|---|---|---|---|---|
| Number | `44:3164` | Input | 0 | 1 (float) | 0 | 1 (value) | — |
| Color | `44:3165` | Input | 0 | 1 (vec3) | 0 | 1 (color) | — |
| Vec2 | `44:3166` | Input | 0 | 1 (vec2) | 0 | 2 (x, y) | — |
| UV Coordinates | `44:3167` | Input | 0 | 1 (vec2) | 5 (scaleX, scaleY, rotate, offsetX, offsetY) | 0 | — |
| Time | `44:3168` | Input | 0 | 1 (float) | 0 | 0 | — |
| Resolution | `44:3169` | Input | 0 | 1 (vec2) | 0 | 0 | — |
| Arithmetic | `44:3170` | Math | 2+ (dynamic) | 1 (float) | 0 | 1 (operation) | +/- buttons |
| Trig | `44:3171` | Math | 1 (x) | 1 (result) | 2 (freq, amp) | 1 (function) | — |
| Mix | `44:3172` | Math | 2 (a, b) | 1 (result) | 1 (factor) | 0 | — |
| Smoothstep | `44:3173` | Math | 1 (x) | 1 (result) | 2 (edge0, edge1) | 0 | — |
| Remap | `44:3174` | Math | 1 (x) | 1 (result) | 4 (inMin, inMax, outMin, outMax) | 0 | — |
| Turbulence | `44:3175` | Math | 1 (x) | 1 (result) | 0 | 0 | — |
| Ridged | `44:3176` | Math | 1 (x) | 1 (result) | 0 | 0 | — |
| Noise | `44:3177` | Noise | 2 (coords, phase) | 2 (value, fn) | 2 (scale, seed) | 1 (noiseType) | — |
| FBM | `44:3178` | Noise | 2 (coords, noiseFn) | 1 (value) | 3 (octaves, lacunarity, gain) | 1 (fractalMode) | — |
| Domain Warp | `44:3179` | Noise | 2 (coords, noiseFn) | 1 (warped) | 2 (strength, frequency) | 0 | — |
| HSV to RGB | `44:3180` | Color | 3 (h, s, v) | 1 (rgb) | 0 | 0 | — |
| Brightness/Contrast | `44:3181` | Color | 1 (color) | 1 (result) | 2 (brightness, contrast) | 0 | — |
| Color Ramp | `50:4226` | Color | 1 (value) | 1 (color) | 0 | 1 (interpolation) | ColorRampEditor |
| Pixel Grid | `72:627` | Post-process | 1 (color) | 1 (result) | 2 (pixelSize, dither) | 1 (shape) | — |
| Bayer Dither | `72:668` | Post-process | 1 (color) | 1 (result) | 0 | 0 | — |
| Quantize UV | `80:700` | Post-process | 0 | 1 (uv) | 1 (pixelSize) | 0 | — |
| Random | `80:733` | Input | 0 | 1 (float) | 1 (seed) | 0 | — |
| Fragment Output | `44:3182` | Output | 1 (color) | 0 | 0 | 0 | — |

## Representative Screenshots

### Noise Template
Full node card with: header "Noise", outputs (Value float, Fn fnref), inputs (Coords vec2, Phase float), connectable params (Scale, Seed with sliders), regular param (Noise Type enum select).

### Color Ramp Template
Full node card with: header "Color Ramp", output (Color vec3), input (Value float), regular param (Interpolation enum), custom component (ColorRampEditor with gradient bar, stops, +/- buttons, preset dropdown).

## Structure

Every template follows this internal structure:
1. **Node Card** organism (selected=false variant)
2. **Header:** Node name (text-sm font-semibold text-fg, bg-surface-raised)
3. **Content:** (bg-surface-elevated, p-3, gap-y-2)
   - Output LabeledHandles (position=right)
   - Input LabeledHandles (position=left)
   - Dynamic Input Controls (if `dynamicInputs` defined)
   - Connectable Param Rows (handle + slider)
   - Separator (if regular params follow)
   - Regular Params (FloatSlider, EnumSelect, ColorInput)
   - Custom Component (if `definition.component` exists)

## Variable Binding Status

All 24 templates were audited in Sprint 5:
- **Colors:** 0 unbound — all fills, strokes, text colors bound to variables
- **Layout:** 0 unbound — all padding, gap, radius bound to variables
- **Port colors:** All handle strokes bound to Port Types collection

## Parity: ✅ All 24 templates match app source
