import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../../src/main/logger'
import { tempDir } from '../helpers/node-sqlite-driver'

const dirs: { cleanup: () => void }[] = []
afterEach(() => dirs.splice(0).forEach((d) => d.cleanup()))

function readLines(path: string) {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

describe('logger', () => {
  it('writes JSON lines with level, scope and context', () => {
    const dir = tempDir()
    dirs.push(dir)
    const logger = createLogger({ directory: dir.path, now: () => new Date('2026-10-10T12:00:00.000Z') })
    logger.info('hello', { a: 1 })
    logger.child('db').warn('careful')

    const lines = readLines(join(dir.path, 'app.log'))
    expect(lines).toEqual([
      { time: '2026-10-10T12:00:00.000Z', level: 'info', message: 'hello', context: { a: 1 } },
      { time: '2026-10-10T12:00:00.000Z', level: 'warn', scope: 'db', message: 'careful' }
    ])
  })

  it('respects the minimum level', () => {
    const dir = tempDir()
    dirs.push(dir)
    const logger = createLogger({ directory: dir.path, minLevel: 'warn' })
    logger.debug('no')
    logger.info('no')
    logger.error('yes')
    expect(readLines(logger.filePath).map((l) => l.message)).toEqual(['yes'])
  })

  it('serializes errors, bigints and circular references', () => {
    const dir = tempDir()
    dirs.push(dir)
    const logger = createLogger({ directory: dir.path })
    const circular: Record<string, unknown> = { name: 'loop' }
    circular.self = circular
    logger.error('boom', { error: new Error('bad thing'), big: 10n, circular })

    const [line] = readLines(logger.filePath)
    const context = line!.context as Record<string, any>
    expect(context.error.message).toBe('bad thing')
    expect(context.error.stack).toContain('bad thing')
    expect(context.big).toBe('10')
    expect(context.circular.self).toBe('[Circular]')
  })

  it('rotates when the file grows past maxBytes and keeps maxFiles', () => {
    const dir = tempDir()
    dirs.push(dir)
    const logger = createLogger({ directory: dir.path, maxBytes: 200, maxFiles: 2 })
    for (let i = 0; i < 40; i++) logger.info(`entry ${i} ${'x'.repeat(40)}`)

    const files = readdirSync(dir.path).sort()
    expect(files).toEqual(['app.1.log', 'app.2.log', 'app.log'])
    expect(existsSync(join(dir.path, 'app.3.log'))).toBe(false)
    const last = readLines(logger.filePath).at(-1)
    expect(last?.message).toContain('entry 39')
  })
})
