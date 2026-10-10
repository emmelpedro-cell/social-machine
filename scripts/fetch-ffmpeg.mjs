#!/usr/bin/env node
/**
 * Downloads the pinned FFmpeg build (scripts/ffmpeg-sources.json), verifies
 * its SHA-256, and installs ffmpeg + ffprobe (+ their shared libraries) into
 *
 *   vendor/ffmpeg/<platform>-<arch>/
 *     bin/        ffmpeg, ffprobe and their DLLs (Windows) — ffplay is not shipped
 *     lib/        shared libraries (Linux only)
 *     LICENSE.txt license shipped by the build (LGPL v3)
 *     COPYING.GPLv3, FFMPEG-LICENSE.md  from scripts/licenses
 *     NOTICE.txt  version, license and corresponding-source information
 *     manifest.json
 *
 * electron-builder copies that folder to <resources>/ffmpeg in the installer.
 *
 * Usage:
 *   node scripts/fetch-ffmpeg.mjs                 current platform; warns instead of failing
 *   node scripts/fetch-ffmpeg.mjs --strict        fail on any problem (CI, packaging)
 *   node scripts/fetch-ffmpeg.mjs --target win32-x64 --strict
 *   node scripts/fetch-ffmpeg.mjs --force         re-install even if up to date
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sources = JSON.parse(readFileSync(join(root, 'scripts', 'ffmpeg-sources.json'), 'utf8'))

const args = process.argv.slice(2)
const strict = args.includes('--strict')
const force = args.includes('--force')
const targetIndex = args.indexOf('--target')
const target = targetIndex >= 0 ? args[targetIndex + 1] : `${process.platform}-${process.arch}`

// Bump when the installed folder layout changes so existing installs are refreshed.
const LAYOUT_VERSION = 1

const vendorDir = join(root, 'vendor', 'ffmpeg')
const cacheDir = join(vendorDir, '.cache')
const destDir = join(vendorDir, target)

function log(message) {
  console.log(`[fetch-ffmpeg] ${message}`)
}

function fail(message) {
  if (strict) {
    console.error(`[fetch-ffmpeg] ERROR: ${message}`)
    process.exit(1)
  }
  console.warn(`[fetch-ffmpeg] WARNING: ${message}`)
  console.warn('[fetch-ffmpeg] The app will start, but media import stays disabled until FFmpeg is installed.')
  console.warn('[fetch-ffmpeg] Retry with: npm run fetch:ffmpeg')
  process.exit(0)
}

async function sha256OfFile(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

async function download(url, outFile, expectedSize) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`)
  const total = Number(response.headers.get('content-length')) || expectedSize
  let received = 0
  let nextReport = 0.1
  const counter = new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength
      if (total && received / total >= nextReport) {
        log(`  ${Math.round((received / total) * 100)}%`)
        nextReport += 0.1
      }
      controller.enqueue(chunk)
    }
  })
  const tmp = `${outFile}.part`
  await pipeline(Readable.fromWeb(response.body.pipeThrough(counter)), createWriteStream(tmp))
  renameSync(tmp, outFile)
}

function extract(archive, into) {
  mkdirSync(into, { recursive: true })
  const isZip = archive.endsWith('.zip')
  // On Windows use the system bsdtar explicitly: it reads zip files, while a GNU tar
  // from Git for Windows that may come first on PATH cannot.
  // Elsewhere, GNU tar handles .tar.xz and unzip handles .zip (cross-platform fetches).
  let command
  let commandArgs
  if (process.platform === 'win32') {
    command = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    commandArgs = [isZip ? '-xf' : '-xJf', archive, '-C', into]
  } else if (isZip) {
    command = 'unzip'
    commandArgs = ['-q', archive, '-d', into]
  } else {
    command = 'tar'
    commandArgs = ['-xJf', archive, '-C', into]
  }
  const result = spawnSync(command, commandArgs, { stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`Extracting ${archive} failed (${result.error?.message ?? `exit code ${result.status}`})`)
  }
}

function writeNotice(dir, spec) {
  const notice = `FFmpeg ${sources.ffmpegVersion} (${sources.describe}) — bundled with Social Machine
==========================================================================

Social Machine runs the unmodified ffmpeg and ffprobe programs from this folder
as separate processes. They are not part of the application's own code.

License
-------
This FFmpeg build is licensed under the GNU Lesser General Public License,
version 3 or later (LGPL-3.0-or-later). It was configured with --enable-version3
and WITHOUT --enable-gpl or --enable-nonfree, so it contains no GPL-only or
non-redistributable components. The full license text is in LICENSE.txt; the
GNU GPL v3, which the LGPL v3 incorporates, is in COPYING.GPLv3. FFmpeg's own
licensing notes are in FFMPEG-LICENSE.md.
The libraries (DLLs / .so files) in this folder can be replaced by the user with
compatible builds of their choice.

Build
-----
Publisher:   ${sources.publisher}
Release:     ${sources.releaseTag}
Archive:     ${spec.asset}
SHA-256:     ${spec.sha256}
Download:    ${sources.baseUrl}/${spec.asset}

Corresponding source
--------------------
FFmpeg source (exact commit): https://github.com/FFmpeg/FFmpeg/tree/${sources.ffmpegCommit}
FFmpeg source archive:        https://github.com/FFmpeg/FFmpeg/archive/${sources.ffmpegCommit}.tar.gz
Build scripts and the exact versions of every bundled third-party library:
                              https://github.com/BtbN/FFmpeg-Builds/tree/${sources.releaseTag}

FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.
https://ffmpeg.org/legal.html
`
  writeFileSync(join(dir, 'NOTICE.txt'), notice)
}

async function main() {
  const spec = sources.targets[target]
  if (!spec) {
    fail(
      `No pinned FFmpeg build for "${target}". Supported targets: ${Object.keys(sources.targets).join(', ')}.`
    )
    return
  }

  const manifestPath = join(destDir, 'manifest.json')
  const exe = target.startsWith('win32') ? '.exe' : ''
  const installed = () =>
    existsSync(join(destDir, 'bin', `ffmpeg${exe}`)) && existsSync(join(destDir, 'bin', `ffprobe${exe}`))

  if (!force && existsSync(manifestPath) && installed()) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.sha256 === spec.sha256 && manifest.layoutVersion === LAYOUT_VERSION) {
      log(`FFmpeg ${manifest.ffmpegVersion} for ${target} is up to date.`)
      return
    }
  }

  mkdirSync(cacheDir, { recursive: true })
  const archive = join(cacheDir, spec.asset)

  if (existsSync(archive) && (await sha256OfFile(archive)) !== spec.sha256) {
    log('Cached archive does not match the pinned checksum; downloading again.')
    rmSync(archive)
  }
  if (!existsSync(archive)) {
    const url = `${sources.baseUrl}/${spec.asset}`
    log(`Downloading ${spec.asset} (${Math.round(spec.size / 1048576)} MB)`)
    try {
      await download(url, archive, spec.size)
    } catch (error) {
      fail(`Download failed: ${error.cause?.message ?? error.message}`)
      return
    }
  }

  const actual = await sha256OfFile(archive)
  if (actual !== spec.sha256) {
    rmSync(archive, { force: true })
    fail(`Checksum mismatch for ${spec.asset}: expected ${spec.sha256}, got ${actual}. The file was deleted.`)
    return
  }
  log('Checksum verified.')

  const work = join(vendorDir, `.extract-${target}`)
  const staging = join(vendorDir, `.staging-${target}`)
  rmSync(work, { recursive: true, force: true })
  rmSync(staging, { recursive: true, force: true })
  try {
    extract(archive, work)
    const top = readdirSync(work).find((n) => statSync(join(work, n)).isDirectory())
    if (!top) throw new Error('Unexpected archive layout: no top-level folder')
    const src = join(work, top)

    mkdirSync(join(staging, 'bin'), { recursive: true })
    for (const name of readdirSync(join(src, 'bin'))) {
      // ffplay is a media player we don't use; leave it out of the installer.
      if (/^ffplay(\.exe)?$/i.test(name)) continue
      copyFileSync(join(src, 'bin', name), join(staging, 'bin', name))
    }
    // On Windows the DLLs live next to the executables in bin/; lib/ only holds import libraries.
    if (!target.startsWith('win32') && existsSync(join(src, 'lib'))) {
      // Linux shared libraries and their version symlinks. Headers, pkg-config files
      // and import libraries are development files and are not needed at runtime.
      cpSync(join(src, 'lib'), join(staging, 'lib'), {
        recursive: true,
        verbatimSymlinks: true,
        filter: (from) => !/\.(a|pc|def|lib)$/i.test(from) && !from.includes('pkgconfig')
      })
    }
    copyFileSync(join(src, 'LICENSE.txt'), join(staging, 'LICENSE.txt'))
    // LGPL v3 incorporates the GPL v3; §4(b) requires both texts to accompany the program.
    copyFileSync(join(root, 'scripts', 'licenses', 'COPYING.GPLv3'), join(staging, 'COPYING.GPLv3'))
    copyFileSync(join(root, 'scripts', 'licenses', 'FFMPEG-LICENSE.md'), join(staging, 'FFMPEG-LICENSE.md'))
    writeNotice(staging, spec)
    writeFileSync(
      join(staging, 'manifest.json'),
      JSON.stringify(
        {
          ffmpegVersion: sources.ffmpegVersion,
          describe: sources.describe,
          license: sources.license,
          variant: sources.variant,
          publisher: sources.publisher,
          releaseTag: sources.releaseTag,
          asset: spec.asset,
          sha256: spec.sha256,
          target,
          layoutVersion: LAYOUT_VERSION,
          installedAt: new Date().toISOString()
        },
        null,
        2
      ) + '\n'
    )

    rmSync(destDir, { recursive: true, force: true })
    renameSync(staging, destDir)
    log(`Installed FFmpeg ${sources.ffmpegVersion} (${sources.license}) into vendor/ffmpeg/${target}`)
  } catch (error) {
    fail(error.message)
  } finally {
    rmSync(work, { recursive: true, force: true })
    rmSync(staging, { recursive: true, force: true })
  }
}

await main()
