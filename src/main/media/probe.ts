import { z } from 'zod'
import type { MediaKind } from '../../shared/media'
import type { MediaTools } from './binaries'
import { ProcessError, runProcess } from './run-process'

/* ------------------------------------------------------------------ */
/* ffprobe JSON (only the fields we use; everything else passes)      */
/* ------------------------------------------------------------------ */

const numberish = z.union([z.number(), z.string()]).optional()

const StreamSchema = z
  .object({
    index: z.number(),
    codec_type: z.string().optional(),
    codec_name: z.string().optional(),
    codec_long_name: z.string().optional(),
    codec_tag_string: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    pix_fmt: z.string().optional(),
    avg_frame_rate: z.string().optional(),
    r_frame_rate: z.string().optional(),
    sample_rate: numberish,
    channels: z.number().optional(),
    channel_layout: z.string().optional(),
    duration: numberish,
    bit_rate: numberish,
    disposition: z.record(z.number()).optional(),
    tags: z.record(z.string()).optional(),
    side_data_list: z.array(z.record(z.unknown())).optional()
  })
  .passthrough()

const FormatSchema = z
  .object({
    format_name: z.string().optional(),
    format_long_name: z.string().optional(),
    duration: numberish,
    bit_rate: numberish,
    size: numberish
  })
  .passthrough()

export const ProbeOutputSchema = z
  .object({
    streams: z.array(StreamSchema).default([]),
    format: FormatSchema.optional()
  })
  .passthrough()

export type ProbeOutput = z.infer<typeof ProbeOutputSchema>
type Stream = z.infer<typeof StreamSchema>

/* ------------------------------------------------------------------ */
/* Interpretation                                                     */
/* ------------------------------------------------------------------ */

export type MediaMetadata = {
  kind: MediaKind
  durationSeconds: number
  container: string | null
  bitRate: number | null
  /** Index of the stream used for thumbnails / decode checks. */
  primaryStreamIndex: number
  video: {
    codec: string
    width: number
    height: number
    rotation: number
    frameRate: number | null
  } | null
  audio: {
    codec: string
    sampleRate: number | null
    channels: number | null
  } | null
}

export type ProbeInterpretation =
  | { ok: true; metadata: MediaMetadata }
  | { ok: false; reason: 'NO_STREAMS' | 'STILL_IMAGE' | 'UNSUPPORTED_CODEC' | 'NO_DURATION'; message: string }

function toNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '' || value === 'N/A') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/** "30000/1001" → 29.97; "0/0" or garbage → null. */
export function parseRational(value: string | undefined): number | null {
  if (!value) return null
  const [num, den] = value.split('/').map(Number)
  if (num === undefined || !Number.isFinite(num)) return null
  if (den === undefined) return num > 0 ? num : null
  if (!Number.isFinite(den) || den === 0 || num === 0) return null
  return num / den
}

function rotationOf(stream: Stream): number {
  for (const side of stream.side_data_list ?? []) {
    const r = toNumber(side['rotation'])
    if (r !== null) return normalizeRotation(r)
  }
  const tag = toNumber(stream.tags?.['rotate'])
  return tag === null ? 0 : normalizeRotation(tag)
}

function normalizeRotation(degrees: number): number {
  const r = Math.round(degrees) % 360
  return r < 0 ? r + 360 : r
}

/** Demuxers that read single images rather than timed media. */
function isStillImageFormat(formatName: string | undefined): boolean {
  if (!formatName) return false
  return formatName.split(',').some((f) => f === 'image2' || f.endsWith('_pipe'))
}

function hasDecoder(stream: Stream): boolean {
  return Boolean(stream.codec_name) && stream.codec_name !== 'none'
}

/**
 * Turns raw ffprobe output into the metadata we store, or a user-facing
 * reason why the file can't be used. Pure, so it can be tested without FFmpeg.
 */
export function interpretProbe(output: ProbeOutput, fileName: string): ProbeInterpretation {
  const streams = output.streams
  // Cover art in audio files appears as a video stream flagged attached_pic.
  const videoStreams = streams.filter((s) => s.codec_type === 'video' && s.disposition?.['attached_pic'] !== 1)
  const audioStreams = streams.filter((s) => s.codec_type === 'audio')

  if (isStillImageFormat(output.format?.format_name)) {
    return {
      ok: false,
      reason: 'STILL_IMAGE',
      message: `“${fileName}” é uma imagem parada. A Social Machine importa apenas vídeos.`
    }
  }

  if (videoStreams.length === 0 && audioStreams.length === 0) {
    return {
      ok: false,
      reason: 'NO_STREAMS',
      message: `“${fileName}” não contém áudio nem vídeo.`
    }
  }

  const video = videoStreams.find(hasDecoder) ?? null
  const audio = audioStreams.find(hasDecoder) ?? null

  if (videoStreams.length > 0 && !video) {
    const tag = videoStreams[0]?.codec_tag_string ?? videoStreams[0]?.codec_name ?? 'unknown'
    return {
      ok: false,
      reason: 'UNSUPPORTED_CODEC',
      message: `“${fileName}” usa um codec de vídeo (${tag}) que o FFmpeg incluído não consegue decodificar.`
    }
  }
  if (!video && !audio) {
    const tag = audioStreams[0]?.codec_tag_string ?? audioStreams[0]?.codec_name ?? 'unknown'
    return {
      ok: false,
      reason: 'UNSUPPORTED_CODEC',
      message: `“${fileName}” usa um codec de áudio (${tag}) que o FFmpeg incluído não consegue decodificar.`
    }
  }

  const primary = (video ?? audio)!
  const durationSeconds = toNumber(output.format?.duration) ?? toNumber(primary.duration)
  if (durationSeconds === null || durationSeconds <= 0) {
    return {
      ok: false,
      reason: 'NO_DURATION',
      message: `Não foi possível ler a duração de “${fileName}”. O arquivo pode estar incompleto ou danificado.`
    }
  }

  let videoInfo: MediaMetadata['video'] = null
  if (video) {
    const rotation = rotationOf(video)
    const w = video.width ?? 0
    const h = video.height ?? 0
    const quarterTurn = rotation === 90 || rotation === 270
    videoInfo = {
      codec: video.codec_name!,
      width: quarterTurn ? h : w,
      height: quarterTurn ? w : h,
      rotation,
      frameRate: parseRational(video.avg_frame_rate) ?? parseRational(video.r_frame_rate)
    }
    if (!videoInfo.width || !videoInfo.height) {
      return {
        ok: false,
        reason: 'UNSUPPORTED_CODEC',
        message: `Não foi possível ler o tamanho da imagem de “${fileName}”. O arquivo pode estar danificado.`
      }
    }
  }

  return {
    ok: true,
    metadata: {
      kind: video ? 'video' : 'audio',
      durationSeconds,
      container: output.format?.format_name ?? null,
      bitRate: toNumber(output.format?.bit_rate),
      primaryStreamIndex: primary.index,
      video: videoInfo,
      audio: audio
        ? {
            codec: audio.codec_name!,
            sampleRate: toNumber(audio.sample_rate),
            channels: audio.channels ?? null
          }
        : null
    }
  }
}

/* ------------------------------------------------------------------ */
/* Running ffprobe                                                    */
/* ------------------------------------------------------------------ */

export class MediaReadError extends Error {
  override name = 'MediaReadError'
}

export async function runProbe(
  tools: MediaTools,
  path: string,
  fileName: string,
  signal?: AbortSignal
): Promise<{ raw: ProbeOutput; interpretation: ProbeInterpretation }> {
  let stdout: string
  try {
    ;({ stdout } = await runProcess(
      tools.ffprobe,
      ['-v', 'error', '-hide_banner', '-print_format', 'json', '-show_format', '-show_streams', '-i', path],
      { signal, timeoutMs: 60_000 }
    ))
  } catch (error) {
    if (error instanceof ProcessError && error.code === 'EXIT') {
      throw new MediaReadError(
        `“${fileName}” não é um arquivo de vídeo legível. Ele pode estar danificado ou num formato não suportado.` +
          (error.stderrSummary ? ` (${error.stderrSummary})` : '')
      )
    }
    throw error
  }

  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    throw new MediaReadError(`O FFprobe devolveu informações ilegíveis para “${fileName}”.`)
  }
  const parsed = ProbeOutputSchema.safeParse(json)
  if (!parsed.success) {
    throw new MediaReadError(`O FFprobe devolveu informações inesperadas para “${fileName}”.`)
  }
  return { raw: parsed.data, interpretation: interpretProbe(parsed.data, fileName) }
}
