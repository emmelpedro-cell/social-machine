import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createThumbnail, THUMBNAIL_WIDTH, thumbnailTime, verifyDecodable } from '../../src/main/media/operations'
import { MediaReadError, runProbe } from '../../src/main/media/probe'
import { ProcessError, runProcess } from '../../src/main/media/run-process'
import { tempDir } from '../helpers/node-sqlite-driver'
import { createFixtures, probeSize, testTools, type Fixtures } from '../helpers/media'

const tools = testTools()

describe.skipIf(!tools)('FFmpeg operations on real media', () => {
  const dir = tempDir('sm-ops-')
  let fx: Fixtures
  const thumbs = join(dir.path, 'thumbs')
  const temp = join(dir.path, 'temp')

  beforeAll(() => {
    fx = createFixtures(tools!, dir.path)
    mkdirSync(thumbs)
    mkdirSync(temp)
  })
  afterAll(() => dir.cleanup())

  const probe = async (path: string) => {
    const { interpretation } = await runProbe(tools!, path, path.split(/[\\/]/).pop()!)
    if (!interpretation.ok) throw new Error(interpretation.message)
    return interpretation.metadata
  }

  it('reads audio metadata for WAV, MP3, FLAC and M4A', async () => {
    const cases: [string, string, number][] = [
      [fx.wav, 'pcm_s16le', 48000],
      [fx.mp3, 'mp3', 44100],
      [fx.flac, 'flac', 44100],
      [fx.m4a, 'aac', 44100]
    ]
    for (const [path, codec, sampleRate] of cases) {
      const m = await probe(path)
      expect(m.kind, path).toBe('audio')
      expect(m.audio?.codec, path).toBe(codec)
      expect(m.audio?.sampleRate, path).toBe(sampleRate)
      expect(m.durationSeconds, path).toBeGreaterThan(2.9)
      expect(m.durationSeconds, path).toBeLessThan(3.2)
      await verifyDecodable(tools!, path, 'x', m)
    }
  })

  it('treats an MP3 with cover art as audio', async () => {
    const m = await probe(fx.mp3WithCover)
    expect(m.kind).toBe('audio')
  })

  it('reads video metadata for MP4 and MOV', async () => {
    const mp4 = await probe(fx.mp4)
    expect(mp4).toMatchObject({ kind: 'video' })
    expect(mp4.video).toMatchObject({ codec: 'h264', width: 320, height: 240, frameRate: 30 })
    expect(mp4.audio?.codec).toBe('aac')
    expect(mp4.durationSeconds).toBeGreaterThan(1.9)

    const mov = await probe(fx.mov)
    expect(mov.video).toMatchObject({ codec: 'mpeg4', width: 640, height: 360, frameRate: 25 })
    expect(mov.audio?.codec).toBe('pcm_s16le')
    expect(mov.container).toContain('mov')
  })

  it('reports the display size of rotated video', async () => {
    const m = await probe(fx.rotatedMp4)
    expect(m.video).toMatchObject({ width: 240, height: 320, rotation: 90 })
  })

  it('creates a JPEG thumbnail at the expected size', async () => {
    const m = await probe(fx.mp4)
    const out = join(thumbs, 'mp4.jpg')
    await createThumbnail(tools!, fx.mp4, 'clip.mp4', m, out, temp)
    const bytes = readFileSync(out)
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xff, 0xd8, 0xff])
    expect(probeSize(tools!, out)).toEqual({ width: THUMBNAIL_WIDTH, height: 360 })
    // Temp files are cleaned up.
    expect(readdirSync(temp)).toEqual([])
  })

  it('applies rotation to thumbnails', async () => {
    const m = await probe(fx.rotatedMp4)
    const out = join(thumbs, 'rotated.jpg')
    await createThumbnail(tools!, fx.rotatedMp4, 'rotated.mp4', m, out, temp)
    expect(probeSize(tools!, out)).toEqual({ width: THUMBNAIL_WIDTH, height: 640 })
  })

  it('picks a thumbnail time inside the clip', () => {
    expect(thumbnailTime(0.5)).toBe(0)
    expect(thumbnailTime(2)).toBeCloseTo(0.4)
    expect(thumbnailTime(3600)).toBe(10)
  })

  it('rejects random bytes, text files, truncated video and still images with clear messages', async () => {
    await expect(runProbe(tools!, fx.corrupt, 'corrupt.mp4')).rejects.toThrow(MediaReadError)
    await expect(runProbe(tools!, fx.corrupt, 'corrupt.mp4')).rejects.toThrow(/corrupt\.mp4/)
    await expect(runProbe(tools!, fx.textAsMp3, 'not-really.mp3')).rejects.toThrow(MediaReadError)
    await expect(runProbe(tools!, fx.truncated, 'truncated.mp4')).rejects.toThrow(MediaReadError)

    const still = await runProbe(tools!, fx.still, 'still.png')
    expect(still.interpretation.ok).toBe(false)
    expect(!still.interpretation.ok && still.interpretation.reason).toBe('STILL_IMAGE')
  })

  it('cancels a running FFmpeg process', async () => {
    const m = await probe(fx.mp4)
    const controller = new AbortController()
    const pending = createThumbnail(tools!, fx.mp4, 'clip.mp4', m, join(thumbs, 'cancelled.jpg'), temp, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow(ProcessError)
    expect(existsSync(join(thumbs, 'cancelled.jpg'))).toBe(false)
    expect(readdirSync(temp)).toEqual([])
  })
})

describe('runProcess', () => {
  const node = process.execPath

  it('returns stdout of a successful run', async () => {
    const { stdout } = await runProcess(node, ['-e', 'process.stdout.write("hello")'])
    expect(stdout).toBe('hello')
  })

  it('reports non-zero exit with stderr', async () => {
    const error = await runProcess(node, ['-e', 'console.error("Invalid data found"); process.exit(3)']).catch((e) => e)
    expect(error).toBeInstanceOf(ProcessError)
    expect(error.code).toBe('EXIT')
    expect(error.details.exitCode).toBe(3)
    expect(error.stderrSummary).toBe('Invalid data found')
  })

  it('kills a process that runs too long', async () => {
    const started = Date.now()
    const error = await runProcess(node, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 300 }).catch((e) => e)
    expect(error.code).toBe('TIMEOUT')
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('kills a process when aborted', async () => {
    const controller = new AbortController()
    const pending = runProcess(node, ['-e', 'setTimeout(() => {}, 30000)'], { signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    const error = await pending.catch((e) => e)
    expect(error.code).toBe('ABORTED')
  })

  it('reports a program that does not exist', async () => {
    const error = await runProcess(join(process.cwd(), 'no-such-program'), []).catch((e) => e)
    expect(error.code).toBe('SPAWN')
  })

  it('passes file names with spaces and shell characters safely', async () => {
    const { stdout } = await runProcess(node, ['-e', 'process.stdout.write(process.argv[1])', 'a b & "c" $(d).mp4'])
    expect(stdout).toBe('a b & "c" $(d).mp4')
  })
})
