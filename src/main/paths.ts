import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/**
 * Folder layout:
 *
 *   <root>/
 *   ├── app-data/  database.sqlite, projects, thumbnails, proxies, versions,
 *   │              presets, temp, logs, backups
 *   └── exports/   default export destination (overridable in Settings)
 *
 * The root is user-configurable. Its location is stored in a small bootstrap
 * file inside Electron's userData folder, because the database itself lives
 * inside the root and can't hold its own location.
 */
export const APP_DATA_SUBDIRECTORIES = [
  'projects',
  'thumbnails',
  'proxies',
  'versions',
  'presets',
  'temp',
  'logs',
  'backups'
] as const

export type AppLayout = {
  root: string
  appData: string
  database: string
  defaultExports: string
} & Record<(typeof APP_DATA_SUBDIRECTORIES)[number], string>

export function resolveLayout(root: string): AppLayout {
  const absoluteRoot = resolve(root)
  const appData = join(absoluteRoot, 'app-data')
  const sub = Object.fromEntries(APP_DATA_SUBDIRECTORIES.map((d) => [d, join(appData, d)])) as Record<
    (typeof APP_DATA_SUBDIRECTORIES)[number],
    string
  >
  return {
    root: absoluteRoot,
    appData,
    database: join(appData, 'database.sqlite'),
    defaultExports: join(absoluteRoot, 'exports'),
    ...sub
  }
}

export function ensureLayout(layout: AppLayout): void {
  mkdirSync(layout.defaultExports, { recursive: true })
  for (const d of APP_DATA_SUBDIRECTORIES) mkdirSync(layout[d], { recursive: true })
}

/* ------------------------------------------------------------------ */
/* Bootstrap file                                                     */
/* ------------------------------------------------------------------ */

export type Bootstrap = { rootDirectory?: string }

export function readBootstrap(file: string): Bootstrap {
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && 'rootDirectory' in parsed) {
      const root = (parsed as { rootDirectory: unknown }).rootDirectory
      if (typeof root === 'string' && isAbsolute(root)) return { rootDirectory: root }
    }
  } catch {
    // A corrupt bootstrap file falls back to the default location.
  }
  return {}
}

/** Atomic write: a crash mid-write can't leave a half-written file. */
export function writeBootstrap(file: string, data: Bootstrap): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, file)
}

/**
 * Root resolution order:
 * 1. SM_DATA_DIR environment variable (tests, portable setups)
 * 2. bootstrap file chosen in Settings
 * 3. <Documents>/SocialMachine
 */
export function resolveRootDirectory(args: {
  env: NodeJS.ProcessEnv
  bootstrapFile: string
  documentsDirectory: string
}): { root: string; overridden: boolean } {
  const fromEnv = args.env.SM_DATA_DIR?.trim()
  if (fromEnv) return { root: resolve(fromEnv), overridden: true }
  const fromBootstrap = readBootstrap(args.bootstrapFile).rootDirectory
  if (fromBootstrap) return { root: fromBootstrap, overridden: false }
  return { root: join(args.documentsDirectory, 'SocialMachine'), overridden: false }
}
