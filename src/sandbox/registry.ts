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
export const SANDBOXES: SandboxEntry[] = []
