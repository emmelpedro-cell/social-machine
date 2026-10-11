import { randomUUID } from 'node:crypto'
import type { SqlDriver } from '../db/driver'
import { NotFoundError } from '../errors'
import { PresetSettingsSchema, type EditPreset, type PresetSettings } from '../../shared/editor'

type Row = {
  id: string
  project_id: string | null
  name: string
  settings_json: string
  created_at: string
  updated_at: string
}

const COLUMNS = 'id, project_id, name, settings_json, created_at, updated_at'

function toPreset(row: Row): EditPreset | null {
  try {
    const parsed = PresetSettingsSchema.safeParse(JSON.parse(row.settings_json))
    if (!parsed.success) return null
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      settings: parsed.data,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  } catch {
    return null
  }
}

/** Editing presets (framing, output format and text styles), per project or global. */
export class PresetsRepository {
  constructor(
    private readonly db: SqlDriver,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = randomUUID
  ) {}

  /** Presets of a project plus global ones (project_id NULL). Unreadable rows are skipped. */
  list(projectId: string | null): EditPreset[] {
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM edit_presets WHERE project_id IS NULL OR project_id = ?
         ORDER BY project_id IS NULL, name COLLATE NOCASE`
      )
      .all(projectId) as Row[]
    return rows.map(toPreset).filter((p): p is EditPreset => p !== null)
  }

  get(id: string): EditPreset {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM edit_presets WHERE id = ?`).get(id) as Row | undefined
    const preset = row ? toPreset(row) : null
    if (!preset) throw new NotFoundError('Esse preset não existe mais.')
    return preset
  }

  /** Saves a preset; a preset with the same name in the same scope is replaced. */
  save(input: { projectId: string | null; name: string; settings: PresetSettings }): EditPreset {
    const t = this.now()
    const existing = this.db
      .prepare(`SELECT id FROM edit_presets WHERE name = ? COLLATE NOCASE AND project_id IS ?`)
      .get(input.name, input.projectId) as { id: string } | undefined
    if (existing) {
      this.db
        .prepare('UPDATE edit_presets SET name = ?, settings_json = ?, updated_at = ? WHERE id = ?')
        .run(input.name, JSON.stringify(input.settings), t, existing.id)
      return this.get(existing.id)
    }
    const id = this.newId()
    this.db
      .prepare(
        `INSERT INTO edit_presets (id, project_id, name, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.projectId, input.name, JSON.stringify(input.settings), t, t)
    return this.get(id)
  }

  delete(id: string): void {
    const result = this.db.prepare('DELETE FROM edit_presets WHERE id = ?').run(id)
    if (Number(result.changes) === 0) throw new NotFoundError('Esse preset não existe mais.')
  }
}
