import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { SqlDriver } from '../db/driver'
import { transaction } from '../db/driver'
import { ConflictError, NotFoundError } from '../errors'
import type { WatchFolder, WatchOrigin } from '../../shared/watch'

type Row = {
  id: string
  path: string
  path_key: string
  label: string | null
  origin: WatchOrigin
  project_id: string | null
  enabled: number
  last_scan_at: string | null
  last_error: string | null
  created_at: string
}

const COLUMNS = 'id, path, path_key, label, origin, project_id, enabled, last_scan_at, last_error, created_at'

function toFolder(row: Row): WatchFolder {
  return {
    id: row.id,
    path: row.path,
    label: row.label,
    origin: row.origin,
    projectId: row.project_id,
    enabled: Number(row.enabled) === 1,
    lastScanAt: row.last_scan_at,
    lastError: row.last_error,
    createdAt: row.created_at
  }
}

export type WatchFolderRecord = WatchFolder & { pathKey: string }

/** Folders watched for new videos. Only the folder reference is stored; nothing inside it is ever modified. */
export class WatchFoldersRepository {
  constructor(
    private readonly db: SqlDriver,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = randomUUID
  ) {}

  list(): WatchFolderRecord[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM watch_folders ORDER BY created_at`).all() as Row[]
    return rows.map((r) => ({ ...toFolder(r), pathKey: r.path_key }))
  }

  get(id: string): WatchFolderRecord {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM watch_folders WHERE id = ?`).get(id) as Row | undefined
    if (!row) throw new NotFoundError('Essa pasta monitorada não existe mais.')
    return { ...toFolder(row), pathKey: row.path_key }
  }

  add(input: { path: string; pathKey: string; origin: WatchOrigin; projectId: string | null }): WatchFolderRecord {
    const existing = this.db.prepare('SELECT id FROM watch_folders WHERE path_key = ?').get(input.pathKey)
    if (existing) throw new ConflictError(`A pasta “${basename(input.path)}” já está sendo monitorada.`)
    const id = this.newId()
    const t = this.now()
    this.db
      .prepare(
        `INSERT INTO watch_folders (id, path, path_key, label, origin, project_id, enabled, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?, 1, ?, ?)`
      )
      .run(id, input.path, input.pathKey, input.origin, input.projectId, t, t)
    return this.get(id)
  }

  update(
    id: string,
    patch: { label?: string | null; origin?: WatchOrigin; projectId?: string | null; enabled?: boolean }
  ): WatchFolderRecord {
    return transaction(this.db, () => {
      const current = this.get(id)
      this.db
        .prepare('UPDATE watch_folders SET label = ?, origin = ?, project_id = ?, enabled = ?, updated_at = ? WHERE id = ?')
        .run(
          patch.label === undefined ? current.label : patch.label,
          patch.origin ?? current.origin,
          patch.projectId === undefined ? current.projectId : patch.projectId,
          (patch.enabled ?? current.enabled) ? 1 : 0,
          this.now(),
          id
        )
      return this.get(id)
    })
  }

  recordScan(id: string, error: string | null): void {
    this.db
      .prepare('UPDATE watch_folders SET last_scan_at = ?, last_error = ?, updated_at = ? WHERE id = ?')
      .run(this.now(), error, this.now(), id)
  }

  /** Stops watching. Contents already imported from the folder stay in the library. */
  remove(id: string): void {
    const result = this.db.prepare('DELETE FROM watch_folders WHERE id = ?').run(id)
    if (Number(result.changes) === 0) throw new NotFoundError('Essa pasta monitorada não existe mais.')
  }
}
