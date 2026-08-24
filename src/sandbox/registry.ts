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
  { name: 'editor-chrome', title: 'Editor Chrome', group: 'Chrome', load: () => import('./harnesses/editor-chrome') },
  { name: 'srt-renderer', title: 'SRT Renderer', group: 'Chrome', load: () => import('./harnesses/srt-renderer') },
  { name: 'ds-preview', title: 'DS Preview', group: 'DS', load: () => import('./harnesses/ds-preview') },
]
