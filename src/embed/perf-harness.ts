interface HarnessHooks {
  onVisible: () => void   // enter view / tab visible → resume loop
  onHidden: () => void    // leave view / tab hidden → pause loop
  onResize: () => void    // size changed → request a frame
}

/**
 * Gates an embed's animation to when it is actually on screen and the tab is
 * visible, honors prefers-reduced-motion, and requests a frame on resize.
 */
export class PerfHarness {
  readonly reducedMotion: boolean
  private io?: IntersectionObserver
  private ro?: ResizeObserver
  private onVis = () => { if (document.hidden) this.hooks.onHidden(); else this.maybeVisible() }
  private inView = false
  private lastW = -1
  private lastH = -1

  /** `ignoreReducedMotion` is for hosts that handle the preference themselves. */
  constructor(private el: HTMLElement, private hooks: HarnessHooks, ignoreReducedMotion = false) {
    this.reducedMotion = !ignoreReducedMotion &&
      typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  /** May a loop run right now: not reduced motion, in view, and the tab visible. */
  get visible(): boolean {
    return !this.reducedMotion && this.inView && !document.hidden
  }

  start(): void {
    // Resize repaints hold in every mode, reduced motion included. The observer's
    // initial notification (same size the first frame was drawn at) is skipped.
    this.lastW = this.el.clientWidth
    this.lastH = this.el.clientHeight
    this.ro = new ResizeObserver(() => {
      const w = this.el.clientWidth, h = this.el.clientHeight
      if (w === this.lastW && h === this.lastH) return
      this.lastW = w; this.lastH = h
      this.hooks.onResize()
    })
    this.ro.observe(this.el)

    if (this.reducedMotion) return // static: no loop, so nothing to gate
    this.io = new IntersectionObserver((entries) => {
      this.inView = entries.some((e) => e.isIntersecting)
      this.maybeVisible()
    }, { rootMargin: '50px', threshold: 0.01 })
    this.io.observe(this.el)

    document.addEventListener('visibilitychange', this.onVis)
  }

  private maybeVisible(): void {
    if (this.inView && !document.hidden) this.hooks.onVisible()
    else this.hooks.onHidden()
  }

  stop(): void {
    this.io?.disconnect()
    this.ro?.disconnect()
    document.removeEventListener('visibilitychange', this.onVis)
  }
}
