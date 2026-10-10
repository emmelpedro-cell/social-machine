import type { MediaToolsStatus } from '../../shared/media'
import { UnavailableError } from '../errors'
import type { Logger } from '../logger'
import { verifyMediaTools, type MediaTools, type MediaToolsLocation } from './binaries'

/**
 * Verifies FFmpeg once and caches the result. Media operations call
 * `require()`, which throws an actionable UnavailableError when the tools
 * are missing or broken, so no FFmpeg process is ever started blindly.
 */
export class MediaToolsManager {
  private pending: Promise<MediaToolsStatus> | null = null

  constructor(
    private readonly location: MediaToolsLocation,
    private readonly logger: Logger
  ) {}

  status(): Promise<MediaToolsStatus> {
    if (!this.pending) {
      this.pending = verifyMediaTools(this.location).then((status) => {
        if (status.ok) {
          this.logger.info('FFmpeg ready', {
            source: status.source,
            directory: status.directory,
            ffmpeg: status.ffmpegVersion,
            ffprobe: status.ffprobeVersion,
            license: status.license
          })
        } else {
          this.logger.error('FFmpeg unavailable', { code: status.code, directory: status.directory, detail: status.detail })
        }
        return status
      })
    }
    return this.pending
  }

  recheck(): Promise<MediaToolsStatus> {
    this.pending = null
    return this.status()
  }

  async require(): Promise<MediaTools> {
    const status = await this.status()
    if (!status.ok) throw new UnavailableError(status.message)
    return { ffmpeg: this.location.ffmpeg, ffprobe: this.location.ffprobe }
  }
}
