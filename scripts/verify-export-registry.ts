import { test, run, assert } from './blur-bakeoff/lib/test-util'
import { registerSink, getAvailableSinks } from '../src/export/registry'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeFree = { id:'a', label:'A', supportsAlpha:false, output:'file', tier:'free', fileExt:'mp4', isSupported:async()=>true, begin:async()=>{}, addFrame:async()=>{}, finish:async()=>new Blob() } as any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeProUnsup = { id:'b', label:'B', supportsAlpha:true, output:'file', tier:'pro', fileExt:'webm', isSupported:async()=>false, begin:async()=>{}, addFrame:async()=>{}, finish:async()=>new Blob() } as any
registerSink(fakeFree); registerSink(fakeProUnsup)
test('free entitlement hides pro + unsupported', async () => {
  const av = await getAvailableSinks({ pro:false })
  assert(av.length === 1 && av[0].id === 'a', 'only the supported free sink')
})
await run('export-registry')
