# Sombra DS Drift Report
Generated: 2026-03-06 23:41:00 UTC

## Token Drift

No token drift detected.

## Component Drift

### In Figma, not in DB

- "Content=text, Style=ghost, State=enabled" (node `326:36`)
- "Node Header" (node `111:488`)
- "Node Footer" (node `111:491`)
- "Select Frame" (node `354:3`)
- "Color Swatch" (node `354:12`)
- "Resolution" (node `123:1810`)
- "Number" (node `123:1807`)
- "Time" (node `123:1809`)
- "Color" (node `123:1806`)
- "Vec2" (node `123:1808`)
- "Random" (node `123:1811`)
- "UV Transform" (node `123:1805`)
- "Noise" (node `123:1812`)
- "Warp UV" (node `123:1814`)
- "FBM" (node `123:1813`)
- "Turbulence" (node `123:1820`)
- "Ridged" (node `123:1821`)
- "Smoothstep" (node `123:1818`)
- "Arithmetic" (node `123:1815`)
- "Mix" (node `123:1817`)
- "Remap" (node `123:1819`)
- "Trig" (node `123:1816`)
- "HSV to RGB" (node `123:1822`)
- "Color Ramp" (node `123:1824`)
- "Brightness/Contrast" (node `123:1823`)
- "Quantize UV" (node `123:1827`)
- "Dither" (node `123:1825`)
- "Fragment Output" (node `123:1828`)

## Variant Drift

### Node Card (`nodeCard`, node `106:405`)

**Figma variant properties:**
- `Selected=false`
- `Selected=true`

**DB parts:**
- `root`
- `header`
- `title`
- `content`
- `footer`

### Properties Panel (`propertiesPanel`, node `106:485`)

**Figma variant properties:**
- `State=empty`
- `State=populated`

**DB parts:**
- `root`
- `nodeInfo`
- `portRow`
- `paramSection`

### Preview Toolbar (`previewToolbar`, node `106:352`)

**Figma variant properties:**
- `Mode=docked-v`
- `Mode=docked-h`
- `Mode=floating`
- `Mode=fullwindow`

**DB parts:**
- `root`
- `wrapper`

### Button (`button`, node `106:108`)

**Figma variant properties:**
- `Content=icon`
- `Content=text`
- `Style=solid`
- `Style=ghost`
- `State=enabled`
- `State=disabled`
- `State=active`
- `State=hover`

**DB parts:**
- `root`
- `solid`
- `solidDisabled`
- `solidActive`
- `ghost`
- `ghostDisabled`
- `ghostActive`
- `textGhost`
- `textGhostDisabled`
- `textGhostActive`
- `solidHover`
- `ghostHover`
- `textGhostHover`

### Handle (`handle`, node `106:84`)

**Figma variant properties:**
- `State=disconnected`
- `State=connected`

**DB parts:**
- `root`

### Labeled Handle (`labeledHandle`, node `106:269`)

**Figma variant properties:**
- `Position=left`
- `Position=right`
- `State=disconnected`
- `State=connected`

**DB parts:**
- `root`
- `label`

### Connectable Param Row (`connectableParamRow`, node `106:311`)

**Figma variant properties:**
- `State=unwired`
- `State=wired`

**DB parts:**
- `root`
- `innerFrame`

### Icon (`icon`, node `306:236`)

**Figma variant properties:**
- `Icon=columns`
- `Icon=download`
- `Icon=folder-open`
- `Icon=minimize`
- `Icon=minus`
- `Icon=pip`
- `Icon=plus`
- `Icon=rows`
- `Icon=scan`
- `Icon=share`
- `Icon=shuffle`

**DB parts:**
- `root`
