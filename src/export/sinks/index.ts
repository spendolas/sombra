/**
 * Registers the built-in FrameSinks (Task 5) with the sink registry.
 * Import for side effect once from the app (the ExportModal entry point,
 * Task 7) before reading `getAvailableSinks`/`getSinks`.
 */

import { registerSink } from '../registry'
import { makeMp4Sink } from './webcodecs-mp4'
import { makeHevcSink } from './mp4-hevc'
import { makeWebmAlphaSink } from './webm-alpha'
import { makePngSequenceSink } from './png-sequence'

registerSink(makeMp4Sink())
// HEVC after H.264 so H.264-High stays the default/first MP4 option; the HEVC
// card only appears where a hardware H.265 encoder makes it encodable.
registerSink(makeHevcSink())
registerSink(makeWebmAlphaSink())
registerSink(makePngSequenceSink())
