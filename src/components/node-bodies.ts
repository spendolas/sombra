/**
 * Body components for nodes that set `portsRenderedByComponent`, keyed by node
 * type. Kept UI-side so node definitions stay free of React — the compile
 * worker imports them.
 */
import type { ComponentType } from 'react'
import { StackNodeBody } from './StackNodeBody'

export const NODE_BODIES: Record<string, ComponentType<{ nodeId: string; data: Record<string, unknown> }>> = {
  stack: StackNodeBody,
}
