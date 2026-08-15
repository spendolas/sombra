/**
 * Centralized icon registry — all app icons in one place.
 * Icons are OWNED, generated from src/icons/svg/*.svg (sourced from lucide, MIT).
 * See docs/research/2026-08-15-owned-iconography-design.md. No runtime lucide dep.
 */

import { createIcon, type IconProps } from '@/icons/create-icon'
import * as nodes from '@/generated/icon-nodes'

export const icons = {
  check: createIcon('check', nodes.check),
  chevronDown: createIcon('chevronDown', nodes.chevronDown),
  code: createIcon('code', nodes.code),
  columns: createIcon('columns', nodes.columns),
  copy: createIcon('copy', nodes.copy),
  download: createIcon('download', nodes.download),
  eye: createIcon('eye', nodes.eye),
  film: createIcon('film', nodes.film),
  folderOpen: createIcon('folderOpen', nodes.folderOpen),
  grid: createIcon('grid', nodes.grid),
  maximize: createIcon('maximize', nodes.maximize),
  minimize: createIcon('minimize', nodes.minimize),
  minus: createIcon('minus', nodes.minus),
  pip: createIcon('pip', nodes.pip),
  pipette: createIcon('pipette', nodes.pipette),
  plus: createIcon('plus', nodes.plus),
  rows: createIcon('rows', nodes.rows),
  scan: createIcon('scan', nodes.scan),
  share: createIcon('share', nodes.share),
  shuffle: createIcon('shuffle', nodes.shuffle),
  square: createIcon('square', nodes.square),
} as const

export type IconName = keyof typeof icons
export type { IconProps }
