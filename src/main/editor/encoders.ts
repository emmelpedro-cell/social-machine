import type { EncoderInfo } from '../../shared/editor'
import type { Logger } from '../logger'
import type { MediaTools } from '../media/binaries'
import { runProcess } from '../media/run-process'

/** H.264 encoders in order of preference. Hardware first; OpenH264 (software, in the LGPL build) always works. */
export const H264_ENCODERS: readonly EncoderInfo[] = [
  { id: 'h264_nvenc', label: 'NVIDIA NVENC', hardware: true },
  { id: 'h264_qsv', label: 'Intel Quick Sync', hardware: true },
  { id: 'h264_amf', label: 'AMD AMF', hardware: true },
  { id: 'h264_mf', label: 'Windows Media Foundation', hardware: true },
  { id: 'libopenh264', label: 'OpenH264 (software)', hardware: false }
]

export const SOFTWARE_ENCODER = H264_ENCODERS[H264_ENCODERS.length - 1]!

/**
 * Finds the first H.264 encoder that actually works on this machine, by
 * encoding a few frames of a test pattern. A listed encoder can still fail
 * (no GPU, old driver), so listing alone isn't enough. The result is cached.
 */
export class EncoderSelector {
  private detected: Promise<EncoderInfo> | null = null

  constructor(
    private readonly getTools: () => Promise<MediaTools>,
    private readonly logger: Logger,
    private readonly candidates: readonly EncoderInfo[] = H264_ENCODERS
  ) {}

  /** The encoder to use: the detected one, or software when hardware is turned off. */
  async select(preference: 'auto' | 'software'): Promise<EncoderInfo> {
    if (preference === 'software') return SOFTWARE_ENCODER
    this.detected ??= this.detect().catch((error) => {
      this.detected = null
      throw error
    })
    return this.detected
  }

  /** Forget the detection (e.g. after a hardware encoder failed during a render). */
  reset(): void {
    this.detected = null
  }

  private async detect(): Promise<EncoderInfo> {
    const tools = await this.getTools()
    for (const candidate of this.candidates) {
      if (await this.works(tools, candidate.id)) {
        this.logger.info('H.264 encoder selected', { encoder: candidate.id })
        return candidate
      }
    }
    this.logger.warn('No H.264 encoder passed the test; using OpenH264')
    return SOFTWARE_ENCODER
  }

  private async works(tools: MediaTools, encoder: string): Promise<boolean> {
    try {
      await runProcess(
        tools.ffmpeg,
        [
          '-v', 'error', '-hide_banner', '-nostdin',
          '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=0.3',
          '-pix_fmt', 'yuv420p', '-c:v', encoder, '-b:v', '1M',
          '-f', 'null', '-'
        ],
        { timeoutMs: 20_000 }
      )
      return true
    } catch {
      return false
    }
  }
}
