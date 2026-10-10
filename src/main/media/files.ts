import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { open, readdir, rm, stat } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { TEMP_PREFIX } from './operations'

/* ------------------------------------------------------------------ */
/* Path identity                                                      */
/* ------------------------------------------------------------------ */

/** Key used to detect the same file imported twice. Windows paths are case-insensitive. */
export function pathKey(path: string, platform: NodeJS.Platform = process.platform): string {
  const absolute = resolve(path)
  return platform === 'win32' ? absolute.toLowerCase() : absolute
}

/* ------------------------------------------------------------------ */
/* Content fingerprint                                                */
/* ------------------------------------------------------------------ */

const SAMPLE = 1024 * 1024

/**
 * Fast content fingerprint: size plus SHA-256 of three 1 MB samples (start,
 * middle, end). Reading whole multi-gigabyte videos would make import slow;
 * this reliably tells apart different recordings and detects moved copies.
 */
export async function quickFingerprint(path: string): Promise<{ hash: string; size: number }> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const hash = createHash('sha256')
    hash.update(`size:${size};`)
    const offsets = size <= SAMPLE * 3 ? [0] : [0, Math.floor(size / 2 - SAMPLE / 2), size - SAMPLE]
    const length = size <= SAMPLE * 3 ? size : SAMPLE
    const buffer = Buffer.alloc(length)
    for (const offset of offsets) {
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      hash.update(buffer.subarray(0, bytesRead))
    }
    return { hash: `qf1:${hash.digest('hex')}`, size }
  } finally {
    await handle.close()
  }
}

/* ------------------------------------------------------------------ */
/* Folder scanning                                                    */
/* ------------------------------------------------------------------ */

export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'aif', 'aiff', 'wma', 'caf']
export const VIDEO_EXTENSIONS = [
  'mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mts', 'm2ts', 'ts', 'mpg', 'mpeg', 'wmv', '3gp', 'mxf', 'flv'
]
export const MEDIA_EXTENSIONS = new Set([...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS])

export const VIDEO_EXTENSION_SET = new Set(VIDEO_EXTENSIONS)

export function hasMediaExtension(path: string, extensions: ReadonlySet<string> = MEDIA_EXTENSIONS): boolean {
  return extensions.has(extname(path).slice(1).toLowerCase())
}

const SKIPPED_DIRECTORIES = new Set(['$recycle.bin', 'system volume information', 'node_modules', '.git'])

export type ScanResult = {
  files: string[]
  skippedNonMedia: number
  truncated: boolean
  errors: { path: string; message: string }[]
}

/**
 * Expands the user's selection into files to import.
 *
 * - A file the user picked or dropped explicitly is always a candidate; its
 *   real content is checked by FFprobe later, whatever the extension says.
 * - Inside folders, only files with a media extension are considered, so
 *   that importing a project folder doesn't try to probe every document.
 * - Symlinks and hidden/system folders are not followed.
 */
export async function collectImportCandidates(
  paths: readonly string[],
  options: { maxFiles?: number; maxDepth?: number; extensions?: ReadonlySet<string> } = {}
): Promise<ScanResult> {
  const maxFiles = options.maxFiles ?? 10_000
  const maxDepth = options.maxDepth ?? 12
  const result: ScanResult = { files: [], skippedNonMedia: 0, truncated: false, errors: [] }
  const seen = new Set<string>()

  const add = (file: string) => {
    const key = pathKey(file)
    if (seen.has(key)) return
    if (result.files.length >= maxFiles) {
      result.truncated = true
      return
    }
    seen.add(key)
    result.files.push(resolve(file))
  }

  async function walk(directory: string, depth: number): Promise<void> {
    if (result.truncated) return
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      result.errors.push({ path: directory, message: `Não foi possível ler a pasta: ${(error as Error).message}` })
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    for (const entry of entries) {
      if (result.truncated) return
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (depth < maxDepth && !SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) await walk(full, depth + 1)
      } else if (entry.isFile()) {
        if (hasMediaExtension(entry.name, options.extensions)) add(full)
        else result.skippedNonMedia++
      }
    }
  }

  for (const input of paths) {
    let info
    try {
      info = await stat(input)
    } catch {
      result.errors.push({ path: input, message: `“${basename(input)}” não foi encontrado.` })
      continue
    }
    if (info.isDirectory()) await walk(resolve(input), 0)
    else if (info.isFile()) add(input)
    else result.errors.push({ path: input, message: `“${basename(input)}” não é um arquivo comum.` })
  }
  return result
}

/* ------------------------------------------------------------------ */
/* Temp cleanup                                                       */
/* ------------------------------------------------------------------ */

/**
 * Removes leftovers from interrupted runs. Only names with the app's prefix
 * inside the app's own temp folder are touched.
 */
export async function cleanTempDirectory(directory: string): Promise<number> {
  let removed = 0
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch {
    return 0
  }
  for (const name of entries) {
    if (!name.startsWith(TEMP_PREFIX)) continue
    try {
      await rm(join(directory, name), { recursive: true, force: true })
      removed++
    } catch {
      // In use or locked: try again next start.
    }
  }
  return removed
}
