# Project status

_Last updated: 2026-10-11 — Phase 1_

## Current phase: 1 — Base funcional

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

**Phase 2 — Editor** (after Phase 1 is accepted on Windows):

- Decide the H.264 export encoder (TD-012 / open decisions) by measuring OpenH264 vs. hardware encoders on 1080×1920.
- Trim start/end, crop/reframe to 9:16 with zoom and position, text overlays (font, size, color, outline, shadow, position) with per-project presets and platform safe-area preview.
- Export with FFmpeg into `content_versions`, never overwriting the original.

Before Phase 3, verify the current YouTube, TikTok and Instagram API requirements against the official documentation.
