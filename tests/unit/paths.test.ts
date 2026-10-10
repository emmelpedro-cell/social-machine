import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  APP_DATA_SUBDIRECTORIES,
  ensureLayout,
  readBootstrap,
  resolveLayout,
  resolveRootDirectory,
  writeBootstrap
} from '../../src/main/paths'
import { tempDir } from '../helpers/node-sqlite-driver'

const dirs: { cleanup: () => void }[] = []
afterEach(() => dirs.splice(0).forEach((d) => d.cleanup()))

describe('paths', () => {
  it('builds the documented folder layout', () => {
    const dir = tempDir()
    dirs.push(dir)
    const layout = resolveLayout(dir.path)
    expect(layout.database).toBe(join(dir.path, 'app-data', 'database.sqlite'))
    expect(layout.defaultExports).toBe(join(dir.path, 'exports'))

    ensureLayout(layout)
    for (const sub of APP_DATA_SUBDIRECTORIES) expect(existsSync(join(dir.path, 'app-data', sub))).toBe(true)
    expect(existsSync(layout.defaultExports)).toBe(true)
  })

  it('resolves the root from env, then bootstrap, then Documents', () => {
    const dir = tempDir()
    dirs.push(dir)
    const bootstrapFile = join(dir.path, 'bootstrap.json')
    const documentsDirectory = join(dir.path, 'Documents')
    const chosen = resolve(dir.path, 'chosen-root')

    expect(resolveRootDirectory({ env: {}, bootstrapFile, documentsDirectory })).toEqual({
      root: join(documentsDirectory, 'SocialMachine'),
      overridden: false
    })

    writeBootstrap(bootstrapFile, { rootDirectory: chosen })
    expect(resolveRootDirectory({ env: {}, bootstrapFile, documentsDirectory })).toEqual({
      root: chosen,
      overridden: false
    })

    const envRoot = resolve(dir.path, 'env-root')
    expect(resolveRootDirectory({ env: { SM_DATA_DIR: envRoot }, bootstrapFile, documentsDirectory })).toEqual({
      root: envRoot,
      overridden: true
    })
  })

  it('ignores a corrupt or relative bootstrap file', () => {
    const dir = tempDir()
    dirs.push(dir)
    const file = join(dir.path, 'bootstrap.json')
    writeFileSync(file, '{not json')
    expect(readBootstrap(file)).toEqual({})
    writeFileSync(file, JSON.stringify({ rootDirectory: 'relative/path' }))
    expect(readBootstrap(file)).toEqual({})
  })
})
