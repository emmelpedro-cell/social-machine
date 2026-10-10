import { randomUUID } from 'node:crypto'
import type { SqlDriver } from '../db/driver'
import { transaction } from '../db/driver'
import { ConflictError, NotFoundError } from '../errors'
import {
  ProjectSettingsSchema,
  type CreateProjectData,
  type Project,
  type ProjectSettings,
  type ProjectSummary,
  type UpdateProjectData
} from '../../shared/schemas'

// Re-exported for existing imports.
export { NotFoundError }

type ProjectRow = {
  id: string
  name: string
  description: string | null
  category: string | null
  color: string
  settings_json: string
  created_at: string
  updated_at: string
}

type SummaryRow = ProjectRow & { content_count: number; needs_review_count: number; ready_count: number }

function parseSettings(json: string): ProjectSettings {
  try {
    const parsed = ProjectSettingsSchema.safeParse(JSON.parse(json))
    if (parsed.success) return parsed.data
  } catch {
    // Unreadable settings fall back to defaults; the row itself stays usable.
  }
  return ProjectSettingsSchema.parse({})
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    color: row.color,
    settings: parseSettings(row.settings_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

const COLUMNS = 'id, name, description, category, color, settings_json, created_at, updated_at'
const DEFAULT_COLOR = '#3d8bfd'

/**
 * Content projects (spec §3): MMA, Futebol, ... Deleting a project never
 * deletes its contents or their files; they become "Sem projeto".
 */
export class ProjectsRepository {
  constructor(
    private readonly db: SqlDriver,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = randomUUID
  ) {}

  list(): ProjectSummary[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.name, p.description, p.category, p.color, p.settings_json, p.created_at, p.updated_at,
           (SELECT COUNT(*) FROM contents c WHERE c.project_id = p.id) AS content_count,
           (SELECT COUNT(*) FROM contents c WHERE c.project_id = p.id AND c.workflow_status = 'needs_review') AS needs_review_count,
           (SELECT COUNT(*) FROM contents c WHERE c.project_id = p.id AND c.workflow_status = 'ready') AS ready_count
         FROM projects p
         WHERE p.archived_at IS NULL
         ORDER BY p.name COLLATE NOCASE`
      )
      .all() as SummaryRow[]
    return rows.map((row) => ({
      ...toProject(row),
      contentCount: Number(row.content_count),
      needsReviewCount: Number(row.needs_review_count),
      readyCount: Number(row.ready_count)
    }))
  }

  get(id: string): Project {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM projects WHERE id = ?`).get(id) as ProjectRow | undefined
    if (!row) throw new NotFoundError('Esse projeto não existe mais. Ele pode ter sido excluído.')
    return toProject(row)
  }

  exists(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id) !== undefined
  }

  create(input: CreateProjectData): Project {
    this.assertNameFree(input.name)
    const id = this.newId()
    const timestamp = this.now()
    this.db
      .prepare(
        `INSERT INTO projects (id, name, description, category, color, settings_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.name,
        input.description ?? null,
        input.category ?? null,
        input.color ?? DEFAULT_COLOR,
        JSON.stringify(ProjectSettingsSchema.parse({})),
        timestamp,
        timestamp
      )
    return this.get(id)
  }

  /** Creates several projects at once; names that already exist are skipped. */
  createMany(inputs: readonly CreateProjectData[]): Project[] {
    return transaction(this.db, () =>
      inputs.filter((input) => !this.nameTaken(input.name)).map((input) => this.create(input))
    )
  }

  update(input: UpdateProjectData): Project {
    return transaction(this.db, () => {
      const current = this.get(input.id)
      if (input.name !== undefined && input.name.toLowerCase() !== current.name.toLowerCase()) {
        this.assertNameFree(input.name)
      }
      this.db
        .prepare(
          `UPDATE projects SET name = ?, description = ?, category = ?, color = ?, settings_json = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          input.name ?? current.name,
          input.description === undefined ? current.description : input.description,
          input.category === undefined ? current.category : input.category,
          input.color ?? current.color,
          JSON.stringify(input.settings ?? current.settings),
          this.now(),
          input.id
        )
      return this.get(input.id)
    })
  }

  /** Deletes the project. Its contents and watch folders stay, without a project. Files are never touched. */
  delete(id: string): void {
    const result = this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    if (Number(result.changes) === 0) {
      throw new NotFoundError('Esse projeto não existe mais. Ele pode ter sido excluído.')
    }
  }

  private nameTaken(name: string): boolean {
    return this.db.prepare('SELECT 1 FROM projects WHERE name = ? COLLATE NOCASE').get(name) !== undefined
  }

  private assertNameFree(name: string): void {
    if (this.nameTaken(name)) throw new ConflictError(`Já existe um projeto chamado “${name}”.`)
  }
}
