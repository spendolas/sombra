export type QualityLevel = 'draft' | 'good' | 'high' | 'max'
export interface SinkOpts { width: number; height: number; fps: number; alpha: boolean; matte?: string; quality: QualityLevel; baseName?: string }
export interface FrameSink {
  readonly id: string
  readonly label: string
  readonly supportsAlpha: boolean
  readonly output: 'file' | 'zip'
  readonly tier: 'free' | 'pro'
  readonly fileExt: string              // 'mp4' | 'webm' | 'zip'
  readonly mimeType: string             // 'video/mp4' | 'video/webm' | 'application/zip'
  isSupported(): Promise<boolean>       // runtime feature detection
  /**
   * Optional: can this sink actually encode at the given pixel dimensions on THIS
   * device? Video sinks probe their codec at the real export size — a hardware
   * encoder that handles 1080p can still reject a very large frame (e.g. a 4×
   * upscale), which otherwise only surfaces as a mid-export failure. Absent →
   * treat as always encodable (e.g. the PNG sequence).
   */
  probeSize?(width: number, height: number): Promise<boolean>
  /** Begin encoding, streaming all output bytes into `writable` (append-only). */
  begin(o: SinkOpts, writable: WritableStream<Uint8Array>): Promise<void>
  addFrame(frame: VideoFrame, timestampUs: number): Promise<void>  // sink may also read ImageData internally
  /**
   * Fast path for sinks that want raw straight-alpha RGBA instead of a
   * VideoFrame (PNG sequence). When present, the engine calls THIS instead of
   * `addFrame`, handing over the frame's readback buffer directly (the sink /
   * its worker pool may TRANSFER `rgba.buffer` — the engine does not reuse it).
   * `index` is the 0-based frame number; `timestampUs` mirrors `addFrame`'s.
   */
  addFrameRaw?(rgba: Uint8ClampedArray, width: number, height: number, index: number, timestampUs: number): Promise<void>
  /** Flush the encoder and CLOSE the writable. No Blob — bytes already streamed out. */
  finish(): Promise<void>
  /**
   * Deterministic cancel/failure teardown. Stops the encoder (mediabunny
   * `Output.cancel()` / fflate `Zip.terminate()`), then RELEASES this sink's
   * writer and ABORTS the destination writable — which on the File System Access
   * path discards the swap file rather than leaking its handle to GC. Safe to
   * call before `begin()` (no-op) and idempotent; never throws (best-effort).
   */
  abort(): Promise<void>
}
