import { Component, lazy, Suspense, useMemo, type ReactNode } from 'react'
import { SANDBOXES } from './registry'

function useQuery() {
  const p = new URLSearchParams(window.location.search)
  return { c: p.get('c') ?? '', solo: p.get('solo') === '1' }
}

class HarnessBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null }
  static getDerivedStateFromError(err: Error) { return { err } }
  render() {
    if (this.state.err) {
      return (
        <div className="p-6 text-fg">
          <div className="text-fg-dim mb-2">Harness crashed:</div>
          <pre className="text-sm text-fg-subtle whitespace-pre-wrap">{String(this.state.err.stack ?? this.state.err)}</pre>
        </div>
      )
    }
    return this.props.children
  }
}

function Nav({ current }: { current: string }) {
  const groups = useMemo(() => {
    const g = new Map<string, typeof SANDBOXES>()
    for (const s of SANDBOXES) { (g.get(s.group) ?? g.set(s.group, []).get(s.group)!).push(s) }
    return [...g.entries()]
  }, [])
  return (
    <nav className="w-56 shrink-0 h-full overflow-y-auto border-r border-edge bg-surface-alt p-3">
      <div className="text-fg-subtle text-xs uppercase tracking-wide mb-3 px-2">Sandboxes</div>
      {groups.map(([group, items]) => (
        <div key={group} className="mb-4">
          <div className="text-fg-muted text-xs px-2 mb-1">{group}</div>
          {items.map((s) => (
            <a
              key={s.name}
              href={`?c=${s.name}`}
              className={`block rounded px-2 py-1 text-sm ${
                s.name === current ? 'bg-surface-elevated text-fg' : 'text-fg-dim hover:bg-surface-raised'
              }`}
            >
              {s.title}
            </a>
          ))}
        </div>
      ))}
    </nav>
  )
}

export function SandboxShell() {
  const { c, solo } = useQuery()
  const entry = SANDBOXES.find((s) => s.name === c)
  const Harness = useMemo(() => (entry ? lazy(entry.load) : null), [entry])

  const harness = Harness ? (
    <HarnessBoundary>
      <Suspense fallback={<div className="p-6 text-fg-muted">Loading…</div>}>
        <Harness />
      </Suspense>
    </HarnessBoundary>
  ) : (
    <div className="p-6 text-fg-dim">
      {SANDBOXES.length === 0 ? 'No harnesses registered yet.' : 'Pick a sandbox from the left.'}
    </div>
  )

  if (solo) return <div className="w-full h-full bg-surface text-fg">{harness}</div>

  return (
    <div className="flex w-full h-screen bg-surface text-fg">
      <Nav current={c} />
      <main className="flex-1 min-w-0 overflow-auto">{harness}</main>
    </div>
  )
}
