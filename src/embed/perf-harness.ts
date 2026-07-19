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
  private onVis = () => { document.hidden ? this.hooks.onHidden() : this.maybeVisible() }
  private inView = false

  constructor(private el: HTMLElement, private hooks: HarnessHooks) {
    this.reducedMotion =
      typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  start(): void {
    if (this.reducedMotion) return // static single frame; caller already rendered once
    this.io = new IntersectionObserver((entries) => {
      this.inView = entries.some((e) => e.isIntersecting)
      this.maybeVisible()
    }, { rootMargin: '50px', threshold: 0.01 })
    this.io.observe(this.el)

    this.ro = new ResizeObserver(() => this.hooks.onResize())
    this.ro.observe(this.el)

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
