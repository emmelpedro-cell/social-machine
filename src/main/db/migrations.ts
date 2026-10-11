import { createHash } from 'node:crypto'
import { transaction, type SqlDriver } from './driver'

export type Migration = {
  /** Strictly increasing, never reused. */
  version: number
  name: string
  sql: string
}

/**
 * Append-only list. Never edit a migration that has shipped: add a new one.
 * The runner stores a checksum and refuses to start if an applied migration
 * was changed, so accidental edits are caught instead of silently diverging.
 *
 * v1 creates the full data model of the spec (§14) up front, including tables
 * whose features arrive in later phases (publications, metrics, inbox, queue).
 * See TECHNICAL_DECISIONS TD-101 for why this differs from the Music Content
 * Engine, which adds tables per phase.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'core_schema',
    sql: `
      CREATE TABLE app_settings (
        key        TEXT PRIMARY KEY NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Content projects (MMA, Futebol, ...). Each has its own settings, accounts and contents.
      CREATE TABLE projects (
        id                TEXT PRIMARY KEY NOT NULL,
        name              TEXT NOT NULL CHECK (length(trim(name)) > 0),
        description       TEXT,
        category          TEXT,
        color             TEXT NOT NULL DEFAULT '#3d8bfd',
        settings_json     TEXT NOT NULL DEFAULT '{}',
        storage_directory TEXT,
        archived_at       TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_projects_name ON projects (name COLLATE NOCASE);

      -- Social platforms. Capabilities are what the connector really supports for this build.
      CREATE TABLE platforms (
        id                 TEXT PRIMARY KEY NOT NULL,
        name               TEXT NOT NULL,
        capabilities_json  TEXT NOT NULL DEFAULT '[]',
        configuration_json TEXT NOT NULL DEFAULT '{}'
      );
      INSERT INTO platforms (id, name) VALUES ('youtube', 'YouTube'), ('tiktok', 'TikTok'), ('instagram', 'Instagram');

      -- Connected accounts. Tokens are never stored here: token_ref points to the OS-protected secret store.
      CREATE TABLE accounts (
        id                  TEXT PRIMARY KEY NOT NULL,
        platform_id         TEXT NOT NULL REFERENCES platforms (id),
        external_account_id TEXT,
        display_name        TEXT NOT NULL,
        connection_status   TEXT NOT NULL DEFAULT 'disconnected'
                              CHECK (connection_status IN ('disconnected', 'connected', 'expired', 'error')),
        token_ref           TEXT,
        last_error          TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        UNIQUE (platform_id, external_account_id)
      );

      CREATE TABLE account_projects (
        account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        PRIMARY KEY (account_id, project_id)
      );

      -- Folders watched for new videos (e.g. the Drop Machine output folder).
      CREATE TABLE watch_folders (
        id           TEXT PRIMARY KEY NOT NULL,
        path         TEXT NOT NULL,
        path_key     TEXT NOT NULL UNIQUE,
        label        TEXT,
        origin       TEXT NOT NULL DEFAULT 'watch_folder' CHECK (origin IN ('watch_folder', 'drop_machine')),
        project_id   TEXT REFERENCES projects (id) ON DELETE SET NULL,
        enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        last_scan_at TEXT,
        last_error   TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );

      -- One row per source video. Source files are referenced, never copied, moved or deleted.
      -- status: processing state; availability: file present on disk; workflow_status: the user's editorial state.
      CREATE TABLE contents (
        id                      TEXT PRIMARY KEY NOT NULL,
        project_id              TEXT REFERENCES projects (id) ON DELETE SET NULL,
        title                   TEXT,
        origin                  TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'watch_folder', 'drop_machine')),
        watch_folder_id         TEXT REFERENCES watch_folders (id) ON DELETE SET NULL,
        workflow_status         TEXT NOT NULL DEFAULT 'imported'
                                  CHECK (workflow_status IN ('imported', 'needs_review', 'editing', 'ready', 'archived')),
        source_path             TEXT NOT NULL,
        path_key                TEXT NOT NULL UNIQUE,
        file_name               TEXT NOT NULL,
        file_size               INTEGER NOT NULL CHECK (file_size >= 0),
        file_mtime_ms           REAL,
        content_hash            TEXT,
        kind                    TEXT CHECK (kind IS NULL OR kind IN ('audio', 'video')),
        status                  TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'ready', 'error')),
        error_message           TEXT,
        availability            TEXT NOT NULL DEFAULT 'online' CHECK (availability IN ('online', 'missing')),
        duration_seconds        REAL CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
        container               TEXT,
        video_codec             TEXT,
        audio_codec             TEXT,
        width                   INTEGER,
        height                  INTEGER,
        frame_rate              REAL,
        rotation                INTEGER,
        sample_rate             INTEGER,
        channels                INTEGER,
        bit_rate                INTEGER,
        thumbnail_path          TEXT,
        proxy_path              TEXT,
        probe_json              TEXT,
        metadata_json           TEXT NOT NULL DEFAULT '{}',
        imported_at             TEXT NOT NULL,
        updated_at              TEXT NOT NULL,
        availability_checked_at TEXT
      );
      CREATE INDEX idx_contents_content_hash ON contents (content_hash);
      CREATE INDEX idx_contents_status ON contents (status);
      CREATE INDEX idx_contents_imported_at ON contents (imported_at DESC);
      CREATE INDEX idx_contents_project ON contents (project_id);
      CREATE INDEX idx_contents_workflow ON contents (workflow_status);

      -- Edited renditions of a content (Phase 2). The original is never overwritten.
      CREATE TABLE content_versions (
        id                 TEXT PRIMARY KEY NOT NULL,
        content_id         TEXT NOT NULL REFERENCES contents (id) ON DELETE CASCADE,
        version_name       TEXT NOT NULL,
        file_path          TEXT,
        edit_settings_json TEXT NOT NULL DEFAULT '{}',
        duration_seconds   REAL,
        width              INTEGER,
        height             INTEGER,
        aspect_ratio       TEXT,
        status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'rendering', 'ready', 'error')),
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );
      CREATE INDEX idx_content_versions_content ON content_versions (content_id);

      -- One row per destination (Phase 3). idempotency_key prevents publishing the same task twice.
      CREATE TABLE publications (
        id                 TEXT PRIMARY KEY NOT NULL,
        content_id         TEXT NOT NULL REFERENCES contents (id) ON DELETE RESTRICT,
        content_version_id TEXT REFERENCES content_versions (id) ON DELETE RESTRICT,
        account_id         TEXT NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
        title              TEXT,
        caption            TEXT,
        hashtags_json      TEXT NOT NULL DEFAULT '[]',
        fields_json        TEXT NOT NULL DEFAULT '{}',
        scheduled_at       TEXT,
        published_at       TEXT,
        external_post_id   TEXT,
        external_url       TEXT,
        status             TEXT NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft', 'queued', 'scheduled', 'publishing', 'published', 'failed', 'cancelled', 'manual_pending')),
        error_message      TEXT,
        idempotency_key    TEXT NOT NULL UNIQUE,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );
      CREATE INDEX idx_publications_content ON publications (content_id);
      CREATE INDEX idx_publications_account ON publications (account_id);
      CREATE INDEX idx_publications_scheduled ON publications (status, scheduled_at);

      -- Metrics over time (Phase 5). NULL means "not provided by the platform", never zero.
      CREATE TABLE metric_snapshots (
        id                            TEXT PRIMARY KEY NOT NULL,
        publication_id                TEXT NOT NULL REFERENCES publications (id) ON DELETE CASCADE,
        captured_at                   TEXT NOT NULL,
        views                         INTEGER,
        likes                         INTEGER,
        comments                      INTEGER,
        shares                        INTEGER,
        watch_time_seconds            REAL,
        average_view_duration_seconds REAL,
        followers_gained              INTEGER,
        additional_json               TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_metric_snapshots_publication ON metric_snapshots (publication_id, captured_at);

      -- Comments and notifications (Phase 6).
      CREATE TABLE inbox_items (
        id                  TEXT PRIMARY KEY NOT NULL,
        account_id          TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        publication_id      TEXT REFERENCES publications (id) ON DELETE SET NULL,
        external_item_id    TEXT NOT NULL,
        item_type           TEXT NOT NULL,
        text                TEXT,
        author              TEXT,
        external_created_at TEXT,
        received_at         TEXT NOT NULL,
        read_status         TEXT NOT NULL DEFAULT 'unread' CHECK (read_status IN ('unread', 'read')),
        response_status     TEXT NOT NULL DEFAULT 'none' CHECK (response_status IN ('none', 'resolved', 'replied')),
        UNIQUE (account_id, external_item_id)
      );

      -- Planning preferences per account (Phase 4). Frequency is a preference, not a promise of reach.
      CREATE TABLE queue_settings (
        id                   TEXT PRIMARY KEY NOT NULL,
        account_id           TEXT NOT NULL UNIQUE REFERENCES accounts (id) ON DELETE CASCADE,
        preferred_days_json  TEXT NOT NULL DEFAULT '[]',
        preferred_times_json TEXT NOT NULL DEFAULT '[]',
        posts_per_day        REAL,
        timezone             TEXT NOT NULL,
        enabled              INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
      );

      -- Text and framing presets per project (Phase 2).
      CREATE TABLE edit_presets (
        id            TEXT PRIMARY KEY NOT NULL,
        project_id    TEXT REFERENCES projects (id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        settings_json TEXT NOT NULL DEFAULT '{}',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      -- Durable background jobs (render, publish, metrics sync). Resumable after a restart.
      CREATE TABLE tasks (
        id              TEXT PRIMARY KEY NOT NULL,
        task_type       TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
        progress        REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
        retry_count     INTEGER NOT NULL DEFAULT 0,
        payload_json    TEXT NOT NULL DEFAULT '{}',
        idempotency_key TEXT UNIQUE,
        error_message   TEXT,
        run_after       TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX idx_tasks_status ON tasks (status, run_after);
    `
  },
  {
    version: 2,
    name: 'version_rendering',
    sql: `
      -- Phase 2: rendering state and output details of edited versions.
      ALTER TABLE content_versions ADD COLUMN error_message TEXT;
      ALTER TABLE content_versions ADD COLUMN progress REAL NOT NULL DEFAULT 0;
      ALTER TABLE content_versions ADD COLUMN encoder TEXT;
      ALTER TABLE content_versions ADD COLUMN file_size INTEGER;
      ALTER TABLE content_versions ADD COLUMN thumbnail_path TEXT;
      CREATE INDEX idx_content_versions_status ON content_versions (status);
      CREATE INDEX idx_edit_presets_project ON edit_presets (project_id);
    `
  },
  {
    version: 3,
    name: 'publishing',
    sql: `
      -- Phase 3: manual destinations (TikTok/Instagram without API access) are accounts too.
      ALTER TABLE accounts ADD COLUMN is_manual INTEGER NOT NULL DEFAULT 0 CHECK (is_manual IN (0, 1));
      CREATE INDEX idx_publications_created ON publications (created_at DESC);
      CREATE INDEX idx_publications_version ON publications (content_version_id);
    `
  },
  {
    version: 4,
    name: 'metrics',
    sql: `
      -- Phase 5: where a snapshot came from ('api' = platform API, 'manual' = typed in by the user).
      ALTER TABLE metric_snapshots ADD COLUMN source TEXT NOT NULL DEFAULT 'api' CHECK (source IN ('api', 'manual'));
      -- Account-level numbers (followers/subscribers) over time.
      CREATE TABLE account_metric_snapshots (
        id              TEXT PRIMARY KEY NOT NULL,
        account_id      TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        captured_at     TEXT NOT NULL,
        followers       INTEGER,
        total_views     INTEGER,
        video_count     INTEGER,
        additional_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_account_metric_snapshots ON account_metric_snapshots (account_id, captured_at);
      -- Last metrics collection per account, and why it failed (shown in Analytics).
      ALTER TABLE accounts ADD COLUMN metrics_checked_at TEXT;
      ALTER TABLE accounts ADD COLUMN metrics_error TEXT;
    `
  }
]

export class MigrationError extends Error {
  override name = 'MigrationError'
}

type AppliedRow = { version: number; name: string; checksum: string }

export function checksum(migration: Migration): string {
  return createHash('sha256').update(migration.sql.trim()).digest('hex')
}

export function latestVersion(migrations: readonly Migration[] = MIGRATIONS): number {
  return migrations.reduce((max, m) => Math.max(max, m.version), 0)
}

function ensureMigrationsTable(db: SqlDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY NOT NULL,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `)
}

export function getAppliedMigrations(db: SqlDriver): AppliedRow[] {
  ensureMigrationsTable(db)
  return db
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    .all() as AppliedRow[]
}

export function currentSchemaVersion(db: SqlDriver): number {
  const rows = getAppliedMigrations(db)
  return rows.length ? Math.max(...rows.map((r) => Number(r.version))) : 0
}

function validateList(migrations: readonly Migration[]): void {
  let previous = 0
  for (const m of migrations) {
    if (!Number.isInteger(m.version) || m.version <= previous) {
      throw new MigrationError(
        `Migration list is invalid: version ${m.version} (${m.name}) must be an integer greater than ${previous}.`
      )
    }
    previous = m.version
  }
}

/** Returns migrations that still have to run, after verifying the applied ones. */
export function pendingMigrations(
  db: SqlDriver,
  migrations: readonly Migration[] = MIGRATIONS
): Migration[] {
  validateList(migrations)
  const applied = getAppliedMigrations(db)
  const known = new Map(migrations.map((m) => [m.version, m]))
  const latestKnown = latestVersion(migrations)

  for (const row of applied) {
    const version = Number(row.version)
    if (version > latestKnown) {
      throw new MigrationError(
        `The database was created by a newer version of the app (schema v${version}, this build supports up to v${latestKnown}). ` +
          'Update the app, or restore a database backup from the "backups" folder.'
      )
    }
    const migration = known.get(version)
    if (!migration) {
      throw new MigrationError(`Applied migration v${version} (${row.name}) is missing from this build.`)
    }
    if (checksum(migration) !== row.checksum) {
      throw new MigrationError(
        `Migration v${version} (${row.name}) was modified after it was applied. Shipped migrations must never change; add a new migration instead.`
      )
    }
  }

  const appliedVersions = new Set(applied.map((r) => Number(r.version)))
  return migrations.filter((m) => !appliedVersions.has(m.version))
}

/**
 * Applies pending migrations, each in its own transaction, so a failure
 * leaves the database at the last fully applied version.
 */
export function runMigrations(
  db: SqlDriver,
  migrations: readonly Migration[] = MIGRATIONS,
  now: () => string = () => new Date().toISOString()
): { from: number; to: number; applied: number[] } {
  const from = currentSchemaVersion(db)
  const pending = pendingMigrations(db, migrations)
  const applied: number[] = []

  for (const migration of pending) {
    try {
      transaction(db, () => {
        db.exec(migration.sql)
        db.prepare(
          'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)'
        ).run(migration.version, migration.name, checksum(migration), now())
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new MigrationError(
        `Migration v${migration.version} (${migration.name}) failed and was rolled back: ${reason}`
      )
    }
    applied.push(migration.version)
  }

  return { from, to: currentSchemaVersion(db), applied }
}
