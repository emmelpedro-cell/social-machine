import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runMigrations } from '../../src/main/db/migrations'
import { handleMediaRequest, mimeTypeFor, parseRange, type MediaRequest } from '../../src/main/media/protocol'
import { ContentsRepository } from '../../src/main/repositories/contents'
import { createNodeSqliteDriver, tempDir } from '../helpers/node-sqlite-driver'

describe('parseRange', () => {
  it('parses byte ranges', () => {
    expect(parseRange(null, 100)).toBeNull()
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
    expect(parseRange('bytes=90-200', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 })
  })

  it('rejects ranges outside the file', () => {
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=50-10', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable')
  })

  it('ignores headers it does not understand', () => {
    expect(parseRange('items=0-5', 100)).toBeNull()
    expect(parseRange('bytes=0-5,10-15', 100)).toBeNull()
    expect(parseRange('bytes=-', 100)).toBeNull()
  })
})

describe('sm-media protocol handler', () => {
  const dir = tempDir('sm-protocol-')
  const thumbs = join(dir.path, 'thumbnails')
  const source = join(dir.path, 'take.mp4')
  const content = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256))
  let repo: ContentsRepository
  let id: string

  const request = (url: string, headers: Record<string, string> = {}, method = 'GET'): MediaRequest => ({
    method,
    url,
    headers: { get: (name) => headers[name] ?? headers[name.toLowerCase()] ?? null }
  })
  const deps = () => ({ repo, thumbnailsDirectory: thumbs })

  beforeAll(() => {
    mkdirSync(thumbs)
    writeFileSync(source, content)
    const db = createNodeSqliteDriver()
    runMigrations(db)
    repo = new ContentsRepository(db)
    id = repo.insertPending({ path: source, pathKey: source, size: content.length, mtimeMs: 0 })!.id
    writeFileSync(join(thumbs, `${id}.jpg`), Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
    db.prepare('UPDATE contents SET thumbnail_path = ? WHERE id = ?').run(join(thumbs, `${id}.jpg`), id)
  })
  afterAll(() => dir.cleanup())

  it('serves the whole source file', async () => {
    const res = await handleMediaRequest(request(`sm-media://asset/${id}`), deps())
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('video/mp4')
    expect(res.headers.get('Accept-Ranges')).toBe('bytes')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(content)
  })

  it('serves byte ranges for seeking', async () => {
    const res = await handleMediaRequest(request(`sm-media://asset/${id}`, { Range: 'bytes=100-199' }), deps())
    expect(res.status).toBe(206)
    expect(res.headers.get('Content-Range')).toBe('bytes 100-199/1000')
    expect(res.headers.get('Content-Length')).toBe('100')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(content.subarray(100, 200))

    const bad = await handleMediaRequest(request(`sm-media://asset/${id}`, { Range: 'bytes=5000-' }), deps())
    expect(bad.status).toBe(416)
  })

  it('serves thumbnails', async () => {
    const res = await handleMediaRequest(request(`sm-media://thumb/${id}`), deps())
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/jpeg')
  })

  it('only serves known assets, never arbitrary paths', async () => {
    const cases = [
      `sm-media://asset/00000000-0000-4000-8000-000000000000`,
      `sm-media://asset/..%2F..%2Fetc%2Fpasswd`,
      `sm-media://file/${id}`,
      `sm-media://asset/${encodeURIComponent(source)}`
    ]
    for (const url of cases) {
      const res = await handleMediaRequest(request(url), deps())
      expect(res.status, url).toBeGreaterThanOrEqual(400)
    }
  })

  it('refuses thumbnails outside the thumbnails folder', async () => {
    const other = repo.insertPending({ path: join(dir.path, 'b.mp4'), pathKey: 'b', size: 1, mtimeMs: 0 })!
    copyFileSync(source, join(dir.path, 'b.mp4'))
    // A tampered database row pointing elsewhere must not be served.
    ;(repo as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db
      .prepare('UPDATE contents SET thumbnail_path = ? WHERE id = ?')
      .run(source, other.id)
    const res = await handleMediaRequest(request(`sm-media://thumb/${other.id}`), deps())
    expect(res.status).toBe(403)
  })

  it('returns 404 when the source file is gone', async () => {
    const gone = repo.insertPending({ path: join(dir.path, 'gone.mp4'), pathKey: 'gone', size: 1, mtimeMs: 0 })!
    const res = await handleMediaRequest(request(`sm-media://asset/${gone.id}`), deps())
    expect(res.status).toBe(404)
  })

  it('answers HEAD without a body', async () => {
    const res = await handleMediaRequest(request(`sm-media://asset/${id}`, {}, 'HEAD'), deps())
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Length')).toBe('1000')
    expect(res.body).toBeNull()
  })

  it('maps common extensions to MIME types', () => {
    expect(mimeTypeFor('a.MOV')).toBe('video/quicktime')
    expect(mimeTypeFor('a.flac')).toBe('audio/flac')
    expect(mimeTypeFor('a.m4a')).toBe('audio/mp4')
    expect(mimeTypeFor('a.xyz')).toBe('application/octet-stream')
  })

  it('reads the source file exactly as on disk', () => {
    expect(readFileSync(source)).toEqual(content)
  })
})
