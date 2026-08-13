import { test, run, assert } from './blur-bakeoff/lib/test-util'
import { registerSink, getSinks, getAvailableSinks } from '../src/export/registry'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeFree = { id:'a', label:'A', supportsAlpha:false, output:'file', tier:'free', fileExt:'mp4', isSupported:async()=>true, begin:async()=>{}, addFrame:async()=>{}, finish:async()=>new Blob() } as any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeProUnsup = { id:'b', label:'B', supportsAlpha:true, output:'file', tier:'pro', fileExt:'webm', isSupported:async()=>false, begin:async()=>{}, addFrame:async()=>{}, finish:async()=>new Blob() } as any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const freeFalse = { id:'c', label:'C', supportsAlpha:false, output:'file', tier:'free', fileExt:'mp4', isSupported:async()=>false, begin:async()=>{}, addFrame:async()=>{}, finish:async()=>new Blob() } as any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const proTrue = { id:'d', label:'D', supportsAlpha:true, output:'file', tier:'pro', fileExt:'webm', isSupported:async()=>true, begin:async()=>{}, addFrame:async()=>{}, finish:async()=>new Blob() } as any
registerSink(fakeFree); registerSink(fakeProUnsup); registerSink(freeFalse); registerSink(proTrue)
test('free entitlement hides pro + unsupported', async () => {
  const av = await getAvailableSinks({ pro:false })
  assert(av.length === 1 && av[0].id === 'a', 'only the supported free sink')
})
test('isSupported() gate engaged independently (free+unsupported excluded)', async () => {
  const av = await getAvailableSinks({ pro:false })
  assert(!av.find(s => s.id === 'c'), 'free unsupported sink excluded by isSupported() gate')
})
test('tier gate opens under pro entitlement', async () => {
  const avFree = await getAvailableSinks({ pro:false })
  const avPro = await getAvailableSinks({ pro:true })
  assert(avFree.length === 1 && avFree[0].id === 'a', 'no pro sinks without pro entitlement')
  assert(avPro.length === 2 && avPro.some(s => s.id === 'a') && avPro.some(s => s.id === 'd'), 'pro sinks appear with pro entitlement')
})
test('dedup engaged (same sink registered twice)', async () => {
  const sinksBefore = getSinks().length
  registerSink(fakeFree)
  const sinksAfter = getSinks().length
  assert(sinksBefore === sinksAfter, 'duplicate registration by id is rejected')
})
await run('export-registry')
