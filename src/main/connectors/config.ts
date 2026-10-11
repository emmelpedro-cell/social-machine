import type { SqlDriver } from '../db/driver'
import type { SecretStore } from '../secrets/token-store'
import type { OAuthClient } from './youtube/oauth'

type StoredConfig = { clientId: string; secretRef: string | null }

const KEY = 'connector.youtube'

/**
 * OAuth client credentials for YouTube, created by the user in Google Cloud.
 * The client ID is stored in settings; the client secret (not really secret
 * for desktop apps, but treated as one) goes to the encrypted store.
 */
export class YouTubeClientConfig {
  constructor(
    private readonly db: SqlDriver,
    private readonly secrets: SecretStore,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  private stored(): StoredConfig | null {
    const row = this.db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(KEY) as { value_json: string } | undefined
    if (!row) return null
    try {
      const parsed = JSON.parse(row.value_json) as Partial<StoredConfig>
      return typeof parsed.clientId === 'string' ? { clientId: parsed.clientId, secretRef: parsed.secretRef ?? null } : null
    } catch {
      return null
    }
  }

  get(): OAuthClient | null {
    const stored = this.stored()
    if (!stored) return null
    const secret = stored.secretRef ? this.secrets.load<{ clientSecret: string }>(stored.secretRef) : null
    return { clientId: stored.clientId, clientSecret: secret?.clientSecret ?? '' }
  }

  /** The client ID only, for display (never the secret). */
  clientId(): string | null {
    return this.stored()?.clientId ?? null
  }

  set(client: OAuthClient): void {
    const previous = this.stored()
    const secretRef = client.clientSecret ? this.secrets.save({ clientSecret: client.clientSecret }, previous?.secretRef ?? undefined) : null
    if (!client.clientSecret && previous?.secretRef) this.secrets.delete(previous.secretRef)
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      )
      .run(KEY, JSON.stringify({ clientId: client.clientId, secretRef }), this.now())
  }

  clear(): void {
    const previous = this.stored()
    if (previous?.secretRef) this.secrets.delete(previous.secretRef)
    this.db.prepare('DELETE FROM app_settings WHERE key = ?').run(KEY)
  }
}
