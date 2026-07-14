/**
 * Centralized icon registry — all app icons in one place.
 * Mirrors Figma's PlusMinusButton component set where icons are swappable variants.
 */

import type { LucideIcon } from 'lucide-react'
import {
  Ban, Check, Columns2, Download, FolderOpen, Grid2x2, Maximize,
  Minimize2, Minus, PictureInPicture2, Plus,
  Rows2, Scan, Share2, Shuffle, Square,
} from 'lucide-react'

export const icons = {
  ban: Ban,
  check: Check,
  columns: Columns2,
  download: Download,
  folderOpen: FolderOpen,
  grid: Grid2x2,
  maximize: Maximize,
  minimize: Minimize2,
  minus: Minus,
  pip: PictureInPicture2,
  plus: Plus,
  rows: Rows2,
  scan: Scan,
  share: Share2,
  shuffle: Shuffle,
  square: Square,
} as const

export type IconName = keyof typeof icons
export type { LucideIcon }
