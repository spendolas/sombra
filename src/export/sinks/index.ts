/**
 * Registers the built-in FrameSinks (Task 5) with the sink registry.
 * Import for side effect once from the app (the ExportModal entry point,
 * Task 7) before reading `getAvailableSinks`/`getSinks`.
 */

import { registerSink } from '../registry'
import { makeMp4Sink } from './webcodecs-mp4'
import { makeWebmAlphaSink } from './webm-alpha'
import { makePngSequenceSink } from './png-sequence'

// Single adaptive MP4 sink: HEVC preferred, automatic H.264-High fallback where
// no hardware H.265 encoder exists (see webcodecs-mp4.ts).
registerSink(makeMp4Sink())
registerSink(makeWebmAlphaSink())
registerSink(makePngSequenceSink())
