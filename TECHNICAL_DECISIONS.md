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

### TD-108 — Text is drawn by the editor, exported as images (WYSIWYG)

**Decision:** text overlays are drawn with Canvas 2D by one function (`renderer/src/editor/textRender.ts`). The preview calls it on a canvas over the video; on export it draws each text alone on a transparent canvas at the output size, and the PNGs are sent to the main process, validated (PNG signature, exact output size, size limit) and overlaid by FFmpeg, enabled during the text's time range.
**Alternatives:** FFmpeg `drawtext` (available, via libfreetype) or ASS subtitles via libass (not in the LGPL build).
**Why:** the preview and the file use the same font rasterizer, wrapping, outline and shadow code, so they can't drift apart; `drawtext` would need its own font files, line wrapping and outline logic re-implemented in filter syntax, and would still not match Chromium's rendering. The images are stored per version (`app-data/versions/<id>/`) so a failed render can be retried without the editor.
**Limits:** text is static during its time range (no per-word animation yet; spec lists word highlighting as future work, which fits this approach as image sequences or per-word images).

### TD-109 — H.264 encoder: hardware when it works, OpenH264 otherwise

**Decision:** on first export the app test-encodes a few frames with, in order, NVENC, Quick Sync, AMF, Media Foundation and OpenH264, and uses the first that works (cached). If a hardware encoder fails on a real render, that render is retried once with OpenH264. Settings → "Codificador de vídeo" can force OpenH264. Bitrate scales with pixel rate: about 10 Mbit/s for 1080×1920 at 30 fps (2–20 Mbit/s bounds). Audio is AAC 192 kbit/s stereo.
**Why:** this resolves TD-012's open question without switching to a GPL build: hardware encoders give good quality per bitrate and speed where present; OpenH264 is always available in the LGPL build and, at these bitrates, adequate for short-form platforms, which re-encode uploads anyway. Listing an encoder doesn't mean it works (no GPU, old driver), hence the test encode.

### TD-110 — Versions: export folder per project, atomic output, verified

**Decision:** a version is written to `<export folder>/<project or "Sem projeto">/<title> - <version name>.mp4` (Windows-safe names, never overwriting: " (2)" etc.). FFmpeg writes `….mp4.part`; the result is checked with FFprobe (readable, exact size, duration within 5 %) before it is renamed and marked ready, and a thumbnail is made. Renders run one at a time; cancelling removes the unfinished version; a render interrupted by quitting is marked failed with "Tentar de novo". Deleting a version keeps its file unless the user chooses "Excluir versão e arquivo"; a version used by a publication (Phase 3) can't be deleted. Making a version moves a content from "Importado"/"Precisa de revisão" to "Em edição".
**Why:** exported files are what the user uploads, so they belong in a visible folder, organised by project. The `.part` name keeps half-written files from looking finished (and from being imported if someone watches the export folder: `.part` is ignored by TD-104).

### TD-111 — Bundled editor fonts

**Decision:** Montserrat, Oswald (variable), Anton, Bebas Neue and Bangers are bundled with the renderer under the SIL Open Font License 1.1 (texts in `src/renderer/src/fonts/licenses`, shipped as `resources/font-licenses`). Arial Black, Impact, Segoe UI and Georgia are offered from Windows. Single-weight faces declare a weight range so the browser never synthesizes bold.
**Why:** short-form video relies on a few heavy display faces; bundling guarantees they exist on every machine. Because text is rasterized by the app (TD-108), fonts never need to be passed to FFmpeg.

### TD-112 — YouTube through the official Data API, with the user's own OAuth client

**Decision:** the YouTube connector uses the Data API v3 with OAuth 2.0 for installed apps: the system browser opens Google's consent page, Google redirects to a loopback listener on `127.0.0.1:<random port>`, and the code is exchanged with PKCE (S256) and a `state` check. Scopes: `youtube.upload` and `youtube.readonly`. The user creates the OAuth client (type "Desktop app") in their own Google Cloud project and enters the client ID and secret in the app. Uploads use the resumable protocol in 8 MiB chunks (multiples of 256 KiB), with exponential backoff on 5xx/network errors and a status query (`Content-Range: bytes */N`) before continuing; the session URI is saved on the publication so an upload interrupted by a quit continues on the next start.
**Facts checked (official docs, 2026-10-11):** `videos.insert` costs 1 unit in its own "Video Uploads" quota bucket of 100 calls/day; videos from unverified API projects are not restricted to private; desktop clients use the loopback redirect with PKCE; with an external OAuth app in "Testing" status, refresh tokens expire after 7 days (the UI says so and marks the account "Login expirado").
**Why:** no third-party service or shared app credentials: the user owns the Google project, quota and consent screen, and nothing passes through a server we run. Requests are made from the main process with Node's fetch; tokens never reach the renderer.
**Development/test hook:** `SM_GOOGLE_ENDPOINTS` (JSON) points the connector at a local stand-in, only in unpackaged builds. Unit and E2E tests use it with `tests/helpers/fake-google.ts`, which implements the documented token, PKCE and resumable-upload behaviour with switchable failures.

### TD-113 — Secrets encrypted by the OS, outside the database

**Decision:** OAuth tokens and the YouTube client secret are stored as individual files in `app-data/secrets/`, encrypted with Electron `safeStorage` (Windows DPAPI, tied to the Windows user). The database only holds an opaque `token_ref`. If encryption isn't available, connecting fails with a clear message instead of storing plaintext. Disconnecting revokes the grant at Google (best effort) and deletes the secret; the account and its publication history stay.
**Alternatives:** keytar / Windows Credential Manager (keytar is unmaintained; a native module for no gain over DPAPI).

### TD-114 — TikTok and Instagram start as manual destinations

**Decision:** TikTok and Instagram accounts are "manual": publishing creates a publication in "Aguardando você publicar" with the version file, title, caption and hashtags ready (copy button, open the platform's upload page, show the file), and the user confirms it — optionally with the post link — once posted.
**Why:** per TikTok's Content Posting API documentation, the app must be approved for `video.publish` and content from unaudited clients is restricted to private viewing; Instagram's publishing API requires a professional account linked to a Facebook page and an app reviewed by Meta. Pretending to publish, or automating the web UIs, would break the platforms' rules (spec §8, §16). The connector interface already supports an API publisher for these platforms once an approved app exists.

### TD-115 — One publication per destination, idempotent requests

**Decision:** a publish action creates one `publications` row per destination, each with its own status (queued → publishing → published | failed | cancelled; manual_pending → published). All destinations are validated before any is created. The renderer generates a request id when the dialog opens; the idempotency key is `<request id>:<account id>` (UNIQUE), so a repeated call creates nothing twice. Publishing the same version to the same account again requires an explicit confirmation. Uploads run in the background, at most one per account and two in total; failures don't affect other destinations; failed uploads can be retried (continuing the saved session when possible).

### TD-116 — In-process scheduler with a grace window; missed schedules wait for the user

**Decision:** scheduled publications are rows with status `scheduled` and `scheduled_at`. The publish service runs a tick on start and every 20 s: due rows move atomically (`UPDATE … WHERE status = 'scheduled'`) to `queued` (API) or `manual_pending` (manual, with a desktop notification). A row more than 15 minutes late (the computer was off or the app closed) is not run: it is flagged `missed`, the user is notified once, and it appears under "Precisa de você" to publish now or reschedule. A time in the past (or within 30 s) when creating means "now".
**Alternatives:** a Windows scheduled task or service that wakes the computer (rejected in Phase 1: needs elevation and a second process holding tokens); publishing missed posts as soon as the app opens (could post at 3 a.m. or after the moment passed — surprising and against "no silent automation").
**Why:** the app already runs in the tray at login, so an in-process timer covers the normal case with no extra moving parts; the conditional update makes double runs impossible even if two ticks overlap; and the user always decides about anything that would go out at an unexpected time.

### TD-117 — YouTube native scheduling (publishAt) by default

**Decision:** for YouTube, a schedule defaults to "platform" mode: the video is uploaded right away as `private` with `status.publishAt`, and YouTube makes it public at that time even with the computer off. The publication stays `scheduled` with its video id and becomes `published` when its time passes. "Local" mode (upload at the time) is available. A platform-scheduled post can't be rescheduled, paused or cancelled from the app (that would need `videos.update`/`delete`, not in the upload scope); the UI says to use YouTube Studio.
**Why:** per the API reference, `publishAt` requires `privacyStatus: private`, and a past time publishes immediately — the connector only sends it when the time is more than a minute ahead. Native scheduling is the reliable path; it also uses the upload quota at scheduling time, so quota problems show up early.

### TD-118 — Posting preferences and free-slot suggestions

**Decision:** `queue_settings` holds preferred weekdays and times per account (default: every day at 12:00 and 19:00, local time). "Próximo horário livre" picks the earliest preferred slot free on every chosen account (no planned post within 30 minutes). Suggestions only; nothing is auto-scheduled and nothing claims better reach.
**Why:** spec §9 asks for preferred days/times per account without inventing performance claims; real best-time insights need Phase 5 data.

### TD-119 — Calendar drag-and-drop keeps the time of day

**Decision:** dragging a post to another day in the month/week calendar reschedules it to the same time on that day, through the same `reschedule` path (validation: future time, not already on the platform). Pause stores status `draft` with `fields.paused`; resume needs a future time.
**Why:** the common action is "move to another day"; the time is edited precisely with "Reagendar". One code path for every reschedule keeps the rules in one place.

### TD-120 — YouTube metrics: Data API counters + YouTube Analytics API

**Decision:** views, likes and comments come from `videos.list?part=statistics` (1 quota unit per 50 videos, fresh); watch time (`estimatedMinutesWatched`), average view duration and percentage, shares and subscribers gained come from the YouTube Analytics API `reports.query` (`ids=channel==MINE`, `dimensions=video`, `filters=video==…`, publish date → today); channel subscribers from `channels.list?part=statistics`. No new OAuth scope: per the Analytics reference (checked 2026-10-11), `youtube.readonly`, which the app already requests, is accepted. The Analytics API must be enabled in the user's Google Cloud project; when it isn't (403 `accessNotConfigured`), counters are still saved and the account shows how to enable it.
**Why:** the Data API is cheap and current; Analytics has the richer metrics but lags a day or more, so a video missing from its rows keeps those fields `null`. Hidden counters (likes hidden by the owner, hidden subscriber count) are `null`, not zero.

### TD-121 — Snapshots, never overwritten; cadence by age

**Decision:** each collection inserts a row in `metric_snapshots` (source `api` or `manual`); the latest row is "current", the rest is history for charts and the 24 h / 7 d / 30 d marks (read as the last value at or before the mark). A 10-minute timer (first pass 30 s after start) collects publications whose last API snapshot is older than: 3 h (first 2 days), 12 h (to 30 days), 3 days (to 180 days), then 14 days. "Atualizar métricas" collects everything now. Collection status and the last error are stored per account (schema v4).
**Why:** spec §11 asks for history, not only the last number; the cadence keeps API use tiny while catching the early curve.

### TD-122 — Manual metrics for TikTok and Instagram, clearly labelled

**Decision:** for manual accounts the content page has a form to type the numbers shown in the platform's app (views, likes, comments, shares, followers gained, with the reading time; "12,5 mil" accepted). They are stored as snapshots with source `manual`, shown as "informado por você", and only those can be deleted. Accounts with API metrics don't accept typed numbers.
**Why:** without approved API access (TD-114) this is the only honest way to compare platforms; these are real numbers the user read, never estimates, and the source is always visible.

### TD-123 — Aggregation rules: coverage instead of zeros

**Decision:** totals sum only known values and report how many publications had each value ("1 de 2 com dado"); averages divide by publications with data. Engagement = (likes + comments + shares) ÷ views, only when all four exist and views > 0; group engagement is weighted (total interactions ÷ total views of those publications). Comparisons by platform, project, account, format (aspect ratio of the published version) and duration bucket are computed in the renderer from the same rows with one shared pure function, so every chart and table agrees. The UI notes that platforms count views differently.
**Why:** spec §11: no invented numbers, a clearly defined engagement formula, and no comparison of incompatible definitions without explanation.

### TD-124 — Inbox from YouTube comment threads; other platforms marked unavailable

**Decision:** the Inbox reads `commentThreads.list` with `allThreadsRelatedToChannelId` (part `snippet,replies`, newest first, 100 per page, 1 quota unit per page) every 15 minutes and on demand, stopping at the first page that reaches comments already stored (at most 5 pages per sync). Each comment and reply is stored once (`UNIQUE(account, external id)`), linked to the app's publication when the video was published from the app; edits update text and likes but keep read/resolved/replied status. On an account's first sync, comments older than 7 days are stored as read (history), and no desktop notification is shown; later syncs notify about new comments. YouTube returns only some replies per thread, so the UI links to the full conversation. TikTok and Instagram comments need approved apps (TD-114): their accounts show that, and nothing is scraped. General notifications (likes, new followers) are not offered by these APIs to this app and are shown as unavailable.
**Why:** spec §10 asks for the comments and interactions the APIs authorize, with clear indication of what isn't available.

### TD-125 — Replies: written by the user, sent once, with an explicit scope

**Decision:** replies use `comments.insert` with `snippet.parentId` = the thread's top-level comment (50 quota units), which requires the `youtube.force-ssl` scope; the app now requests it at connection. Accounts connected before this show "reconecte para responder" (granted scopes are kept from the token response, including across refreshes). The service refuses a second send for the same comment while one is in flight; the sent reply is stored as the account's own message (never unread) and the comment becomes "Respondido". Nothing is answered automatically and no AI text is sent.
**Why:** spec §10 and §16: answer only where the API allows it; AI only as suggestions for human review (Phase 7).

### TD-126 — Inbox states

**Decision:** read status (unread/read) and response status (none/resolved/replied) are separate. Opening a comment marks it read; it can be marked unread again. "Abertos" = not resolved and not replied. Filters: status, project, platform, account, content and text search; the sidebar shows the unread count.

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

- **Export quality check** (Phase 2 follow-up): compare OpenH264 at 10 Mbit/s with the hardware encoders on real footage; raise the software bitrate if needed (TD-109).
- **TikTok/Instagram API publishing**: if an approved app becomes available, implement their connectors (TD-114).
- **System proxy**: Node's fetch ignores the Windows proxy settings; switch to Electron's network stack if users behind proxies need it.
- **Shared core with the MCE** (TD-101): when both apps are stable.
