import { beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { runMigrations } from '../../src/main/db/migrations'
import type { SqlDriver } from '../../src/main/db/driver'
import { openDatabase } from '../../src/main/db/open'
import { ConflictError } from '../../src/main/errors'
import { NotFoundError, ProjectsRepository } from '../../src/main/repositories/projects'
import { ContentsRepository } from '../../src/main/repositories/contents'
import { WatchFoldersRepository } from '../../src/main/repositories/watch-folders'
import { CreateProjectInputSchema, SUGGESTED_PROJECTS, UpdateProjectInputSchema } from '../../src/shared/schemas'
import { createNodeSqliteDriver, memoryLogger, tempDir } from '../helpers/node-sqlite-driver'

function clock(start = Date.parse('2026-10-10T10:00:00.000Z')) {
  let t = start
  return () => new Date((t += 1000)).toISOString()
}

const create = (input: Record<string, unknown>) => CreateProjectInputSchema.parse(input)

describe('ProjectsRepository', () => {
  let repo: ProjectsRepository
  let db: SqlDriver

  beforeEach(() => {
    db = createNodeSqliteDriver()
    runMigrations(db)
    repo = new ProjectsRepository(db, clock())
  })

  it('creates and reads a project with default settings', () => {
    const created = repo.create(create({ name: '  MMA  ', category: 'Esporte' }))
    expect(created).toMatchObject({ name: 'MMA', category: 'Esporte', description: null, color: '#3d8bfd' })
    expect(created.settings).toEqual({ defaultHashtags: [], captionTemplate: '' })
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(repo.get(created.id)).toEqual(created)
  })

  it('stores empty optional text as null', () => {
    const created = repo.create(create({ name: 'Skate', description: '   ', category: '' }))
    expect(created.description).toBeNull()
    expect(created.category).toBeNull()
  })

  it('rejects names that are empty, too long, or already used (any case)', () => {
    expect(() => create({ name: '   ' })).toThrow()
    expect(() => create({ name: 'x'.repeat(81) })).toThrow()
    repo.create(create({ name: 'Futebol' }))
    expect(() => repo.create(create({ name: 'futebol' }))).toThrow(ConflictError)
  })

  it('updates fields and settings, keeping what was not changed', () => {
    const p = repo.create(create({ name: 'Basquete', category: 'Esporte' }))
    const updated = repo.update(
      UpdateProjectInputSchema.parse({
        id: p.id,
        color: '#f76b15',
        settings: { defaultHashtags: ['#nba', '#basquete'], captionTemplate: 'Lance do dia' }
      })
    )
    expect(updated).toMatchObject({ name: 'Basquete', category: 'Esporte', color: '#f76b15' })
    expect(updated.settings).toEqual({ defaultHashtags: ['#nba', '#basquete'], captionTemplate: 'Lance do dia' })
    expect(updated.updatedAt > p.updatedAt).toBe(true)

    // Renaming to its own name in another case is allowed; to another project's name is not.
    expect(repo.update(UpdateProjectInputSchema.parse({ id: p.id, name: 'BASQUETE' })).name).toBe('BASQUETE')
    repo.create(create({ name: 'Skate' }))
    expect(() => repo.update(UpdateProjectInputSchema.parse({ id: p.id, name: 'skate' }))).toThrow(ConflictError)
  })

  it('rejects an update with nothing to change', () => {
    expect(() => UpdateProjectInputSchema.parse({ id: '00000000-0000-4000-8000-000000000000' })).toThrow()
  })

  it('lists projects alphabetically with content counts', () => {
    const skate = repo.create(create({ name: 'Skate' }))
    const mma = repo.create(create({ name: 'MMA' }))
    const contents = new ContentsRepository(db)
    const a = contents.insertPending({ path: '/v/a.mp4', pathKey: '/v/a.mp4', size: 1, mtimeMs: 1, projectId: mma.id, origin: 'drop_machine' })!
    contents.insertPending({ path: '/v/b.mp4', pathKey: '/v/b.mp4', size: 1, mtimeMs: 1, projectId: mma.id })
    contents.setWorkflowStatus([a.id], 'ready')

    const list = repo.list()
    expect(list.map((p) => p.name)).toEqual(['MMA', 'Skate'])
    expect(list[0]).toMatchObject({ id: mma.id, contentCount: 2, readyCount: 1, needsReviewCount: 0 })
    expect(list[1]).toMatchObject({ id: skate.id, contentCount: 0 })
  })

  it('creates the suggested projects once, skipping names that exist', () => {
    repo.create(create({ name: 'mma' }))
    const created = repo.createMany(SUGGESTED_PROJECTS.map((p) => create({ ...p })))
    expect(created.map((p) => p.name)).toEqual(['Futebol', 'Basquete', 'Skate'])
    expect(repo.createMany(SUGGESTED_PROJECTS.map((p) => create({ ...p })))).toEqual([])
    expect(repo.list()).toHaveLength(4)
  })

  it('deleting a project keeps its contents and watched folders, without a project', () => {
    const p = repo.create(create({ name: 'MMA' }))
    const contents = new ContentsRepository(db)
    const c = contents.insertPending({ path: '/v/a.mp4', pathKey: '/v/a.mp4', size: 1, mtimeMs: 1, projectId: p.id })!
    const folders = new WatchFoldersRepository(db)
    const f = folders.add({ path: '/out', pathKey: '/out', origin: 'drop_machine', projectId: p.id })

    repo.delete(p.id)
    expect(() => repo.get(p.id)).toThrow(NotFoundError)
    expect(contents.get(c.id).projectId).toBeNull()
    expect(folders.get(f.id).projectId).toBeNull()
    expect(() => repo.delete(p.id)).toThrow(NotFoundError)
  })

  it('persists projects across a database reopen', () => {
    const dir = tempDir()
    try {
      const dataDir = join(dir.path, 'app-data')
      mkdirSync(dataDir, { recursive: true })
      const options = {
        databasePath: join(dataDir, 'database.sqlite'),
        backupsDirectory: join(dataDir, 'backups'),
        createDriver: createNodeSqliteDriver,
        logger: memoryLogger()
      }
      const first = openDatabase(options)
      const created = new ProjectsRepository(first.db).create(create({ name: 'Futebol' }))
      first.db.close()

      const second = openDatabase(options)
      expect(new ProjectsRepository(second.db).get(created.id)).toEqual(created)
      second.db.close()
    } finally {
      dir.cleanup()
    }
  })
})

describe('ContentsRepository', () => {
  let db: SqlDriver
  let contents: ContentsRepository

  beforeEach(() => {
    db = createNodeSqliteDriver()
    runMigrations(db)
    contents = new ContentsRepository(db, clock())
  })

  it('sets workflow status, project and title for one or many contents', () => {
    const projects = new ProjectsRepository(db)
    const futebol = projects.create(create({ name: 'Futebol' }))
    const a = contents.insertPending({ path: '/v/a.mp4', pathKey: '/v/a.mp4', size: 1, mtimeMs: 1 })!
    const b = contents.insertPending({ path: '/v/b.mp4', pathKey: '/v/b.mp4', size: 1, mtimeMs: 1, origin: 'watch_folder' })!
    expect(a.workflowStatus).toBe('imported')
    expect(b.workflowStatus).toBe('needs_review')

    const moved = contents.setProject([a.id, b.id], futebol.id)
    expect(moved.every((c) => c.projectId === futebol.id)).toBe(true)
    contents.setWorkflowStatus([a.id, b.id], 'editing')
    expect(contents.get(b.id).workflowStatus).toBe('editing')
    expect(contents.setTitle(a.id, 'Gol de bicicleta').title).toBe('Gol de bicicleta')
    expect(contents.setTitle(a.id, null).title).toBeNull()
  })

  it('reports library stats', () => {
    const a = contents.insertPending({ path: '/v/a.mp4', pathKey: '/v/a.mp4', size: 1, mtimeMs: 1 })!
    contents.insertPending({ path: '/v/b.mp4', pathKey: '/v/b.mp4', size: 1, mtimeMs: 1, origin: 'drop_machine' })
    contents.markError(a.id, 'bad', 'missing')
    expect(contents.stats()).toMatchObject({
      total: 2,
      byWorkflow: { imported: 1, needs_review: 1, editing: 0, ready: 0, archived: 0 },
      withoutProject: 2,
      errors: 1,
      missing: 1
    })
  })

  it('lists known files by path key for folder watching', () => {
    const a = contents.insertPending({ path: '/v/a.mp4', pathKey: '/v/a.mp4', size: 10, mtimeMs: 5 })!
    const known = contents.knownFiles()
    expect(known.get('/v/a.mp4')).toEqual({ id: a.id, status: 'pending', size: 10, mtimeMs: 5 })
    contents.updateFileStats(a.id, 20, 6)
    expect(contents.knownFiles().get('/v/a.mp4')).toMatchObject({ size: 20, mtimeMs: 6 })
  })
})
