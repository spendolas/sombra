import { createElement, forwardRef } from 'react'

const BASE = 16 // our icon grid; absolute-stroke math uses this, not lucide's 24

export type IconNode = Array<[tag: string, attrs: Record<string, string | number>]>

export type IconProps = Omit<React.SVGProps<SVGSVGElement>, 'ref'> & {
  size?: number
  absoluteStrokeWidth?: boolean
}

/**
 * The stroke-width attribute to place on the <svg>. Non-absolute returns the raw
 * width (visual stroke scales with size). Absolute back-computes against BASE so the
 * on-screen stroke stays constant regardless of render size.
 */
export function resolveStrokeWidth(
  strokeWidth: number,
  size: number,
  absolute: boolean,
  base: number = BASE,
): number {
  return absolute ? (strokeWidth * base) / size : strokeWidth
}

export function createIcon(name: string, node: IconNode) {
  const Comp = forwardRef<SVGSVGElement, IconProps>(
    ({ size = 16, strokeWidth = 1.5, absoluteStrokeWidth = false, className, ...rest }, ref) =>
      createElement(
        'svg',
        {
          ref,
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: resolveStrokeWidth(Number(strokeWidth), Number(size), absoluteStrokeWidth),
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          className,
          ...rest,
        },
        node.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs })),
      ),
  )
  Comp.displayName = `Icon(${name})`
  return Comp
}
