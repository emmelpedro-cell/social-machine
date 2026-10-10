import { randomUUID } from 'node:crypto'
import { open, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { MediaTools } from './binaries'
import { MediaReadError, type MediaMetadata } from './probe'
import { ProcessError, runProcess } from './run-process'

/** Prefix for every file the app writes to app-data/temp, so cleanup only touches its own files. */
export const TEMP_PREFIX = 'sm-'

/**
 * Decodes the first few seconds of the main stream. ffprobe only reads
 * headers; this proves the codec data is actually decodable.
 */
export async function verifyDecodable(
  tools: MediaTools,
  path: string,
  fileName: string,
  metadata: MediaMetadata,
  signal?: AbortSignal
): Promise<void> {
  try {
    await runProcess(
      tools.ffmpeg,
      [
        '-v', 'error',
        '-hide_banner',
        '-nostdin',
        '-t', '3',
        '-i', path,
        '-map', `0:${metadata.primaryStreamIndex}`,
        '-f', 'null',
        '-'
      ],
      { signal, timeoutMs: 90_000 }
    )
  } catch (error) {
    if (error instanceof ProcessError && error.code === 'EXIT') {
      throw new MediaReadError(
        `“${fileName}” não pôde ser decodificado. Ele pode estar danificado ou usar um codec não suportado.` +
          (error.stderrSummary ? ` (${error.stderrSummary})` : '')
      )
    }
    throw error
  }
}

export const THUMBNAIL_WIDTH = 480

/** A frame a little way in: first frames are often black or a fade-in. */
export function thumbnailTime(durationSeconds: number): number {
  if (durationSeconds <= 1) return 0
  return Math.min(durationSeconds * 0.2, 10)
}

const JPEG_MAGIC = [0xff, 0xd8, 0xff]

async function isJpeg(path: string): Promise<boolean> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(3)
    const { bytesRead } = await handle.read(buffer, 0, 3, 0)
    return bytesRead === 3 && JPEG_MAGIC.every((b, i) => buffer[i] === b)
  } finally {
    await handle.close()
  }
}

/**
 * Writes a JPEG thumbnail (THUMBNAIL_WIDTH wide, aspect preserved, rotation
 * applied) to `destination`. Renders into the temp folder first and moves the
 * finished file into place, so a cancelled or failed run never leaves a
 * half-written thumbnail behind.
 */
export async function createThumbnail(
  tools: MediaTools,
  path: string,
  fileName: string,
  metadata: MediaMetadata,
  destination: string,
  tempDirectory: string,
  signal?: AbortSignal
): Promise<void> {
  const tmp = join(tempDirectory, `${TEMP_PREFIX}thumb-${randomUUID()}.jpg`)
  const render = (seconds: number) =>
    runProcess(
      tools.ffmpeg,
      [
        '-v', 'error',
        '-hide_banner',
        '-nostdin',
        '-ss', seconds.toFixed(3),
        '-i', path,
        '-map', `0:${metadata.primaryStreamIndex}`,
        '-frames:v', '1',
        '-vf', `scale=${THUMBNAIL_WIDTH}:-2:flags=bicubic`,
        '-c:v', 'mjpeg',
        '-q:v', '4',
        '-update', '1',
        '-y',
        tmp
      ],
      { signal, timeoutMs: 90_000 }
    )

  try {
    const at = thumbnailTime(metadata.durationSeconds)
    try {
      await render(at)
    } catch (error) {
      if (!(error instanceof ProcessError && error.code === 'EXIT') || at === 0) throw error
    }
    // Seeking can land past the last decodable frame in short or odd files; fall back to the start.
    if (!(await exists(tmp)) || (await stat(tmp)).size === 0) await render(0)
    if (!(await exists(tmp)) || !(await isJpeg(tmp))) {
      throw new MediaReadError(`Não foi possível extrair uma imagem de “${fileName}”.`)
    }
    await rename(tmp, destination)
  } catch (error) {
    if (error instanceof ProcessError && error.code === 'EXIT') {
      throw new MediaReadError(
        `Não foi possível criar a miniatura de “${fileName}”.` + (error.stderrSummary ? ` (${error.stderrSummary})` : '')
      )
    }
    throw error
  } finally {
    await rm(tmp, { force: true })
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
