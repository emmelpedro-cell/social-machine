import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, isAbsolute, relative } from 'node:path'
import { Readable } from 'node:stream'
import type { ContentsRepository } from '../repositories/contents'

/**
 * sm-media:// serves library media to the renderer for preview:
 *
 *   sm-media://asset/<id>   the source file, with HTTP range support (seeking)
 *   sm-media://thumb/<id>   the generated thumbnail
 *
 * Only ids that exist in the database can be requested; the renderer can
 * never ask for an arbitrary file path.
 */
export const MEDIA_SCHEME = 'sm-media'

export const MEDIA_SCHEME_PRIVILEGES = {
  scheme: MEDIA_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
} as const

const MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  jpg: 'image/jpeg'
}

export function mimeTypeFor(path: string): string {
  return MIME[extname(path).slice(1).toLowerCase()] ?? 'application/octet-stream'
}

export type ByteRange = { start: number; end: number }

/**
 * Parses a single-range "bytes=" header. Returns null when there is no usable
 * header (serve the whole file) and 'unsatisfiable' for a range outside the file.
 */
export function parseRange(header: string | null, size: number): ByteRange | null | 'unsatisfiable' {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, startText = '', endText = ''] = match
  if (startText === '' && endText === '') return null
  if (size === 0) return 'unsatisfiable'

  let start: number
  let end: number
  if (startText === '') {
    // Suffix range: last N bytes.
    const length = Number(endText)
    if (length === 0) return 'unsatisfiable'
    start = Math.max(0, size - length)
    end = size - 1
  } else {
    start = Number(startText)
    end = endText === '' ? size - 1 : Math.min(Number(endText), size - 1)
  }
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}

/** The parts of a fetch Request the handler reads (keeps it testable without Electron). */
export type MediaRequest = { method: string; url: string; headers: { get(name: string): string | null } }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function handleMediaRequest(
  request: MediaRequest,
  deps: { repo: ContentsRepository; thumbnailsDirectory: string }
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
  const url = new URL(request.url)
  const id = url.pathname.replace(/^\//, '')
  if (!UUID.test(id)) return new Response(null, { status: 400 })

  let record
  try {
    record = deps.repo.record(id)
  } catch {
    return new Response(null, { status: 404 })
  }

  let path: string
  if (url.host === 'asset') {
    path = record.sourcePath
  } else if (url.host === 'thumb') {
    if (!record.thumbnailPath) return new Response(null, { status: 404 })
    const rel = relative(deps.thumbnailsDirectory, record.thumbnailPath)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return new Response(null, { status: 403 })
    path = record.thumbnailPath
  } else {
    return new Response(null, { status: 404 })
  }

  let size: number
  try {
    const info = await stat(path)
    if (!info.isFile()) return new Response(null, { status: 404 })
    size = info.size
  } catch {
    return new Response(null, { status: 404 })
  }

  const headers = new Headers({
    'Content-Type': url.host === 'thumb' ? 'image/jpeg' : mimeTypeFor(path),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache'
  })

  const range = parseRange(request.headers.get('Range'), size)
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${size}`)
    return new Response(null, { status: 416, headers })
  }

  const start = range?.start ?? 0
  const end = range?.end ?? size - 1
  const length = size === 0 ? 0 : end - start + 1
  headers.set('Content-Length', String(length))
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`)

  const status = range ? 206 : 200
  if (request.method === 'HEAD' || length === 0) return new Response(null, { status, headers })
  const body = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>
  return new Response(body, { status, headers })
}
