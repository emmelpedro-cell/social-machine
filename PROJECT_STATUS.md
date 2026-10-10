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

Run in the development container (Linux, Node 22, real FFmpeg 9.0.2 from the pinned build), before pushing:

- **Unit tests: 136 passed, 0 failed** across 13 files (run with Bun's Vitest-compatible runner because the npm registry was unreachable from that environment; CI runs them with Vitest). They include:
  - migrations: every table created, platforms seeded, constraints (unique project names, workflow values, idempotency keys), contents survive project deletion, no token columns;
  - repositories: projects (CRUD, duplicates, counts, suggested set), contents (workflow, project, title, stats), watch folders;
  - import pipeline with real FFmpeg: videos imported with metadata and thumbnails; audio-only and still images rejected; duplicates by path and content; **renamed file keeps its id, project and status**; missing files and relink; cancel; crash recovery; FFmpeg unavailable; failed file retried after it changes;
  - folder watching: existing files on start; **waits until a file stops growing**; no double import and no change to source files; **files created while closed found on start**; detection from events without a rescan; **detection by rescan when events never arrive**; watcher failure falls back to polling and re-attaches; missing folder becomes watched once it exists; disabled folders; deferred imports retried; failed files reconsidered once changed; end-to-end with the real importer: a render written in chunks is imported once into the folder's project as "needs review", a rename keeps the entry, and a copy adds nothing.
- **Type check** of `src/main`, `src/preload`, `src/shared` and `src/renderer` with locally assembled type definitions: no errors in project code.

**Not verified in the container**, pending the Windows CI run on GitHub Actions (`windows-latest`): `npm install` with the real dependency versions, Vitest itself, the full `npm run typecheck` (including tests), Electron E2E (smoke and the media/watch/tray flows in `tests/e2e/`), the Windows installer build and the packaged-app test. This section is updated with the CI result.

**Manual checks still needed on a real Windows desktop** (CI can't observe them): the tray icon and its menu, the balloon hint on first close, "start with Windows" after a real log-in, and watching a real Drop Machine output folder during a real render.

## Known issues / limitations

- Integration with the Drop Machine is through its output folder only. Its code isn't in this repository, so its project data (sport, events) isn't read yet. If it's added to GitHub, contents could carry the sport preset and event timestamps.
- A clip removed from the library while its file stays in a watched folder is imported again after the next restart (TD-104, known limitation).
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
