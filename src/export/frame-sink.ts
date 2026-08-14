export type QualityLevel = 'draft' | 'good' | 'high' | 'max'
export interface SinkOpts { width: number; height: number; fps: number; alpha: boolean; matte?: string; quality: QualityLevel }
export interface FrameSink {
  readonly id: string
  readonly label: string
  readonly supportsAlpha: boolean
  readonly output: 'file' | 'zip'
  readonly tier: 'free' | 'pro'
  readonly fileExt: string              // 'mp4' | 'webm' | 'zip'
  isSupported(): Promise<boolean>       // runtime feature detection
  begin(o: SinkOpts): Promise<void>
  addFrame(frame: VideoFrame, timestampUs: number): Promise<void>  // sink may also read ImageData internally
  finish(): Promise<Blob>
}
