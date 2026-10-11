# Project status

_Last updated: 2026-10-11 — Phase 4_

## Current phase: 4 — Queue and calendar

Acceptance criterion (spec §17): _the user can schedule and manage publications across projects._

| Item | Status |
| --- | --- |
| Schedule per publication from the publish dialog (now / date-time / next free slot) | Done |
| Local scheduler (tick on start and every 20 s), atomic transitions, 15-minute grace; missed schedules flagged and never published late silently | Done (TD-116) |
| YouTube native scheduling with `publishAt` (uploaded right away as private), local mode available | Done (TD-117) |
| Manual destinations: desktop notification at the time | Done |
| Reschedule, publish now, pause/resume, cancel | Done |
| Posting days and times per account, next-free-slot suggestion | Done (TD-118) |
| Queue screen: needs you / sending / scheduled by day / recently published, filters by project and account | Done |
| Calendar: month, week, day; project colors; drag to another day to reschedule | Done (TD-119) |
| Dashboard "Próximas publicações"; sidebar badge for items waiting for you | Done |

### Verification (Phase 4)

_Pending CI run._

### Known limitations (Phase 4)

- Local schedules need the app running (tray is enough); the computer isn't woken up. YouTube's native scheduling doesn't have this limit.
- A video already scheduled on YouTube is changed only in YouTube Studio (the upload scope doesn't allow editing it).
- Best posting times are your preferences, not analytics (real data comes in Phase 5).

## Phase 3 — Accounts and publishing (accepted)

Acceptance criterion (spec §17): _the user can publish contents through official integrations._

| Item | Status |
| --- | --- |
| Platform API rules checked against official docs (YouTube quota and unverified-project rules, OAuth for desktop apps, 7-day refresh tokens in Testing; TikTok audit/private-only) | Done (TD-112, TD-114) |
| Connector architecture with declared capabilities (publish / manual) | Done |
| YouTube: OAuth loopback + PKCE with the user's own OAuth client, channel lookup, reconnect keeping history, revoke on disconnect | Done |
| YouTube upload: resumable, chunked, progress, backoff on 5xx/network, status queries, session saved and continued after a restart, token refresh, "reconnect" on revoked grants, quota messages | Done |
| TikTok and Instagram as manual destinations: file, caption and hashtags ready, open the upload page, confirm with link | Done (TD-114) |
| Tokens and client secret encrypted with safeStorage (DPAPI), never in the database or logs | Done (TD-113) |
| Accounts screen with in-app setup guide; accounts associated with projects | Done |
| Publish dialog: destinations (project accounts preselected), title, caption, hashtags from the project, YouTube visibility/category/made-for-kids, Shorts note | Done |
| One publication per destination, validated together, idempotent request id, repeat confirmation, independent failures, retry/cancel | Done (TD-115) |
| Publication history in the library details, editor and dashboard | Done |
| Schema v3 | Done |

### Verification (Phase 3)

**Verified on Windows** (GitHub Actions `windows-latest`, run 38101791046, 2026-10-11): install, type check, unit tests, Electron E2E, installer build and packaged-app test all passed.

- **Unit tests: 181 passed, 1 skipped.** New: 17 publishing tests against a local stand-in for Google that implements the documented OAuth/PKCE and resumable-upload behaviour: connect (PKCE verified, tokens only in the secret store, nothing secret in the database), denied consent, upload with exact bytes and metadata, 503s and a dropped connection mid-upload, **continuing an interrupted upload after a restart with the same session**, expired session restarted, access-token refresh, revoked grant → "reconnect" and a successful retry after reconnecting, quota message, idempotent requests and repeat confirmation, independent destinations, validation before creating, cancel, disconnect with revoke, metadata sanitizing, encrypted secret files.
- **Electron E2E: 14 passed.** New, through the real UI with the Google stand-in: client credentials saved (secret never shown again), channel connected via the consent redirect, account linked to a project, manual TikTok account added, a version published to YouTube (the stand-in received the exact file and the dialog's title, description with hashtags, tags, visibility and made-for-kids) and to TikTok (manual, confirmed with its link), repeat confirmation; after a restart the dashboard shows both publications, the account is still connected, and neither the refresh token nor the client secret appears in the database files.
- **Packaged app: 2 passed.**

**Not verifiable in CI — needs your Google project and a real channel:** the first real connection and upload. Follow the steps on the Contas screen; if something fails, the error message and `app-data/logs/app.log` say why.

### Known limitations (Phase 3)

- No real-network test against Google in CI (no credentials there); behaviour follows the official protocol documentation and the stand-in.
- TikTok and Instagram are manual until an approved app exists (TD-114).
- With the Google project in "Testing", the YouTube login expires every 7 days (Google's rule).
- Node's fetch doesn't use the Windows proxy settings.

## Phase 2 — Editor (accepted)

Acceptance criterion (spec §17): _the user can prepare and export videos without opening another editor._

| Item | Status |
| --- | --- |
| Editor screen (from the library or the menu), live preview at the exact output framing | Done |
| Output formats 9:16 (1080×1920), 16:9, 1:1, 4:5, original; cover/contain, zoom, position by sliders or dragging, blurred/black background | Done |
| Trim start/end (draggable bar, "here" buttons), looping preview, mute | Done |
| Text overlays: bundled and Windows fonts, size, bold, uppercase, color, outline, shadow, background box, alignment, width, time range, drag to position | Done |
| Same drawing code for preview and export (canvas → PNG → FFmpeg) (TD-108) | Done |
| Platform safe-area guides for TikTok/Reels/Shorts (approximate) | Done |
| Versions: background render queue, progress, cancel, retry, recovery after quit, `.part` output verified by FFprobe, thumbnail, never overwriting files, original never modified (TD-110) | Done |
| H.264 encoder detection with hardware → OpenH264 fallback; setting to force OpenH264 (TD-109) | Done |
| Versions listed in the editor and the library details panel; play, show in folder, edit as new, delete with/without file; count on library cards | Done |
| Presets per project or global (format, framing, text styles) | Done |
| Schema v2 (rendering columns), migration with backup | Done |

### Verification (Phase 2)

**Verified on Windows** (GitHub Actions `windows-latest`, run 38100271259, 2026-10-11): install, type check, unit tests, Electron E2E, installer build and packaged-app test all passed.

- **Unit tests: 163 passed, 1 skipped** (symlink test, non-Windows only). New for Phase 2:
  - layout math and render plan (cover/contain, position edges, zoom, even sizes, trim, timed overlays in order, audio/mute, fps cap, bitrate), progress parsing, Windows-safe names, PNG validation;
  - real FFmpeg renders: 9:16 with trim and a text overlay (pixel-checked in the output), contain on black with muted audio, original format, 16:9 with blurred background; impossible requests rejected (trim past the end, wrong overlay size, orphan overlay, duplicate name); existing export files never overwritten; cancel; interrupted render marked failed and retried; delete with/without file; missing original refused; encoder detection; presets.
- **Electron E2E: 12 passed**, including through the real UI: a clip opened in the editor, zoomed, given a text in Anton with a background box, exported as "Clean 9:16"; the MP4 on disk is 1080×1920 with the box burned in where the preview drew it; the original is byte-identical; the content moved to "Em edição"; a preset saved; the version plays in the app; after a restart the library card shows "1 versão", and a second version from the preset in 1:1 renders at 1080×1080.
- **Packaged app: 2 passed.**

**Manual checks still useful on a real PC:** the hardware encoder chosen on your machine (Settings shows it) and the look of exported text against real footage on a phone.

### Known limitations (Phase 2)

- Text is static during its time range: no animation or word-by-word highlight yet (future work in the spec).
- No automatic captions/transcription, batch editing or auto-reframing yet (future work).
- The blurred background in the preview is a CSS approximation of the export's blur; framing, text and timing are exact.
- Platform safe areas are approximate guides and may change with the apps.
- Duration/format limits of each platform are not enforced yet; they will be checked against current official rules in Phase 3.

## Phase 1 — Base funcional (accepted)

Acceptance criterion (spec §17): _new clips from the Drop Machine appear in the Social Machine library._ Plus the Phase 1 completion criteria agreed for this repository: the app starts on Windows; projects persist; manual import works; new videos in the watched folder are detected, including those created while the app was closed; the same file is never imported twice (including after a rename); source files are never modified, moved or deleted; access errors, incomplete files and read failures are handled; tests and run instructions exist; the UI uses real data.

| Item | Status |
| --- | --- |
| Base copied from the Music Content Engine Phase 1 and adapted (TD-101) | Done |
| SQLite schema v1 with the full data model: projects, platforms, accounts, watch folders, contents, versions, publications, metrics, inbox, queue settings, presets, tasks (TD-102) | Done |
| Migrations versioned, checksummed, one transaction each, backup before migrating | Done (inherited) |
| Projects: create, edit (color, category, description, default hashtags, caption template), delete without losing contents, suggested MMA/Futebol/Basquete/Skate | Done |
| Library: videos only, metadata (duration, resolution, aspect ratio, fps, codecs), thumbnails, preview | Done |
| Content states: processing, availability and workflow (imported, needs review, editing, ready, archived) kept separate (TD-103) | Done |
| Filters (project, status, origin, file state, search), sorting, bulk status/project changes, title editing | Done |
| Manual import (files, folders, drag-and-drop) into a project or none | Done |
| Deduplication by path and by content fingerprint; renamed files keep their entry | Done |
| Folder watching: recursive events + periodic rescan + start-up reconciliation; stability check; ignores temp/partial files; per-folder project and origin (TD-104) | Done |
| Drop Machine output folder as a first-class watched folder (origin "Drop Machine", default path hint) | Done |
| Tray: close to tray, single instance, start with Windows (hidden), tray menu (open, scan now, quit) (TD-105) | Done |
| Dashboard: review/editing/ready/unassigned counts, recent imports, watched folder state, projects | Done |
| Later-phase areas (Editor, Contas, Fila, Calendário, Analytics, Inbox) shown as non-interactive placeholders | Done |
| Portuguese UI and user-facing errors (TD-107) | Done |
| Logs (JSON lines, rotation) and error handling | Done (inherited, extended) |

### Verification

**Phase 1 verified on Windows** (GitHub Actions `windows-latest`, run 38098386103, 2026-10-11). Every step passed: install (better-sqlite3 rebuilt for Electron), strict FFmpeg verification, full type check (main, renderer, E2E), unit tests, Electron E2E, installer build, packaged-app test.

- **Unit tests: 135 passed, 1 skipped** (the symlink test, which only applies outside Windows), across 13 files, with the bundled FFmpeg on generated real videos. They cover:
  - migrations: every table created, platforms seeded, constraints (unique project names, workflow values, idempotency keys), contents survive project deletion, no token columns;
  - repositories: projects (CRUD, duplicates, counts, suggested set), contents (workflow, project, title, stats), watch folders;
  - import pipeline: metadata and thumbnails; audio-only and still images rejected; duplicates by path and content; a **renamed file keeps its id, project and status**; missing files and relink; cancel; crash recovery; FFmpeg unavailable; a failed file retried after it changes;
  - folder watching: existing files on start; **waits until a file stops growing**; no double import and no change to source files; **files created while closed found on start**; detection from events without a rescan; **detection by rescan when events never arrive**; watcher failure falls back to polling and re-attaches; missing folder watched once it exists; disabled folders; deferred imports retried; end-to-end with the real importer (render written in chunks imported once as "needs review", rename keeps the entry, a copy adds nothing).
- **Electron E2E (built app): 10 passed**, through the real UI:
  - suggested and custom projects created, edited (hashtags) and still there after a restart;
  - videos imported into a project with metadata (`0:02 · 180×320 · 9:16 · 30 fps`), thumbnail and preview decoded by Electron; title and status edited; all kept after a restart; re-import adds nothing;
  - **Drop Machine output folder**: a clip already there is imported when the folder is added; a new clip written in chunks arrives once, in the folder's project, as "Precisa de revisão"; the sidebar badge and the dashboard update; source files untouched;
  - **closing the window keeps the app in the tray and still importing**; a clip created while the app was fully closed is imported on the next start;
  - bulk status and project changes; a moved file shown as missing and relinked; drag-and-drop path with clear Portuguese errors for a broken file and an audio-only file; forged paths rejected;
  - the renderer has no Node access; the media protocol serves only library contents; later-phase screens are non-interactive.
- **Packaged app (`dist/win-unpacked`): 2 passed**: FFmpeg bundled with its LGPL notices, found (`source: packaged`) and importing a video.
- The installer is uploaded as the `windows-installer` artifact of each CI run.

**Manual checks still needed on a real Windows desktop** (CI can't observe them): how the tray icon and menu look and behave, the balloon hint on first close, "start with Windows" after a real log-in, and a real Drop Machine render landing in its output folder.

## Known issues / limitations

- Integration with the Drop Machine is through its output folder only. Its code isn't in this repository, so its project data (sport, events) isn't read yet. If it's added to GitHub, contents could carry the sport preset and event timestamps.
- A clip removed from the library while its file stays in a watched folder is imported again after the next restart (TD-104, known limitation).
- A clip in a watched folder with the same content as one already in the library is skipped as a duplicate (with a notice), even if it has a different name.
- Watching stops when the app is fully quit or the computer is off; the start-up reconciliation catches up (TD-105).
- No proxies: codecs Chromium can't decode (ProRes, some HEVC) import correctly but can't be previewed (TD-018).
- The installer is unsigned (SmartScreen warning) and has no auto-update.
- No `package-lock.json` committed yet; CI uses `npm install`.
- **Before distributing the installer to anyone**, archive the FFmpeg corresponding source next to the release (docs/FFMPEG.md).

## Next task

**Phase 4 — Queue and calendar:**

- Scheduling per destination (local scheduler in the main process using the `tasks`/`publications` tables; YouTube native `publishAt` where it fits), preferred days/times and frequency per account (`queue_settings`).
- Queue screen grouped by day, reschedule, pause/cancel, duplicate protection, recovery of missed schedules after the computer was off (ask, never publish silently late).
- Calendar views (day, week, month).
