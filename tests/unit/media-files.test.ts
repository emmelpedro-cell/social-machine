import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cleanTempDirectory,
  collectImportCandidates,
  hasMediaExtension,
  pathKey,
  quickFingerprint
} from '../../src/main/media/files'
import { tempDir } from '../helpers/node-sqlite-driver'

const dirs: { cleanup: () => void }[] = []
afterEach(() => dirs.splice(0).forEach((d) => d.cleanup()))
const tmp = () => {
  const d = tempDir('sm-files-')
  dirs.push(d)
  return d.path
}

describe('pathKey', () => {
  it('is case-insensitive on Windows only', () => {
    expect(pathKey('C:\\Music\\Take.MP4', 'win32')).toBe(pathKey('c:\\music\\take.mp4', 'win32'))
    expect(pathKey('/music/Take.mp4', 'linux')).not.toBe(pathKey('/music/take.mp4', 'linux'))
  })
})

describe('quickFingerprint', () => {
  it('matches identical content and differs for different content', async () => {
    const dir = tmp()
    const big = Buffer.alloc(5 * 1024 * 1024, 7)
    writeFileSync(join(dir, 'a.bin'), big)
    writeFileSync(join(dir, 'b.bin'), big)
    const changed = Buffer.from(big)
    changed[changed.length - 10] = 8 // a change near the end
    writeFileSync(join(dir, 'c.bin'), changed)
    writeFileSync(join(dir, 'small.bin'), 'hello')

    const a = await quickFingerprint(join(dir, 'a.bin'))
    expect(a.size).toBe(big.length)
    expect(a.hash).toMatch(/^qf1:[0-9a-f]{64}$/)
    expect((await quickFingerprint(join(dir, 'b.bin'))).hash).toBe(a.hash)
    expect((await quickFingerprint(join(dir, 'c.bin'))).hash).not.toBe(a.hash)
    expect((await quickFingerprint(join(dir, 'small.bin'))).size).toBe(5)
  })
})

describe('collectImportCandidates', () => {
  it('takes explicitly chosen files whatever their extension, and filters folder contents', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'odd-name.bin'), 'x')
    mkdirSync(join(dir, 'folder', 'sub'), { recursive: true })
    writeFileSync(join(dir, 'folder', 'a.MP4'), 'x')
    writeFileSync(join(dir, 'folder', 'readme.txt'), 'x')
    writeFileSync(join(dir, 'folder', 'sub', 'b.wav'), 'x')
    mkdirSync(join(dir, 'folder', '.cache'))
    writeFileSync(join(dir, 'folder', '.cache', 'c.wav'), 'x')

    const result = await collectImportCandidates([join(dir, 'odd-name.bin'), join(dir, 'folder'), join(dir, 'nope.wav')])
    expect(result.files).toEqual([join(dir, 'odd-name.bin'), join(dir, 'folder', 'a.MP4'), join(dir, 'folder', 'sub', 'b.wav')])
    expect(result.skippedNonMedia).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.message).toContain('nope.wav')
  })

  it('does not list the same file twice', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'a.wav'), 'x')
    const result = await collectImportCandidates([join(dir, 'a.wav'), dir, join(dir, 'a.wav')])
    expect(result.files).toEqual([join(dir, 'a.wav')])
  })

  it('stops at the file limit and says so', async () => {
    const dir = tmp()
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `${i}.wav`), 'x')
    const result = await collectImportCandidates([dir], { maxFiles: 3 })
    expect(result.files).toHaveLength(3)
    expect(result.truncated).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('does not follow symlinks', async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'real'))
    writeFileSync(join(dir, 'real', 'a.wav'), 'x')
    symlinkSync(join(dir, 'real'), join(dir, 'link'))
    const result = await collectImportCandidates([dir])
    expect(result.files).toEqual([join(dir, 'real', 'a.wav')])
  })

  it('recognises media extensions case-insensitively', () => {
    expect(hasMediaExtension('x.MOV')).toBe(true)
    expect(hasMediaExtension('x.flac')).toBe(true)
    expect(hasMediaExtension('x.docx')).toBe(false)
    expect(hasMediaExtension('x')).toBe(false)
  })
})

describe('cleanTempDirectory', () => {
  it('removes only the app’s own temporary files', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'sm-thumb-1.jpg'), 'x')
    mkdirSync(join(dir, 'sm-work'))
    writeFileSync(join(dir, 'someone-elses.txt'), 'x')
    expect(await cleanTempDirectory(dir)).toBe(2)
    expect(existsSync(join(dir, 'sm-thumb-1.jpg'))).toBe(false)
    expect(existsSync(join(dir, 'sm-work'))).toBe(false)
    expect(existsSync(join(dir, 'someone-elses.txt'))).toBe(true)
    expect(await cleanTempDirectory(join(dir, 'does-not-exist'))).toBe(0)
  })
})
