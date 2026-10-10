import { describe, expect, it } from 'vitest'
import { interpretProbe, parseRational, type ProbeOutput } from '../../src/main/media/probe'

const fmt = (format_name: string, duration = '12.5') => ({ format_name, duration, bit_rate: '128000' })

describe('parseRational', () => {
  it('parses frame rates', () => {
    expect(parseRational('30/1')).toBe(30)
    expect(parseRational('30000/1001')).toBeCloseTo(29.97, 2)
    expect(parseRational('25')).toBe(25)
    expect(parseRational('0/0')).toBeNull()
    expect(parseRational('')).toBeNull()
    expect(parseRational(undefined)).toBeNull()
    expect(parseRational('abc')).toBeNull()
  })
})

describe('interpretProbe', () => {
  it('classifies a plain audio file', () => {
    const out: ProbeOutput = {
      streams: [{ index: 0, codec_type: 'audio', codec_name: 'mp3', sample_rate: '44100', channels: 2 }],
      format: fmt('mp3')
    }
    const r = interpretProbe(out, 'song.mp3')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.metadata.kind).toBe('audio')
    expect(r.metadata.durationSeconds).toBe(12.5)
    expect(r.metadata.audio).toEqual({ codec: 'mp3', sampleRate: 44100, channels: 2 })
    expect(r.metadata.video).toBeNull()
    expect(r.metadata.bitRate).toBe(128000)
  })

  it('treats embedded cover art as audio, not video', () => {
    const out: ProbeOutput = {
      streams: [
        { index: 0, codec_type: 'audio', codec_name: 'mp3' },
        { index: 1, codec_type: 'video', codec_name: 'mjpeg', width: 600, height: 600, disposition: { attached_pic: 1 } }
      ],
      format: fmt('mp3')
    }
    const r = interpretProbe(out, 'song.mp3')
    expect(r.ok && r.metadata.kind).toBe('audio')
    expect(r.ok && r.metadata.primaryStreamIndex).toBe(0)
  })

  it('classifies video and reads frame rate', () => {
    const out: ProbeOutput = {
      streams: [
        { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30000/1001' },
        { index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 }
      ],
      format: fmt('mov,mp4,m4a,3gp,3g2,mj2')
    }
    const r = interpretProbe(out, 'take.mp4')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.metadata.kind).toBe('video')
    expect(r.metadata.video).toMatchObject({ codec: 'h264', width: 1920, height: 1080, rotation: 0 })
    expect(r.metadata.video!.frameRate).toBeCloseTo(29.97, 2)
    expect(r.metadata.audio?.codec).toBe('aac')
  })

  it('falls back to r_frame_rate and handles video without audio', () => {
    const out: ProbeOutput = {
      streams: [{ index: 0, codec_type: 'video', codec_name: 'vp9', width: 640, height: 360, avg_frame_rate: '0/0', r_frame_rate: '24/1' }],
      format: fmt('matroska,webm')
    }
    const r = interpretProbe(out, 'clip.webm')
    expect(r.ok && r.metadata.video?.frameRate).toBe(24)
    expect(r.ok && r.metadata.audio).toBeNull()
  })

  it('swaps display size for rotated phone videos', () => {
    for (const side of [{ rotation: -90 }, { rotation: 90 }, { rotation: 270 }]) {
      const out: ProbeOutput = {
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080, side_data_list: [side] }
        ],
        format: fmt('mov,mp4,m4a,3gp,3g2,mj2')
      }
      const r = interpretProbe(out, 'phone.mov')
      expect(r.ok && r.metadata.video).toMatchObject({ width: 1080, height: 1920 })
    }
    const legacy: ProbeOutput = {
      streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, tags: { rotate: '180' } }],
      format: fmt('mov,mp4,m4a,3gp,3g2,mj2')
    }
    const r = interpretProbe(legacy, 'upside-down.mp4')
    expect(r.ok && r.metadata.video).toMatchObject({ width: 1280, height: 720, rotation: 180 })
  })

  it('rejects still images', () => {
    for (const format of ['image2', 'png_pipe', 'jpeg_pipe']) {
      const r = interpretProbe(
        { streams: [{ index: 0, codec_type: 'video', codec_name: 'png', width: 10, height: 10 }], format: fmt(format, 'N/A') },
        'photo.png'
      )
      expect(r.ok).toBe(false)
      expect(!r.ok && r.reason).toBe('STILL_IMAGE')
    }
  })

  it('rejects files without audio or video', () => {
    const r = interpretProbe({ streams: [{ index: 0, codec_type: 'subtitle', codec_name: 'subrip' }], format: fmt('srt') }, 'subs.srt')
    expect(!r.ok && r.reason).toBe('NO_STREAMS')
    expect(!r.ok && r.message).toContain('subs.srt')
  })

  it('rejects codecs the build cannot decode', () => {
    const r = interpretProbe(
      {
        streams: [{ index: 0, codec_type: 'video', codec_name: 'none', codec_tag_string: 'apr0', width: 10, height: 10 }],
        format: fmt('mov,mp4,m4a,3gp,3g2,mj2')
      },
      'weird.mov'
    )
    expect(!r.ok && r.reason).toBe('UNSUPPORTED_CODEC')
    expect(!r.ok && r.message).toContain('apr0')
  })

  it('rejects media without a usable duration', () => {
    const r = interpretProbe(
      { streams: [{ index: 0, codec_type: 'audio', codec_name: 'mp3' }], format: { format_name: 'mp3', duration: 'N/A' } },
      'broken.mp3'
    )
    expect(!r.ok && r.reason).toBe('NO_DURATION')
  })
})
