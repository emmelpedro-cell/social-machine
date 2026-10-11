import { describe, expect, it } from 'vitest'
import {
  defaultEditSettings,
  EditSettingsSchema,
  frameLayout,
  newTextOverlay,
  originalOutputSize,
  outputSize,
  PresetSettingsSchema,
  trimmedDuration,
  validateEdit,
  type EditSettings
} from '../../src/shared/editor'
import { buildRenderPlan, progressFromLine, targetBitrate } from '../../src/main/editor/render-plan'
import { pngSize, safeFileName } from '../../src/main/editor/render-service'
import { overlayPng } from '../helpers/png'

const landscape = { width: 1920, height: 1080 }
const vertical = { width: 1080, height: 1920 }
const settings = (patch: Partial<EditSettings> = {}): EditSettings => ({ ...defaultEditSettings(), ...patch })

describe('output sizes', () => {
  it('uses fixed sizes per preset and keeps "original" even and at most 1920 px', () => {
    expect(outputSize('9:16', landscape)).toEqual({ width: 1080, height: 1920 })
    expect(outputSize('16:9', vertical)).toEqual({ width: 1920, height: 1080 })
    expect(outputSize('4:5', landscape)).toEqual({ width: 1080, height: 1350 })
    expect(outputSize('original', { width: 321, height: 241 })).toEqual({ width: 322, height: 242 })
    expect(originalOutputSize(3840, 2160)).toEqual({ width: 1920, height: 1080 })
  })
})

describe('frameLayout', () => {
  const out = { width: 1080, height: 1920 }

  it('covers the frame, centered by default, cropping the sides of a landscape clip', () => {
    const l = frameLayout(landscape, out, { fit: 'cover', zoom: 1, x: 0, y: 0, background: 'blur' })
    expect(l).toEqual({ width: 3414, height: 1920, left: -1167, top: 0, needsBackground: false })
  })

  it('moves the crop window to the edges with x = -1 and x = 1', () => {
    const left = frameLayout(landscape, out, { fit: 'cover', zoom: 1, x: -1, y: 0, background: 'blur' })
    const right = frameLayout(landscape, out, { fit: 'cover', zoom: 1, x: 1, y: 0, background: 'blur' })
    expect(left.left).toBe(0)
    expect(right.left + right.width).toBe(1080)
  })

  it('contains the whole picture and asks for a background', () => {
    const l = frameLayout(landscape, out, { fit: 'contain', zoom: 1, x: 0, y: 0, background: 'blur' })
    expect(l).toMatchObject({ width: 1080, height: 608, left: 0, top: 656, needsBackground: true })
  })

  it('zooms beyond cover, and a zoom below 1 needs a background', () => {
    const zoomed = frameLayout(vertical, out, { fit: 'cover', zoom: 2, x: 0, y: 0, background: 'blur' })
    expect(zoomed).toMatchObject({ width: 2160, height: 3840, left: -540, top: -960, needsBackground: false })
    const small = frameLayout(vertical, out, { fit: 'cover', zoom: 0.5, x: 0, y: 0, background: 'black' })
    expect(small.needsBackground).toBe(true)
  })

  it('always yields even sizes for H.264', () => {
    const l = frameLayout({ width: 333, height: 777 }, out, { fit: 'cover', zoom: 1.37, x: 0.3, y: -0.2, background: 'blur' })
    expect(l.width % 2).toBe(0)
    expect(l.height % 2).toBe(0)
  })
})

describe('edit settings', () => {
  it('validates the schema, including text styles', () => {
    const valid = settings({ texts: [newTextOverlay('t1')] })
    expect(EditSettingsSchema.parse(valid)).toEqual(valid)
    expect(() => EditSettingsSchema.parse({ ...valid, texts: [{ ...valid.texts[0], color: 'red' }] })).toThrow()
    expect(() => EditSettingsSchema.parse({ ...valid, frame: { ...valid.frame, zoom: 10 } })).toThrow()
    expect(() => EditSettingsSchema.parse({ ...valid, extra: true })).toThrow()
    // Presets keep everything but the trim.
    const { trim: _trim, ...preset } = valid
    expect(PresetSettingsSchema.parse(preset)).toEqual(preset)
  })

  it('computes the trimmed duration and reports impossible edits', () => {
    expect(trimmedDuration(settings({ trim: { start: 1, end: 3 } }), 10)).toBe(2)
    expect(trimmedDuration(settings({ trim: { start: 1, end: null } }), 10)).toBe(9)
    expect(trimmedDuration(settings({ trim: { start: 1, end: 30 } }), 10)).toBe(9)
    expect(validateEdit(settings({ trim: { start: 12, end: null } }), 10)).toHaveLength(2)
    expect(validateEdit(settings({ trim: { start: 1, end: 1.1 } }), 10)[0]).toContain('curto demais')
    const backwards = settings({ texts: [newTextOverlay('t', { start: 3, end: 2 })] })
    expect(validateEdit(backwards, 10)[0]).toContain('termina antes de começar')
    expect(validateEdit(settings(), 10)).toEqual([])
  })
})

describe('buildRenderPlan', () => {
  const source = { path: 'C:\\clips\\lance.mp4', width: 1920, height: 1080, durationSeconds: 10, frameRate: 30, hasAudio: true }

  it('trims on input, crops a covering picture and encodes H.264 + AAC into an MP4', () => {
    const plan = buildRenderPlan({
      source,
      settings: settings({ trim: { start: 2, end: 5.5 } }),
      overlays: [],
      encoder: 'libopenh264',
      outputPath: 'out.mp4.part'
    })
    expect(plan).toMatchObject({ width: 1080, height: 1920, durationSeconds: 3.5, fps: 30 })
    const a = plan.args
    expect(a.slice(a.indexOf('-ss'), a.indexOf('-ss') + 6)).toEqual(['-ss', '2', '-t', '3.5', '-i', source.path])
    const graph = a[a.indexOf('-filter_complex') + 1]!
    expect(graph).toContain('scale=3414:1920')
    expect(graph).toContain('crop=1080:1920:1167:0')
    expect(graph).not.toContain('gblur')
    expect(a).toEqual(expect.arrayContaining(['-c:v', 'libopenh264', '-c:a', 'aac', '-map', '0:a:0', '-movflags', '+faststart']))
    expect(a.at(-1)).toBe('out.mp4.part')
  })

  it('adds a blurred or black background when the picture does not cover the frame', () => {
    const contain = settings({ frame: { fit: 'contain', zoom: 1, x: 0, y: 0, background: 'blur' } })
    const blurred = buildRenderPlan({ source, settings: contain, overlays: [], encoder: 'libopenh264', outputPath: 'o' })
    expect(blurred.args.join(' ')).toContain('gblur')
    const black = buildRenderPlan({
      source,
      settings: { ...contain, frame: { ...contain.frame, background: 'black' } },
      overlays: [],
      encoder: 'libopenh264',
      outputPath: 'o'
    })
    expect(black.args.join(' ')).toContain('color=c=black:s=1080x1920')
  })

  it('overlays text images in text order, timed only when a range is set', () => {
    const texts = [newTextOverlay('a'), newTextOverlay('b', { start: 1, end: 2 })]
    const plan = buildRenderPlan({
      source,
      settings: settings({ texts }),
      overlays: [
        { textId: 'b', path: 'b.png' },
        { textId: 'a', path: 'a.png' },
        { textId: 'stale', path: 'x.png' }
      ],
      encoder: 'h264_nvenc',
      outputPath: 'o'
    })
    const inputs = plan.args.filter((_, i) => plan.args[i - 1] === '-i')
    expect(inputs).toEqual([source.path, 'a.png', 'b.png'])
    const graph = plan.args[plan.args.indexOf('-filter_complex') + 1]!
    expect(graph).toContain("[base][1:v]overlay=0:0:format=auto[t0]")
    expect(graph).toContain("[t0][2:v]overlay=0:0:format=auto:enable='between(t,1,2)'[t1]")
    expect(plan.args).toEqual(expect.arrayContaining(['-c:v', 'h264_nvenc']))
  })

  it('drops audio when muted or absent, and caps the frame rate at 60', () => {
    const muted = buildRenderPlan({ source, settings: settings({ audio: { mute: true } }), overlays: [], encoder: 'x', outputPath: 'o' })
    expect(muted.args).toContain('-an')
    const fast = buildRenderPlan({ source: { ...source, frameRate: 120, hasAudio: false }, settings: settings(), overlays: [], encoder: 'x', outputPath: 'o' })
    expect(fast.fps).toBe(60)
    expect(fast.args.join(' ')).toContain('fps=60')
    expect(fast.args).toContain('-an')
  })

  it('scales the bitrate with pixel rate, within bounds', () => {
    expect(targetBitrate(1080, 1920, 30)).toBe(10_000_000)
    expect(targetBitrate(1080, 1920, 60)).toBe(20_000_000)
    expect(targetBitrate(320, 240, 30)).toBe(2_000_000)
  })
})

describe('helpers', () => {
  it('parses FFmpeg progress lines', () => {
    expect(progressFromLine('out_time_us=1500000', 3)).toBeCloseTo(0.5)
    expect(progressFromLine('out_time_ms=3000000', 3)).toBe(1)
    expect(progressFromLine('frame=12', 3)).toBeNull()
    expect(progressFromLine('out_time_us=N/A', 3)).toBeNull()
  })

  it('makes Windows-safe file names', () => {
    expect(safeFileName('MMA: KO "brutal" / round 1?')).toBe('MMA KO brutal round 1')
    expect(safeFileName('  final.  ')).toBe('final')
    expect(safeFileName('CON')).toBe('video')
    expect(safeFileName('***', 'versao')).toBe('versao')
    expect(safeFileName('x'.repeat(200)).length).toBe(90)
  })

  it('reads PNG dimensions and rejects non-PNG data', () => {
    expect(pngSize(overlayPng(1080, 1920))).toEqual({ width: 1080, height: 1920 })
    expect(pngSize(new Uint8Array([1, 2, 3]))).toBeNull()
  })
})
