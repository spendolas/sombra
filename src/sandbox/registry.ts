import type React from 'react'

export interface SandboxEntry {
  /** url slug, e.g. 'color-picker' */
  name: string
  /** nav label */
  title: string
  /** nav grouping, e.g. 'Controls' | 'Chrome' | 'DS' */
  group: string
  /** lazy import of the harness module (default-exports the harness component) */
  load: () => Promise<{ default: React.ComponentType }>
}

// Migration tasks append entries here. Keep alphabetical within a group.
export const SANDBOXES: SandboxEntry[] = [
  { name: 'color-picker', title: 'Color Picker', group: 'Controls', load: () => import('./harnesses/color-picker') },
  { name: 'segmented-control', title: 'Segmented Control', group: 'Controls', load: () => import('./harnesses/segmented-control') },
  { name: 'amd-warning', title: 'AMD Warning', group: 'Chrome', load: () => import('./harnesses/amd-warning') },
  { name: 'compile-error-banner', title: 'Compile Error Banner', group: 'Chrome', load: () => import('./harnesses/compile-error-banner') },
  { name: 'editor-chrome', title: 'Editor Chrome', group: 'Chrome', load: () => import('./harnesses/editor-chrome') },
  { name: 'srt-renderer', title: 'SRT Renderer', group: 'Chrome', load: () => import('./harnesses/srt-renderer') },
  { name: 'knob-table', title: 'Knob Table', group: 'Embed', load: () => import('./harnesses/knob-table') },
  { name: 'ds-preview', title: 'DS Preview', group: 'DS', load: () => import('./harnesses/ds-preview') },
  { name: 'section-header', title: 'Section Header', group: 'Nodes', load: () => import('./harnesses/section-header') },
  { name: 'node-title', title: 'Node Title', group: 'Nodes', load: () => import('./harnesses/node-title') },
  { name: 'stack-layer-list', title: 'Stack Layer List', group: 'Nodes', load: () => import('./harnesses/stack-layer-list') },
  { name: 'wired-param-row', title: 'Wired Param Row', group: 'Nodes', load: () => import('./harnesses/wired-param-row') },
  { name: 'perf-view', title: 'Perf View', group: 'Perf', load: () => import('./harnesses/perf-view') },
]
