/**
 * Centralized icon registry — all app icons in one place.
 * Mirrors Figma's PlusMinusButton component set where icons are swappable variants.
 */

import type { LucideIcon } from 'lucide-react'
import {
  Check, Columns2, Download, FolderOpen, Maximize,
  Minimize2, Minus, PictureInPicture2, Plus,
  Rows2, Scan, Share2, Shuffle,
} from 'lucide-react'

export const icons = {
  check: Check,
  columns: Columns2,
  download: Download,
  folderOpen: FolderOpen,
  maximize: Maximize,
  minimize: Minimize2,
  minus: Minus,
  pip: PictureInPicture2,
  plus: Plus,
  rows: Rows2,
  scan: Scan,
  share: Share2,
  shuffle: Shuffle,
} as const

export type IconName = keyof typeof icons
export type { LucideIcon }
