import type { FrameSink } from './frame-sink'
const sinks: FrameSink[] = []
export function registerSink(s: FrameSink){ if(!sinks.some(x=>x.id===s.id)) sinks.push(s) }
export function getSinks(){ return [...sinks] }
export async function getAvailableSinks(ent: { pro: boolean }){
  const gated = sinks.filter(s => s.tier === 'free' || ent.pro)
  const flags = await Promise.all(gated.map(s => s.isSupported()))
  return gated.filter((_, i) => flags[i])
}
