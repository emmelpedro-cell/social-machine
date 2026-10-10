import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveMediaTools, verifyMediaTools } from '../../src/main/media/binaries'
import { MediaToolsManager } from '../../src/main/media/tools-manager'
import { UnavailableError } from '../../src/main/errors'
import { memoryLogger, tempDir } from '../helpers/node-sqlite-driver'
import { testTools } from '../helpers/media'

const dirs: { cleanup: () => void }[] = []
afterEach(() => dirs.splice(0).forEach((d) => d.cleanup()))

describe('resolveMediaTools', () => {
  const base = { appPath: '/project', resourcesPath: '/install/resources', arch: 'x64', env: {} }

  it('uses the vendor folder in development', () => {
    const loc = resolveMediaTools({ ...base, isPackaged: false, platform: 'linux' })
    expect(loc.source).toBe('development')
    expect(loc.directory).toBe(join('/project', 'vendor', 'ffmpeg', 'linux-x64'))
    expect(loc.ffmpeg).toBe(join('/project', 'vendor', 'ffmpeg', 'linux-x64', 'bin', 'ffmpeg'))
    expect(loc.ffprobe).toBe(join('/project', 'vendor', 'ffmpeg', 'linux-x64', 'bin', 'ffprobe'))
  })

  it('uses resources/ffmpeg in a packaged build, with .exe on Windows', () => {
    const loc = resolveMediaTools({ ...base, isPackaged: true, platform: 'win32' })
    expect(loc.source).toBe('packaged')
    expect(loc.directory).toBe(join('/install/resources', 'ffmpeg'))
    expect(loc.ffmpeg).toBe(join('/install/resources', 'ffmpeg', 'bin', 'ffmpeg.exe'))
    expect(loc.ffprobe).toBe(join('/install/resources', 'ffmpeg', 'bin', 'ffprobe.exe'))
  })

  it('lets SM_FFMPEG_DIR override both', () => {
    for (const isPackaged of [true, false]) {
      const loc = resolveMediaTools({ ...base, isPackaged, platform: 'linux', env: { SM_FFMPEG_DIR: '/custom/ff' } })
      expect(loc.source).toBe('environment')
      // Resolved to an absolute path (on Windows this gains the current drive letter).
      expect(loc.ffmpeg).toBe(join(resolve('/custom/ff'), 'bin', 'ffmpeg'))
    }
  })

  it('never falls back to the system PATH', () => {
    const loc = resolveMediaTools({ ...base, isPackaged: false, platform: 'linux', env: { PATH: '/usr/bin' } })
    expect(loc.ffmpeg.startsWith(join('/project', 'vendor'))).toBe(true)
  })
})

describe('verifyMediaTools', () => {
  const tools = testTools()

  it.skipIf(!tools)('runs the bundled ffmpeg and ffprobe and reports their version and license', async () => {
    const status = await verifyMediaTools(tools!)
    expect(status.ok).toBe(true)
    if (!status.ok) return
    expect(status.ffmpegVersion).toMatch(/^n?\d+\.\d+/)
    expect(status.ffprobeVersion).toBe(status.ffmpegVersion)
    if (tools!.source === 'development') expect(status.license).toBe('LGPL-3.0-or-later')
  })

  it('reports missing binaries with an actionable message', async () => {
    const dir = tempDir()
    dirs.push(dir)
    const loc = resolveMediaTools({
      isPackaged: false,
      appPath: dir.path,
      resourcesPath: '',
      platform: process.platform,
      arch: process.arch,
      env: {}
    })
    const status = await verifyMediaTools(loc)
    expect(status.ok).toBe(false)
    if (status.ok) return
    expect(status.code).toBe('MISSING')
    expect(status.message).toContain('npm run fetch:ffmpeg')
  })

  it('reports binaries that exist but cannot start', async () => {
    const dir = tempDir()
    dirs.push(dir)
    const exe = process.platform === 'win32' ? '.exe' : ''
    mkdirSync(join(dir.path, 'bin'))
    // Not a program at all: spawning it fails.
    for (const name of ['ffmpeg', 'ffprobe']) {
      const path = join(dir.path, 'bin', `${name}${exe}`)
      writeFileSync(path, 'this is not an executable')
      chmodSync(path, 0o755)
    }
    const status = await verifyMediaTools({
      source: 'packaged',
      directory: dir.path,
      ffmpeg: join(dir.path, 'bin', `ffmpeg${exe}`),
      ffprobe: join(dir.path, 'bin', `ffprobe${exe}`)
    })
    expect(status.ok).toBe(false)
    if (status.ok) return
    expect(status.code).toBe('FAILED')
    expect(status.message).toContain('não conseguiu iniciar')
    expect(status.detail).toContain('ffmpeg')
  })

  it.skipIf(!tools)('reports MISSING when only one of the two programs is present', async () => {
    const dir = tempDir()
    dirs.push(dir)
    const exe = process.platform === 'win32' ? '.exe' : ''
    mkdirSync(join(dir.path, 'bin'))
    copyFileSync(tools!.ffprobe, join(dir.path, 'bin', `ffprobe${exe}`))
    const status = await verifyMediaTools({
      source: 'development',
      directory: dir.path,
      ffmpeg: join(dir.path, 'bin', `ffmpeg${exe}`),
      ffprobe: join(dir.path, 'bin', `ffprobe${exe}`)
    })
    expect(status.ok).toBe(false)
    expect(!status.ok && status.code).toBe('MISSING')
  })
})

describe('MediaToolsManager', () => {
  it('refuses media work with the actionable message when FFmpeg is unavailable', async () => {
    const dir = tempDir()
    dirs.push(dir)
    const manager = new MediaToolsManager(
      { source: 'packaged', directory: dir.path, ffmpeg: join(dir.path, 'x'), ffprobe: join(dir.path, 'y') },
      memoryLogger()
    )
    await expect(manager.require()).rejects.toThrow(UnavailableError)
    await expect(manager.require()).rejects.toThrow(/Reinstale a Social Machine/)
  })
})
