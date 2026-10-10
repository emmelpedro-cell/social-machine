# Technical decisions

Each entry: the decision, the alternatives, and why.

TD-001 to TD-020 come from the Music Content Engine, whose Phase 1 code is the base of this app (TD-101). They still apply unless a TD-1xx entry below replaces them; entries that no longer apply are marked.

## Social Machine decisions

### TD-101 — Start from the Music Content Engine's Phase 1, as a copy

**Decision:** the Social Machine began as a copy of the Music Content Engine (MCE) at its accepted Phase 1 (commit 18a2302): SQLite driver and migrations, logger, validated IPC, renderer isolation, bundled LGPL FFmpeg, import queue with fingerprinting, `sm-media://` preview protocol, tests and Windows CI. Names were changed (`MCE_*` → `SM_*`, `window.mce` → `window.sm`, `mce-media:` → `sm-media:`), songs became content projects and media assets became contents.
**Alternatives:** a shared `core` package used by both apps; starting from scratch; extending the Drop Machine.
**Why:** the MCE's Phase 1 already solved, and verified on Windows CI, most of what this app's Phase 1 needs. A shared package now would couple two apps that are both changing quickly (every MCE change could break the Social Machine and vice versa). Starting from scratch would rebuild the same thing with less testing. The Drop Machine is a different shape (Express API + Vite web UI + JSON file), so it is integrated through its output folder instead (TD-104).
**Revisit:** once both apps are stable, extract the identical parts (db, ipc, media/binaries, probe, run-process, logger) into a shared package.

### TD-102 — The full data model in schema v1

**Decision:** migration v1 creates every entity from the spec's data model (§14): projects, platforms (seeded YouTube/TikTok/Instagram), accounts, account↔project, watch folders, contents, content versions, publications, metric snapshots, inbox items, queue settings, edit presets and tasks. Only projects, contents, watch folders and settings have code in Phase 1. This replaces TD-003's "no table before the code that maintains it" for this app; migrations stay append-only, checksummed and backed up (TD-003).
**Why:** the user asked for a model that won't need rework when publishing and analytics arrive. Writing the relationships down now (publication per destination with its own status, `idempotency_key UNIQUE`, metrics as time series with NULL meaning "not provided", tokens never in the database) makes later phases additive. Later changes to these tables still go through new migrations.
**Details:**
- `accounts.token_ref` points to an OS-protected secret (Electron `safeStorage` / Windows Credential Manager, Phase 3); no token or secret column exists.
- `publications.content_id` and `account_id` are `ON DELETE RESTRICT`: publication history can't silently disappear.
- Deleting a project sets `contents.project_id` and `watch_folders.project_id` to NULL; contents are never deleted with a project.

### TD-103 — Three independent states per content

**Decision:** `status` (processing: pending → processing → ready | error), `availability` (online | missing) and `workflow_status` (imported, needs_review, editing, ready, archived) are separate columns. Manual imports start as `imported`; contents from a watched folder start as `needs_review`. Per-destination publication states live in `publications.status`, not on the content.
**Why:** spec §6 lists these as one list, but they change for different reasons: a file can be missing while its editorial state is "ready", and a content can be published on TikTok and pending on YouTube.

### TD-104 — Folder watching: events + periodic rescan + reconciliation, with a stability check

**Decision:** `WatchService` (main process) watches each folder with recursive `fs.watch`, rescans every folder periodically (setting, default 60 s) and on start, and imports a file only after its size and mtime were unchanged for two consecutive checks 2 s apart and it can be opened for reading. Hidden files, Office lock files and temporary suffixes (`.part`, `.tmp`, `.crdownload`…) are ignored; only video extensions are considered. Files are handed to the same `ImportService` as manual imports, with the folder's project, origin and id.
**Alternatives:** chokidar; events only; polling only.
**Why:**
- Events alone miss files (network drives, buffer overflows, events while the app was closed). The periodic rescan and the start-up reconciliation make a missed event a delay, never a lost file; the tests cover a watcher that never fires and one that fails.
- Native recursive `fs.watch` works on Windows (ReadDirectoryChangesW) without a dependency; chokidar adds little given the rescan safety net.
- The stability check prevents importing renders that are still being written. The import pipeline still validates content with FFprobe and a decode test (TD-014); a file that fails because it was incomplete is retried by the watcher as soon as it changes again.
- Deduplication is by path and by content fingerprint (TD-015). A file the importer dropped as a duplicate is remembered (path, size, mtime) so it isn't handed over on every scan.
- A renamed or moved file whose content matches a library item whose original file is gone relinks that item (keeping id, project and status) instead of being skipped as a duplicate.
**Known limitation:** the "already handed over" memory is in-memory; after a restart, a duplicate copy left in a watched folder is checked once more (and dropped again), and a clip removed from the library while its file is still in a watched folder is imported again. A persistent ignore list can be added if that is a problem in practice.

### TD-105 — Background running: tray in the main process, no Windows service

**Decision:** single instance (`requestSingleInstanceLock`); closing the window hides it to the notification area while the main process keeps watching; "Quit" in the tray menu exits. Optional "start with Windows" uses `app.setLoginItemSettings` with `--hidden`, starting in the tray without a window. If the tray can't be created, closing the window quits. `SM_DISABLE_TRAY=1` turns the tray off.
**Alternatives:** a separate Windows service or helper process that watches folders while the app is closed.
**Why:** watching only matters when something is produced, and the Drop Machine runs on the same machine in the same session. A service would need its own installer elevation, inter-process locking of the SQLite database and an update story, for little gain: the start-up reconciliation already catches everything created while the app was closed. Revisit for scheduled publishing (Phase 4), which needs a reliable timer.

### TD-106 — Videos only

**Decision:** the library accepts only files with a decodable video stream. Folder scans consider only video extensions; explicitly chosen files are probed and rejected with a clear message if they are audio-only (cover art doesn't count) or a still image.
**Why:** every downstream feature (editor, publishing) is about video. Rejecting at import keeps the library clean.

### TD-107 — Portuguese UI

**Decision:** the interface and user-facing error messages are in Brazilian Portuguese. Code, logs and technical documents stay in English.
**Why:** the user works in Portuguese; logs and code are read by developers and tools.

## Inherited decisions (Music Content Engine)

## TD-001 — electron-vite as the build tool

**Decision:** electron-vite 4 (Vite 7 under the hood) builds main, preload and renderer.
**Alternatives:** hand-rolled Vite + tsc + concurrently; Electron Forge with the Vite plugin.
**Why:** one config for the three Electron targets, dev-server URL injection and hot reload out of the box, and it stays plain Vite for the renderer. Forge adds packaging opinions we don't need yet; electron-builder handles packaging.

## TD-002 — better-sqlite3 behind a small driver interface

**Decision:** production uses `better-sqlite3`. All database code depends on a four-method `SqlDriver` interface (`exec`, `prepare`, `close`, plus a shared `transaction` helper). Unit tests run the same code on Node's built-in `node:sqlite`.
**Alternatives:** `node:sqlite` in production; `sqlite3` (async); an ORM (Drizzle, Prisma).
**Why:**
- better-sqlite3 is synchronous, fast and well proven in Electron, with prebuilt binaries per Electron version.
- After `npm install`, better-sqlite3 is rebuilt for Electron's ABI, so plain-Node test runners can't load it. Running tests on `node:sqlite` avoids the classic "compiled against a different Node.js version" problem without maintaining two builds.
- `node:sqlite` is still flagged experimental and its availability inside Electron's Node is not guaranteed, so it isn't used in production yet. Revisit once it is stable.
- Only positional `?` parameters are used, because the two drivers handle named parameters differently.
- No ORM: the schema is small and explicit SQL migrations are easier to audit.

## TD-003 — Migrations: append-only, checksummed, one transaction each, backup first

**Decision:** migrations are a TypeScript array of SQL strings with strictly increasing versions. Each runs in its own transaction and is recorded in `schema_migrations` with a SHA-256 checksum. Before migrating an existing database, a consistent copy is written to `app-data/backups/` with `VACUUM INTO` (last 10 kept).
**Why:** spec requires recoverable migrations. A failed migration rolls back and leaves the previous version intact; editing a shipped migration is detected at startup instead of silently diverging; opening a database from a newer build is refused with a clear message. `VACUUM INTO` gives a valid single-file copy even in WAL mode, unlike copying the file.
**Scope (MCE):** tables were added per phase. _The Social Machine creates its full model in v1 instead (TD-102)._

## TD-004 — A "project" is a song

_Not applicable to the Social Machine:_ projects are content projects (`projects` table); see TD-101/TD-102.

## TD-005 — IPC: one validated handler table, result envelope

**Decision:** every channel is declared in `shared/channels.ts` and implemented in a single handler table (`main/ipc/handlers.ts`). Each handler has a zod schema; input is parsed before any code runs, including channels that take no input. Handlers return `{ ok: true, data } | { ok: false, error: { code, message } }`. Unexpected errors are logged in full and returned to the renderer as a generic message.
**Why:** Electron strips error details across `invoke`, so typed results give the UI actionable messages. A single table makes it testable without Electron and ensures every channel has validation (a test checks that each declared channel has a handler).
Additionally, every call checks `event.senderFrame.url` against the app's own page (dev server origin or the bundled `index.html`).

## TD-006 — Renderer isolation

**Decision:** `contextIsolation`, `sandbox`, no `nodeIntegration`, strict CSP, popups denied (http(s) links open in the system browser), navigation blocked, all permission requests denied. The preload exposes only named functions on `window.sm`, never `ipcRenderer`.
**Why:** spec §21 rules 10–12. Because the preload runs sandboxed, it cannot `require()` packages; it imports only constants and types, and the build bundles it.

## TD-007 — Data folder location via a bootstrap file

**Decision:** default root `Documents\SocialMachine`; a user-chosen root is stored in `userData/bootstrap.json` (atomic write); `SM_DATA_DIR` overrides both. Changing it applies after restart and does not move data.
**Why:** the database lives inside the root, so it can't store its own location. Not moving data automatically avoids a risky multi-gigabyte copy before there's a proper progress/recovery UI for it.

## TD-008 — Settings as validated key/value rows

**Decision:** `app_settings(key, value_json)`; each key validated with zod on read, falling back to its default (and logging) when invalid; unknown keys ignored. Directory settings can only be changed through native folder dialogs in main, not set to arbitrary strings from the renderer.
**Why:** one corrupt value must never stop the app from starting; newer builds can add keys without a migration; the renderer can't point the app at arbitrary paths.

## TD-009 — Logging: synchronous JSON lines with rotation

**Decision:** small in-house logger, `app-data/logs/app.log`, JSON per line, 5 MB rotation, 3 files kept; errors serialized with stack; renderer errors and unhandled rejections forwarded through a validated IPC channel.
**Alternatives:** electron-log, pino.
**Why:** the volume is low, synchronous writes guarantee the last line before a crash is on disk, and it is ~100 lines with no dependency. Revisit if render workers need high-volume logging.

## TD-010 — Styling with plain CSS and design tokens

**Decision:** one stylesheet with CSS custom properties; the accent color is a user setting applied as `--accent`. No Tailwind or component library yet.
**Alternatives:** Tailwind + shadcn/ui (spec's first suggestion), CSS Modules.
**Why:** Phase 0 has a handful of screens; adding Tailwind and shadcn now means more dependencies and build config before there is UI that benefits. Revisit at Phase 3–4 when the timeline and draft grid need many interactive components (Radix primitives via shadcn are the likely choice for dialogs, menus and sliders).

## TD-011 — Tests

**Decision:** Vitest for unit tests (Node environment, `node:sqlite`), Playwright's Electron support for E2E against the built app with an isolated `SM_DATA_DIR`.
**Why:** spec §3. E2E covers the Phase 0 acceptance criterion directly (create → restart → still there) and asserts the renderer has no Node access.

## TD-012 — Bundle a pinned LGPL FFmpeg build (BtbN 9.0.2, shared)

**Decision:** ship FFmpeg 9.0.2 from BtbN/FFmpeg-Builds, variant `lgpl-shared`, pinned to a month-end release by URL and SHA-256 (`scripts/ffmpeg-sources.json`). `scripts/fetch-ffmpeg.mjs` downloads and verifies it into `vendor/ffmpeg/<platform>-<arch>` (on `npm install` and before packaging); electron-builder copies it to `resources/ffmpeg`. Details and license obligations: `docs/FFMPEG.md`.
**Alternatives:** `ffmpeg-static`/`ffprobe-static` (GPL, mismatched versions); gyan.dev builds (GPL v3); a user-installed FFmpeg (spec requires bundling; unknown version); a GPL build with libx264.
**Why:**
- LGPL keeps the app's own licensing free: FFmpeg runs as separate, replaceable programs and libraries, and the obligations are notices plus corresponding source (documented, with the texts shipped).
- Shared libraries: one set of DLLs for both programs (the archive is 77 MB, against 171 MB for the static variant that embeds every library in each executable), and they are user-replaceable as the LGPL intends.
- Pinning by checksum makes builds reproducible and tamper-evident; the CI cache stores the archive and the checksum is re-verified after restore.
**Consequence for later phases:** no libx264. H.264 export (Phase 3) will use OpenH264 (BSD) or a hardware encoder; OpenH264 output quality per bitrate is lower than x264's. If that turns out to matter, the options are a GPL build (then the whole distribution must comply with the GPL) or another encoder. To be measured in Phase 3, not assumed.

## TD-013 — Media processing in the main process, as child processes, behind one service

**Decision:** `ImportService` (main process) owns importing: it scans selections, records assets in SQLite, and runs FFprobe/FFmpeg with `runProcess` (async `spawn`, argument arrays, no shell, timeouts, kill on abort). React components only call IPC and render state pushed back over `media:event`.
**Alternatives:** a Node worker thread or utility process; a separate job runner process.
**Why:** all heavy work already happens in FFmpeg child processes, so the main process only awaits them and never blocks. A worker would add a second state owner without moving real CPU work off the main thread. Revisit for Phase 2 audio analysis, which may compute in JavaScript.

## TD-014 — Validate content, not extensions

**Decision:** an import passes three checks: (1) FFprobe reads the container and streams; (2) `interpretProbe` rejects still images, files without audio/video, undecodable codecs and files without a duration, and treats cover art as audio; (3) FFmpeg decodes the first 3 seconds of the main stream. Extensions only decide which files inside a folder are considered at all; files the user picks or drops explicitly are always probed.
**Why:** spec Phase 1. Renamed text files, half-copied videos and images with video extensions are caught with a specific message instead of failing later during editing.

## TD-015 — Duplicate detection and file identity

**Decision:** the same path (case-insensitive on Windows) is never imported twice (`UNIQUE path_key`). The same content at a different path is detected with a quick fingerprint: SHA-256 over the size and three 1 MB samples (start, middle, end), and the new entry is dropped with a notice. The fingerprint also verifies relinks.
**Alternatives:** full-file hashing (minutes for large camera files), or size + name only (false matches).
**Why:** fast on multi-gigabyte files and reliable for telling recordings apart. Not a cryptographic identity: two files differing only outside the sampled regions would match, which is acceptable for this purpose.

## TD-016 — Asset model, missing files and relinking

**Decision:** `media_assets` stores a reference to the original file, metadata, processing status (`pending → processing → ready | error`) and availability (`online | missing`) separately. Availability is checked at startup, when the window regains focus (throttled) and when the library opens. Missing assets keep their metadata and thumbnail. Relinking takes a single file (confirmed by fingerprint; a different file needs explicit confirmation and is re-analysed) or a folder (matched by name and size, then fingerprint). (MCE only: a song's audio pointed at a library asset; not applicable here.)
**Why:** spec requires preserving references and never moving or deleting source media. Splitting status from availability means a moved file doesn't lose its analysis.

## TD-017 — Persistent queue with recovery

**Decision:** queue state is the `status` column. On start, `processing` rows go back to `pending` and every `pending` row is queued; leftover temp files (only names with the `sm-` prefix, only in `app-data/temp`) are deleted. Two files are analysed at a time. Cancelling removes the entry and any thumbnail; quitting stops FFmpeg and leaves work for the next start. If FFmpeg becomes unavailable, items stay pending and resume after a successful "Check again".
**Why:** spec §4 reliability: interruptible, recoverable, no orphaned processes or temp files.

## TD-018 — Preview through a custom protocol

**Decision:** `sm-media://asset/<id>` streams the original file with HTTP range support (seeking); `sm-media://thumb/<id>` serves thumbnails. Only ids present in the database resolve, thumbnails only from the thumbnails folder. CSP allows `sm-media:` for `img-src` and `media-src` only.
**Alternatives:** `file://` URLs (would require relaxing `webSecurity` and expose arbitrary paths); `net.fetch` of `file://` inside the handler (range handling not reliable for seeking).
**Why:** the renderer can preview library media without ever handling a file path. No proxies are generated: Chromium plays H.264/VP9/AV1/AAC/MP3/FLAC/WAV directly; other codecs (e.g. ProRes, HEVC on some machines) show a clear "can't preview, imported correctly" message. Proxies arrive with the timeline (Phase 4) only if needed.

## TD-019 — Drag-and-drop without trusting renderer paths

**Decision:** the preload derives paths with `webUtils.getPathForFile` from the dropped `File` objects and sends those to main; the renderer never supplies path strings. Main validates the list (count, length) and stats every path.
**Why:** since Electron 32 `File.path` is gone; and this keeps a compromised renderer from asking main to read arbitrary files.

## TD-020 — Separate tsconfig for E2E tests; real FFmpeg in unit tests

**Decision:** `tsconfig.e2e.json` adds DOM types for Playwright `page.evaluate` callbacks. Unit tests that touch media use the real pinned FFmpeg and generate their fixtures with it (`tests/helpers/media.ts`); without FFmpeg they skip locally but fail in CI.
**Why:** media handling is only meaningful against the real tools; generated fixtures avoid committing binary media.

## Open decisions

- **H.264 export encoder** (Phase 2, editor): OpenH264 vs. hardware encoders vs. a GPL build with libx264 (see TD-012). Short-form platforms re-encode uploads, but quality per bitrate still matters; measure before deciding.
- **Token storage** (Phase 3): Electron `safeStorage` (DPAPI on Windows) in a file next to the database vs. Windows Credential Manager (keytar is unmaintained).
- **Platform APIs** (before Phase 3): verify current YouTube Data API quota and audit rules, TikTok Content Posting API audit requirements (unaudited clients may only post privately), and Instagram Graph API account requirements against the official documentation at that time.
- **Scheduler** (Phase 4): in-process timer with the `tasks` table vs. a helper process; how missed schedules are handled after the computer was off.
- **Shared core with the MCE** (TD-101): when both apps are stable.
