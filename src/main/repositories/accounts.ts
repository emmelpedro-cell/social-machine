import { randomUUID } from 'node:crypto'
import type { SqlDriver } from '../db/driver'
import { transaction } from '../db/driver'
import { ConflictError, NotFoundError } from '../errors'
import type { Account, ConnectionStatus, PlatformId } from '../../shared/publishing'

type Row = {
  id: string
  platform_id: PlatformId
  external_account_id: string | null
  display_name: string
  connection_status: ConnectionStatus
  token_ref: string | null
  last_error: string | null
  is_manual: number
  created_at: string
  updated_at: string
}

const COLUMNS =
  'id, platform_id, external_account_id, display_name, connection_status, token_ref, last_error, is_manual, created_at, updated_at'

export type AccountRecord = Account & { tokenRef: string | null }

/** Social accounts. Tokens are never stored here: token_ref points to the encrypted secret store. */
export class AccountsRepository {
  constructor(
    private readonly db: SqlDriver,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = randomUUID
  ) {}

  private projectIds(id: string): string[] {
    return (
      this.db.prepare('SELECT project_id FROM account_projects WHERE account_id = ? ORDER BY project_id').all(id) as {
        project_id: string
      }[]
    ).map((r) => r.project_id)
  }

  private toRecord(row: Row): AccountRecord {
    return {
      id: row.id,
      platformId: row.platform_id,
      externalAccountId: row.external_account_id,
      displayName: row.display_name,
      manual: Number(row.is_manual) === 1,
      connectionStatus: row.connection_status,
      lastError: row.last_error,
      projectIds: this.projectIds(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      tokenRef: row.token_ref
    }
  }

  private static publicView({ tokenRef: _ref, ...account }: AccountRecord): Account {
    return account
  }

  list(): Account[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM accounts ORDER BY platform_id, display_name COLLATE NOCASE`)
      .all() as Row[]
    return rows.map((r) => AccountsRepository.publicView(this.toRecord(r)))
  }

  record(id: string): AccountRecord {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM accounts WHERE id = ?`).get(id) as Row | undefined
    if (!row) throw new NotFoundError('Essa conta não existe mais.')
    return this.toRecord(row)
  }

  get(id: string): Account {
    return AccountsRepository.publicView(this.record(id))
  }

  findByExternal(platformId: PlatformId, externalAccountId: string): AccountRecord | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM accounts WHERE platform_id = ? AND external_account_id = ?`)
      .get(platformId, externalAccountId) as Row | undefined
    return row ? this.toRecord(row) : null
  }

  addManual(input: { platformId: PlatformId; displayName: string; projectIds: string[] }): Account {
    return transaction(this.db, () => {
      const id = this.newId()
      const t = this.now()
      this.db
        .prepare(
          `INSERT INTO accounts (id, platform_id, display_name, connection_status, is_manual, created_at, updated_at)
           VALUES (?, ?, ?, 'connected', 1, ?, ?)`
        )
        .run(id, input.platformId, input.displayName, t, t)
      this.setProjects(id, input.projectIds)
      return this.get(id)
    })
  }

  /**
   * Records a connected account. Connecting the same channel again updates it
   * (new token, same id), so its publication history is kept.
   */
  upsertConnected(input: {
    platformId: PlatformId
    externalAccountId: string
    displayName: string
    tokenRef: string
    projectIds?: string[]
  }): { account: Account; previousTokenRef: string | null } {
    return transaction(this.db, () => {
      const existing = this.findByExternal(input.platformId, input.externalAccountId)
      const t = this.now()
      if (existing) {
        this.db
          .prepare(
            `UPDATE accounts SET display_name = ?, connection_status = 'connected', token_ref = ?, last_error = NULL, updated_at = ?
             WHERE id = ?`
          )
          .run(input.displayName, input.tokenRef, t, existing.id)
        if (input.projectIds?.length) this.setProjects(existing.id, [...new Set([...existing.projectIds, ...input.projectIds])])
        return { account: this.get(existing.id), previousTokenRef: existing.tokenRef }
      }
      const id = this.newId()
      this.db
        .prepare(
          `INSERT INTO accounts (id, platform_id, external_account_id, display_name, connection_status, token_ref, is_manual, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'connected', ?, 0, ?, ?)`
        )
        .run(id, input.platformId, input.externalAccountId, input.displayName, input.tokenRef, t, t)
      this.setProjects(id, input.projectIds ?? [])
      return { account: this.get(id), previousTokenRef: null }
    })
  }

  update(id: string, patch: { displayName?: string; projectIds?: string[] }): Account {
    return transaction(this.db, () => {
      const current = this.record(id)
      if (patch.displayName !== undefined) {
        this.db
          .prepare('UPDATE accounts SET display_name = ?, updated_at = ? WHERE id = ?')
          .run(patch.displayName, this.now(), id)
      }
      if (patch.projectIds !== undefined) this.setProjects(current.id, patch.projectIds)
      return this.get(id)
    })
  }

  setStatus(id: string, status: ConnectionStatus, error: string | null = null): Account {
    this.db
      .prepare('UPDATE accounts SET connection_status = ?, last_error = ?, updated_at = ? WHERE id = ?')
      .run(status, error, this.now(), id)
    return this.get(id)
  }

  /** Disconnects: forgets the token reference, keeps the account and its history. */
  disconnect(id: string): { tokenRef: string | null } {
    const current = this.record(id)
    this.db
      .prepare(`UPDATE accounts SET connection_status = 'disconnected', token_ref = NULL, last_error = NULL, updated_at = ? WHERE id = ?`)
      .run(this.now(), id)
    return { tokenRef: current.tokenRef }
  }

  hasPublications(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM publications WHERE account_id = ? LIMIT 1').get(id) !== undefined
  }

  /** Removes an account that has no publications (history is never deleted). */
  remove(id: string): { tokenRef: string | null } {
    const current = this.record(id)
    if (this.hasPublications(id)) {
      throw new ConflictError('Essa conta tem publicações no histórico e não pode ser removida. Desconecte-a em vez disso.')
    }
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
    return { tokenRef: current.tokenRef }
  }

  private setProjects(id: string, projectIds: string[]): void {
    this.db.prepare('DELETE FROM account_projects WHERE account_id = ?').run(id)
    const insert = this.db.prepare('INSERT INTO account_projects (account_id, project_id) VALUES (?, ?)')
    for (const projectId of new Set(projectIds)) insert.run(id, projectId)
  }
}
