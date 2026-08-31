/**
 * perf-view — local dev harness for the PerfView profiler UI (Task 4).
 * View via the sandbox registry (sandbox.html?c=perf-view) or the standalone
 * perf-view-sandbox.html entry. Not shipped.
 *
 * PerfView creates a real PerfSession, which compiles graphs with the real
 * compiler — so the node library MUST be initialized before it mounts (the
 * standalone sandbox has no App.tsx to do it). We also SEED a benchmark scene
 * into the graph store so the "Live graph" subject and the node-isolation
 * select have real nodes to show; this seeding is HARNESS-ONLY.
 */

import { useEffect, useState } from 'react'
import { initializeNodeLibrary } from '@/nodes'
import { useGraphStore } from '@/stores/graphStore'
import { buildChainHeavy } from '@/perf/scenes'
import { PerfView } from '@/components/perf/PerfView'

// Register the node definitions (compileGraph/compileGraphIR need them). Runs
// once per module evaluation, mirroring what main.tsx does for the real app.
initializeNodeLibrary()

export default function PerfViewHarness() {
  const [seeded, setSeeded] = useState(false)

  // HARNESS-ONLY: seed a real graph so "Live graph" + node isolation have data.
  useEffect(() => {
    const { nodes, edges } = buildChainHeavy()
    useGraphStore.getState().loadGraph(nodes, edges)
    setSeeded(true)
  }, [])

  if (!seeded) return null

  return (
    <div className="w-full h-[720px] p-lg bg-surface">
      <PerfView />
    </div>
  )
}
