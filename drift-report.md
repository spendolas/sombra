# Sombra DS Drift Report
Generated: 2026-07-13 00:34:35 UTC

## Token Drift

No token drift detected.

## Component Drift

### In Figma, not in DB

- "Image Viewport Overlay" (node `556:1144`)
- "Cursor Icon" (node `569:201`)
- "Node Preview" (node `619:1950`)
- "Image" (node `551:977`)

### In DB, not found in Figma

- "Text Ghost Button" (dsKey: `textGhostButton`, node `326:36`)

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
- `sectionHeader`
- `emptyText`
- `errorText`
- `categoryMeta`
- `nodeTitle`
- `description`
- `nodeIdText`
- `portList`
- `portLabel`
- `portTypeText`

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
