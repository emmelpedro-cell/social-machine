import { deflateSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/**
 * A transparent RGBA PNG with one opaque rectangle, like a text overlay
 * rendered by the editor. Rectangle given as fractions of the frame.
 */
export function overlayPng(
  width: number,
  height: number,
  rect = { x: 0.25, y: 0.1, w: 0.5, h: 0.08 },
  color: [number, number, number] = [255, 0, 0]
): Uint8Array {
  const x0 = Math.round(rect.x * width)
  const x1 = Math.round((rect.x + rect.w) * width)
  const y0 = Math.round(rect.y * height)
  const y1 = Math.round((rect.y + rect.h) * height)
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1)
    raw[row] = 0 // filter: none
    if (y < y0 || y >= y1) continue
    for (let x = x0; x < x1; x++) {
      const i = row + 1 + x * 4
      raw[i] = color[0]
      raw[i + 1] = color[1]
      raw[i + 2] = color[2]
      raw[i + 3] = 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
  return new Uint8Array(png)
}
