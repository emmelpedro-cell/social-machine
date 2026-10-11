import { frameLayout, outputSize, trimmedDuration, type EditSettings } from '../../shared/editor'

export type RenderSource = {
  path: string
  /** Display size (rotation already applied, as FFmpeg decodes it). */
  width: number
  height: number
  durationSeconds: number
  frameRate: number | null
  hasAudio: boolean
}

export type RenderPlanInput = {
  source: RenderSource
  settings: EditSettings
  /** Full-frame transparent PNGs, one per text, in the order of settings.texts (missing texts are skipped). */
  overlays: { textId: string; path: string }[]
  encoder: string
  outputPath: string
}

export type RenderPlan = {
  args: string[]
  width: number
  height: number
  durationSeconds: number
  fps: number
}

const fmt = (n: number) => (Math.round(n * 1000) / 1000).toString()

/** Target video bitrate in bits/s: ~10 Mbit/s for 1080×1920 at 30 fps, scaled by pixel rate. */
export function targetBitrate(width: number, height: number, fps: number): number {
  const reference = 1080 * 1920 * 30
  const bitrate = 10_000_000 * ((width * height * Math.min(fps, 60)) / reference)
  return Math.round(Math.min(20_000_000, Math.max(2_000_000, bitrate)))
}

function encoderArgs(encoder: string, bitrate: number): string[] {
  const rate = ['-b:v', String(bitrate), '-maxrate', String(Math.round(bitrate * 1.5)), '-bufsize', String(bitrate * 2)]
  switch (encoder) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', ...rate]
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'medium', ...rate]
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', 'quality', ...rate]
    case 'h264_mf':
      return ['-c:v', 'h264_mf', ...rate]
    default:
      return ['-c:v', 'libopenh264', '-allow_skip_frames', '0', ...rate]
  }
}

/**
 * Builds the FFmpeg arguments for a version. Pure: no I/O, fully testable.
 *
 * Graph: trim on input → scale the picture to the framing size → either crop
 * it (it covers the frame) or overlay it on a background (blurred copy of the
 * clip, or black) → overlay each text image, enabled during its time range →
 * yuv420p. Audio is copied from the source and encoded as AAC, or dropped.
 */
export function buildRenderPlan(input: RenderPlanInput): RenderPlan {
  const { source, settings } = input
  const out = outputSize(settings.output.preset, source)
  const layout = frameLayout(source, out, settings.frame)
  const duration = trimmedDuration(settings, source.durationSeconds)
  const fps = Math.min(60, source.frameRate && source.frameRate > 0 ? source.frameRate : 30)
  const W = out.width
  const H = out.height

  const args = ['-v', 'error', '-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats']
  args.push('-ss', fmt(settings.trim.start), '-t', fmt(duration), '-i', source.path)

  const textById = new Map(settings.texts.map((t, i) => [t.id, { text: t, index: i }]))
  const overlays = input.overlays
    .filter((o) => textById.has(o.textId))
    .sort((a, b) => textById.get(a.textId)!.index - textById.get(b.textId)!.index)
  for (const o of overlays) args.push('-i', o.path)

  const filters: string[] = []
  const scale = `scale=${layout.width}:${layout.height}:flags=lanczos,setsar=1`
  if (!layout.needsBackground) {
    filters.push(`[0:v]${scale},crop=${W}:${H}:${-layout.left}:${-layout.top}[base]`)
  } else if (settings.frame.background === 'blur') {
    filters.push(`[0:v]split=2[src][bgsrc]`)
    filters.push(
      `[bgsrc]scale=${W}:${H}:force_original_aspect_ratio=increase:flags=bilinear,crop=${W}:${H},gblur=sigma=40,lutyuv=y=val*0.85,setsar=1[bg]`
    )
    filters.push(`[src]${scale}[fg]`)
    filters.push(`[bg][fg]overlay=x=${layout.left}:y=${layout.top}:eof_action=pass[base]`)
  } else {
    filters.push(`color=c=black:s=${W}x${H}:r=${fmt(fps)}[bg]`)
    filters.push(`[0:v]${scale}[fg]`)
    filters.push(`[bg][fg]overlay=x=${layout.left}:y=${layout.top}:shortest=1[base]`)
  }

  let current = 'base'
  overlays.forEach((o, i) => {
    const { text } = textById.get(o.textId)!
    const next = `t${i}`
    const start = text.start ?? 0
    const end = text.end ?? duration
    const timed = start > 0 || end < duration
    const enable = timed ? `:enable='between(t,${fmt(start)},${fmt(end)})'` : ''
    filters.push(`[${current}][${i + 1}:v]overlay=0:0:format=auto${enable}[${next}]`)
    current = next
  })
  const needsFps = source.frameRate !== null && source.frameRate > 60
  filters.push(`[${current}]${needsFps ? 'fps=60,' : ''}format=yuv420p[vout]`)

  args.push('-filter_complex', filters.join(';'), '-map', '[vout]')
  if (source.hasAudio && !settings.audio.mute) {
    args.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k', '-ac', '2')
  } else {
    args.push('-an')
  }
  args.push(...encoderArgs(input.encoder, targetBitrate(W, H, fps)))
  args.push('-movflags', '+faststart', '-f', 'mp4', input.outputPath)

  return { args, width: W, height: H, durationSeconds: duration, fps }
}

/** Parses FFmpeg `-progress` lines into a 0..1 fraction (null when the line carries no time). */
export function progressFromLine(line: string, durationSeconds: number): number | null {
  const match = /^out_time_(?:us|ms)=(\d+)$/.exec(line.trim())
  if (!match || durationSeconds <= 0) return null
  // Despite its name, out_time_ms is also in microseconds.
  const seconds = Number(match[1]) / 1_000_000
  return Math.max(0, Math.min(1, seconds / durationSeconds))
}
