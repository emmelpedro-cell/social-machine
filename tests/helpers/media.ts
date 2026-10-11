import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveMediaTools, type MediaToolsLocation } from '../../src/main/media/binaries'

/**
 * FFmpeg for tests: SM_FFMPEG_DIR, else the project's vendor copy
 * (installed by `npm run fetch:ffmpeg`). In CI a missing FFmpeg is an error,
 * never a silent skip.
 */
export function testTools(): MediaToolsLocation | null {
  const location = resolveMediaTools({
    isPackaged: false,
    appPath: process.cwd(),
    resourcesPath: '',
    platform: process.platform,
    arch: process.arch,
    env: process.env
  })
  if (existsSync(location.ffmpeg) && existsSync(location.ffprobe)) return location
  if (process.env.CI) {
    throw new Error(`FFmpeg not found at ${location.directory}. Run "npm run fetch:ffmpeg" before the tests.`)
  }
  console.warn(`[tests] FFmpeg not found at ${location.directory}; media tests are skipped. Run "npm run fetch:ffmpeg".`)
  return null
}

export type Fixtures = {
  wav: string
  mp3: string
  flac: string
  m4a: string
  /** MP3 with embedded cover art (a video stream flagged attached_pic). */
  mp3WithCover: string
  /** H.264 + AAC, 320x240, 30 fps, 2 s. */
  mp4: string
  /** MPEG-4 Part 2 + PCM in QuickTime, 640x360, 25 fps, 2 s. */
  mov: string
  /** 320x240 stored, displayed rotated 90° (portrait). */
  rotatedMp4: string
  /** Native vertical 9:16 H.264 + AAC, 180x320, 30 fps, 2 s (like a Drop Machine render). */
  vertical: string
  /** Same format as `mov` (640x360, 25 fps) but different content. */
  mov2: string
  /** Another vertical clip, same format as `vertical` but different content. */
  vertical2: string
  /** Another H.264 clip with different content from `mp4`. */
  otherMp4: string
  /** Random bytes with a video extension. */
  corrupt: string
  /** Text with an audio extension. */
  textAsMp3: string
  /** A real MP4 cut in half (index missing). */
  truncated: string
  /** A single PNG frame. */
  still: string
  /** Not media, for folder scans. */
  notes: string
}

function ffmpeg(tools: MediaToolsLocation, args: string[]): void {
  execFileSync(tools.ffmpeg, ['-v', 'error', '-hide_banner', '-nostdin', '-y', ...args], { stdio: 'pipe' })
}

/** Creates real, small media files with the bundled FFmpeg. */
export function createFixtures(tools: MediaToolsLocation, dir: string): Fixtures {
  mkdirSync(dir, { recursive: true })
  const f = (name: string) => join(dir, name)
  const sine = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3']

  ffmpeg(tools, [...sine, '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', f('tone.wav')])
  ffmpeg(tools, [...sine, '-c:a', 'libmp3lame', '-ar', '44100', '-ac', '2', '-b:a', '128k', f('tone.mp3')])
  ffmpeg(tools, [...sine, '-c:a', 'flac', '-ar', '44100', f('tone.flac')])
  ffmpeg(tools, [...sine, '-c:a', 'aac', '-ar', '44100', '-ac', '2', f('tone.m4a')])
  ffmpeg(tools, ['-f', 'lavfi', '-i', 'color=c=orange:s=64x64', '-frames:v', '1', f('cover.jpg')])
  ffmpeg(tools, [
    '-i', f('tone.mp3'), '-i', f('cover.jpg'),
    '-map', '0:a', '-map', '1:v', '-c', 'copy', '-disposition:v', 'attached_pic', '-id3v2_version', '3',
    f('cover.mp3')
  ])
  ffmpeg(tools, [
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2',
    '-c:v', 'libopenh264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart',
    f('clip.mp4')
  ])
  ffmpeg(tools, [
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2',
    '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'pcm_s16le', '-shortest',
    f('clip.mov')
  ])
  ffmpeg(tools, ['-display_rotation', '90', '-i', f('clip.mp4'), '-c', 'copy', f('rotated.mp4')])
  ffmpeg(tools, [
    '-f', 'lavfi', '-i', 'testsrc2=size=180x320:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=550:duration=2',
    '-c:v', 'libopenh264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart',
    f('vertical.mp4')
  ])
  ffmpeg(tools, [
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=770:duration=2',
    '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'pcm_s16le', '-shortest',
    f('clip2.mov')
  ])
  ffmpeg(tools, [
    '-f', 'lavfi', '-i', 'testsrc=size=180x320:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2',
    '-c:v', 'libopenh264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart',
    f('vertical2.mp4')
  ])
  ffmpeg(tools, [
    '-f', 'lavfi', '-i', 'mandelbrot=size=320x240:rate=30',
    '-t', '2', '-c:v', 'libopenh264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    f('other.mp4')
  ])

  // Moov atom at the end (no faststart), then cut in half: the index is gone.
  ffmpeg(tools, [
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=2',
    '-c:v', 'libopenh264', '-pix_fmt', 'yuv420p',
    f('full-for-truncation.mp4')
  ])
  const full = readFileSync(f('full-for-truncation.mp4'))
  writeFileSync(f('truncated.mp4'), full.subarray(0, Math.floor(full.length / 2)))

  ffmpeg(tools, ['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=1:duration=1', '-frames:v', '1', f('still.png')])
  writeFileSync(f('corrupt.mp4'), randomBytes(64 * 1024))
  writeFileSync(f('not-really.mp3'), 'These are my lyric notes, not an MP3 file.\n'.repeat(50))
  writeFileSync(f('notes.txt'), 'notes')

  return {
    wav: f('tone.wav'),
    mp3: f('tone.mp3'),
    flac: f('tone.flac'),
    m4a: f('tone.m4a'),
    mp3WithCover: f('cover.mp3'),
    mp4: f('clip.mp4'),
    mov: f('clip.mov'),
    rotatedMp4: f('rotated.mp4'),
    vertical: f('vertical.mp4'),
    mov2: f('clip2.mov'),
    vertical2: f('vertical2.mp4'),
    otherMp4: f('other.mp4'),
    corrupt: f('corrupt.mp4'),
    textAsMp3: f('not-really.mp3'),
    truncated: f('truncated.mp4'),
    still: f('still.png'),
    notes: f('notes.txt')
  }
}

/** Width x height of an image or video, read with ffprobe. */
export function probeSize(tools: MediaToolsLocation, path: string): { width: number; height: number } {
  const out = execFileSync(
    tools.ffprobe,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', path],
    { encoding: 'utf8' }
  )
  const stream = (JSON.parse(out) as { streams: { width: number; height: number }[] }).streams[0]!
  return { width: stream.width, height: stream.height }
}
