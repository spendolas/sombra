/**
 * verify:export-destination — regression gate for the streaming ExportDestination
 * fallback path.
 *
 * Runs in Node (no DOM), so the disk path (File System Access API) cannot be
 * exercised headlessly — that is fine and noted. This gate exercises the FALLBACK
 * path directly by constructing the destination with `preferDisk: false`, writing
 * chunks through the real WritableStream, and asserting the assembled Blob.
 *
 * MECHANISM-ENGAGED assertion: we prove the chunks are kept SEPARATE (one Blob
 * part per write) rather than concatenated into a single growing buffer — that
 * separation is the whole point (concat is byte-correct but O(n²)/OOM, the exact
 * failure this task prevents). The discriminating observable is the destination's
 * own `_partsCount()` (reads `parts.length` inside the impl, NOT the test's loop
 * counter): after N writes it must equal N. A growing-buffer concat impl keeps
 * ONE part, so `_partsCount()` returns 1 and the assertion trips — while size,
 * order and byte asserts stay GREEN (which is precisely why they cannot catch
 * the regression on their own).
 *
 * Proven to trip: temporarily swapping the fallback `write()` to a growing-buffer
 * concat (`buf = concat(buf, chunk)`, one retained part) made `_partsCount()`
 * return 1 for a 3-chunk write → the `=== 3` assertion FAILED while every other
 * assert stayed green. Reverted so the committed gate is GREEN against the real
 * impl. (See task-1-report.md fix section for the captured output.)
 */
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import { createExportDestination, supportsFileSystemAccess } from '../src/export/export-destination'

// Guard: these gates assume modern Node (tsx) where Blob + WritableStream exist.
// Fail LOUDLY rather than silent-skip if the runtime lacks them.
if (typeof Blob === 'undefined' || typeof WritableStream === 'undefined') {
  console.error('✗ export-destination: Blob/WritableStream unavailable in this runtime — cannot verify')
  process.exit(1)
}

test('fallback assembles ordered chunks into a Blob of correct size/bytes', async () => {
  const dest = await createExportDestination({
    filename: 'out.bin',
    mimeType: 'application/octet-stream',
    ext: 'bin',
    preferDisk: false,
  })

  const chunks = [new Uint8Array([0]), new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])]
  const writer = dest.writable.getWriter()
  for (const c of chunks) await writer.write(c)
  await writer.close()

  const { blob, savedToDisk, filename } = await dest.finalize()

  assert(savedToDisk === false, 'fallback path does not save to disk')
  assert(filename === 'out.bin', 'filename passed through')
  assert(blob !== null, 'fallback produces a Blob')
  assert(blob!.size === 6, `blob size === 6 (got ${blob!.size})`)

  const bytes = new Uint8Array(await blob!.arrayBuffer())
  const expected = [0, 1, 2, 3, 4, 5]
  assert(bytes.length === expected.length, `byte length ${bytes.length} === ${expected.length}`)
  for (let i = 0; i < expected.length; i++) {
    // Byte ORDER preserved — trips if chunks were concatenated out of order.
    assert(bytes[i] === expected[i], `byte[${i}] === ${expected[i]} (got ${bytes[i]})`)
  }
})

test('MECHANISM: chunks kept as separate Blob parts (NOT concatenated into one growing buffer)', async () => {
  const dest = await createExportDestination({
    filename: 'out.bin',
    mimeType: 'application/octet-stream',
    ext: 'bin',
    preferDisk: false,
  })

  const chunks = [new Uint8Array([0]), new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])]
  const writer = dest.writable.getWriter()
  for (const c of chunks) await writer.write(c)
  await writer.close()

  // DISCRIMINATING assertion. `_partsCount()` reads `parts.length` from INSIDE
  // the implementation — it is the impl's own retained-part count, not this
  // test's loop counter. A streaming-safe impl keeps one part per chunk (=== 3);
  // a growing-buffer concat regression keeps exactly one part (=== 1) and trips
  // here, even though it stays byte/size/order correct below.
  assert(typeof dest._partsCount === 'function', 'fallback destination exposes _partsCount()')
  assert(dest._partsCount!() === 3, `impl retained exactly 3 separate parts (got ${dest._partsCount!()})`)

  const { blob } = await dest.finalize()
  // Total size must equal the SUM of per-chunk lengths — proves each chunk was
  // retained in full and none dropped/coalesced-with-loss.
  const expectedSize = chunks.reduce((n, c) => n + c.length, 0)
  assert(blob!.size === expectedSize, `blob size === sum of chunk lengths (${expectedSize}, got ${blob!.size})`)

  // Byte-exact ordered reconstruction: concatenating the ORIGINAL chunks in
  // order must equal the Blob bytes. Any reorder/merge-loss trips this.
  const flat: number[] = []
  for (const c of chunks) for (const b of c) flat.push(b)
  const bytes = new Uint8Array(await blob!.arrayBuffer())
  for (let i = 0; i < flat.length; i++) {
    assert(bytes[i] === flat[i], `ordered reconstruction byte[${i}] === ${flat[i]} (got ${bytes[i]})`)
  }
})

test('supportsFileSystemAccess() is false under headless Node (disk path not exercisable here)', () => {
  // Node has no showSaveFilePicker; the disk path is implemented + type-checked
  // but can only be exercised in a browser. This asserts the capability probe is
  // honest about the environment (so the engine falls back correctly).
  assert(supportsFileSystemAccess() === false, 'no File System Access in headless Node')
})

await run('export-destination')
