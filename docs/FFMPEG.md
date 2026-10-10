# FFmpeg in Social Machine

Social Machine bundles FFmpeg and FFprobe and runs them as separate
processes. This document records exactly which build is shipped, under which
license, what that license requires, and how to update it.

## The bundled build

| | |
| --- | --- |
| FFmpeg version | 9.0.2 (`n9.0.2-17-g2a571b6068`, release/9.0 branch) |
| FFmpeg source commit | [`2a571b6068`](https://github.com/FFmpeg/FFmpeg/tree/2a571b6068) |
| Publisher | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) |
| Release | [`autobuild-2026-09-30-13-08`](https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-09-30-13-08) (a month-end build, which BtbN retains long-term) |
| Variant | `win64-lgpl-shared` (Windows), `linux64-lgpl-shared` (Linux, development and tests only) |
| Windows archive | `ffmpeg-n9.0.2-17-g2a571b6068-win64-lgpl-shared-9.0.zip` |
| Windows SHA-256 | `7157177b8a6cb2174c1650ba8c71b363f2c78cba5330f88c4c02cf5b2b880646` |
| License | **LGPL-3.0-or-later** |

The pins live in `scripts/ffmpeg-sources.json`. The SHA-256 values were checked
against the publisher's own `checksums.sha256` for that release.

### Why this build

- **LGPL, not GPL.** BtbN publishes `gpl` and `lgpl` variants. The `lgpl`
  variant is configured with `--enable-version3` and **without**
  `--enable-gpl` and `--enable-nonfree`. It contains no GPL-only code
  (no libx264, libx265, libxvid, frei0r, vidstab, rubberband) and nothing
  non-redistributable (no libfdk-aac). The packaged-app test in CI checks the
  configuration line of the shipped `ffmpeg.exe` for this.
- **Shared libraries.** The `-shared` variant ships `ffmpeg.exe` and
  `ffprobe.exe` as small programs plus the FFmpeg DLLs (`avcodec-63.dll` and
  so on). The two programs share one set of libraries, which keeps the
  installer smaller, and the user can replace the DLLs with compatible builds,
  which is the arrangement the LGPL is designed around.
- **Codecs needed by the roadmap.** Decoding covers everything relevant for
  import (H.264, HEVC, ProRes, VP8/9, AV1 via dav1d, MPEG-4, MJPEG, AAC, MP3,
  FLAC, ALAC, Opus, Vorbis, PCM, …). For Phase 3 rendering it includes
  **OpenH264** (BSD-licensed H.264 encoder, verified in the Linux build of the
  same release) and is configured with the hardware encoder interfaces (NVENC,
  QSV via libvpl, AMF), which work only where the GPU and driver support them.
  Which encoders the Windows build actually offers is to be measured in
  Phase 3. It does **not** include libx264. See
  `TECHNICAL_DECISIONS.md` (TD-012) for what that means for export quality.

### Why not other sources

- `ffmpeg-static` / `ffprobe-static` (npm): ship GPL builds, and the two
  packages are years apart in version.
- gyan.dev builds: well maintained and versioned, but GPL v3 (they include
  libx264/libx265).
- Requiring a user-installed FFmpeg: the spec requires bundling, and the
  version and capabilities would be unknown.

## What ships in the installer

`electron-builder.yml` copies `vendor/ffmpeg/win32-x64/` to
`<install dir>/resources/ffmpeg/`:

```
resources/ffmpeg/
├── bin/
│   ├── ffmpeg.exe, ffprobe.exe
│   └── avcodec-63.dll, avdevice-63.dll, avfilter-12.dll, avformat-63.dll,
│       avutil-61.dll, swresample-7.dll, swscale-10.dll
├── LICENSE.txt         LGPL v3 (from the build archive)
├── COPYING.GPLv3       GPL v3 (incorporated by the LGPL v3; from FFmpeg n9.0.2)
├── FFMPEG-LICENSE.md   FFmpeg's own licensing notes (from FFmpeg n9.0.2)
├── NOTICE.txt          version, license, archive checksum, source locations
└── manifest.json       machine-readable version and license
```

`ffplay.exe` is deliberately not shipped. It isn't used.

## License obligations when distributing

The LGPL v3 applies to anyone who **conveys** (distributes) the installer.
Using the app yourself creates no obligations. Before giving the installer to
anyone else (a friend, a release download, a store):

1. **License texts accompany the program.** Done: `LICENSE.txt` (LGPL v3) and
   `COPYING.GPLv3` are in `resources/ffmpeg`. [LGPL v3 §4(b)]
2. **Prominent notice** that FFmpeg is used and covered by the LGPL. Done:
   `NOTICE.txt`, and Settings → Diagnostics shows the FFmpeg version, its
   license and the folder containing the notices. If the app gets an About
   screen, mention it there too. [LGPL v3 §4(a)]
3. **Corresponding source** for the FFmpeg binaries, offered in one of the
   ways LGPL v3 §4(d) / GPL v3 §6 allow. `NOTICE.txt` points to the exact
   FFmpeg commit and to the BtbN build scripts at the exact release tag, which
   pin every bundled third-party library. **Before a public release, keep your
   own copy** rather than relying only on third-party links, because you remain
   responsible for the source staying available:
   - download `https://github.com/FFmpeg/FFmpeg/archive/2a571b6068.tar.gz`
   - download the BtbN repository at tag `autobuild-2026-09-30-13-08`
   - publish both next to the installer (e.g. attach them to the GitHub release).
4. **Allow replacing the libraries.** Satisfied by the shared-library layout:
   the DLLs sit next to `ffmpeg.exe`, and the app has no restriction on users
   replacing them. [LGPL v3 §4(d)(1)]
5. **No GPL components.** Re-check this whenever the pin changes: run
   `bin/ffmpeg -hide_banner -version` and confirm the configuration has no
   `--enable-gpl` and no `--enable-nonfree`. The packaged-app test does this in CI.
6. **Trademark.** "FFmpeg" is a trademark of Fabrice Bellard. Refer to it only
   to describe the bundled component, as the notice does.

The application's own code is not affected: it runs the unmodified FFmpeg
programs as separate processes and doesn't link against the libraries.

This is a practical summary, not legal advice. If the app is ever sold or
distributed widely, have the licensing reviewed.

## How the app finds FFmpeg

`src/main/media/binaries.ts` resolves the folder (never the system `PATH`):

| Situation | Folder |
| --- | --- |
| `SM_FFMPEG_DIR` is set | that folder (tests, troubleshooting) |
| Installed / packaged app | `<install dir>/resources/ffmpeg` |
| Development (`npm run dev`, E2E) | `<project>/vendor/ffmpeg/<platform>-<arch>` |

At startup, `MediaToolsManager` checks that both programs exist and run
`-version` successfully. Until that passes, import is disabled and the Media
Library shows what to do:

- development: run `npm run fetch:ffmpeg`
- installed app: reinstall; check antivirus quarantine if it happens again
- broken binaries: they exist but don't start (corrupt download, blocked by antivirus)

Settings → Diagnostics shows the version, license and folder, and has a
**Check FFmpeg again** button.

## Updating the pinned build

1. Pick a **month-end** BtbN release (`autobuild-YYYY-MM-<last day>-…`).
   BtbN deletes most daily builds after a while but keeps month-end ones.
2. Note the exact asset names for `win64-lgpl-shared` and `linux64-lgpl-shared`,
   and their SHA-256 from that release's `checksums.sha256`.
3. Update `scripts/ffmpeg-sources.json` (version, describe, commit, tag, assets, hashes).
4. Copy `COPYING.GPLv3` and `LICENSE.md` from the matching FFmpeg tag into
   `scripts/licenses/` if they changed.
5. Run `npm run fetch:ffmpeg -- --force`, `npm test`, `npm run test:e2e`.
6. Update this file and `TECHNICAL_DECISIONS.md`.

If the pinned release ever disappears, the fetch fails loudly with the URL. To
remove that dependency entirely, upload the verified archives to a release in
this repository and point `baseUrl` there.
