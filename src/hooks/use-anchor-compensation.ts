import { useEffect, useRef, type RefObject } from 'react'
import { useGraphStore } from '../stores/graphStore'
import { anchorToVec2 } from '../nodes/output/fragment-output'
import { REFERENCE_SIZE } from '../renderer/constants'

/**
 * Keep pinned gradients from jumping when the Fragment Output anchor changes.
 *
 * The gradient shader pins its centre to the output anchor (grad_center = 0.5 in
 * anchor-relative auto_uv), so it PINS to the anchor on resize — but that also
 * means changing the anchor would move it on screen. This hook compensates: when
 * the anchor changes, it rewrites every pinned gradient's p0/p1 by the exact
 * on-screen delta so the gradient stays put (Figma-style — choosing the pin
 * changes resize behavior, not the current position).
 *
 * Delta is the inverse of the gizmo's `pxOriginFrac`
 * (`anchor + (0.5-anchor)*REF/cssSize`), measured against the LIVE preview canvas
 * so it holds at any size:
 *   dpx = (prevAx - ax) * (cssW - REFERENCE_SIZE)
 *   dpy = (ay - prevAy) * (cssH - REFERENCE_SIZE)   // p0y/p1y are Y-up
 *
 * Lives at the App level (not the gizmo overlay) so it fires regardless of which
 * node is selected — e.g. when the anchor is changed from the Fragment Output's
 * own properties.
 */
export function useAnchorCompensation(canvasRef: RefObject<HTMLCanvasElement | null>) {
  const anchorStr = useGraphStore(
    (s) => (s.nodes.find((n) => n.data.type === 'fragment_output')?.data.params?.anchor as string) ?? 'center',
  )
  const updateNodeData = useGraphStore((s) => s.updateNodeData)
  const prevRef = useRef<[number, number] | null>(null)

  useEffect(() => {
    const cur = anchorToVec2(anchorStr)
    const prev = prevRef.current
    prevRef.current = cur
    if (!prev || (prev[0] === cur[0] && prev[1] === cur[1])) return
    const canvas = canvasRef.current
    if (!canvas) return
    const r = canvas.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return
    const dpx = (prev[0] - cur[0]) * (r.width - REFERENCE_SIZE)
    const dpy = (cur[1] - prev[1]) * (r.height - REFERENCE_SIZE)
    if (dpx === 0 && dpy === 0) return
    for (const n of useGraphStore.getState().nodes) {
      if (n.data.type !== 'gradient' || n.data.params?.drawMode !== 'pinned') continue
      const p = (n.data.params ?? {}) as Record<string, number>
      updateNodeData(n.id, {
        params: {
          ...n.data.params,
          p0x: (p.p0x ?? 0) + dpx, p1x: (p.p1x ?? 150) + dpx,
          p0y: (p.p0y ?? 0) + dpy, p1y: (p.p1y ?? 0) + dpy,
        },
      })
    }
  }, [anchorStr, canvasRef, updateNodeData])
}
