# Implementation Plan — Obsidian Google Drive Sync (`gdrive-sync`)

Based on [docs/PRD.md](docs/PRD.md) (Final v1.1, 2026-11-21). Section references like §7.2 point into the PRD.

The repository is empty, so this plan covers everything from scaffolding to release. It follows the PRD milestones M1–M5 and adds an M0 for project setup.

---

## 1. Approach

The sync logic is the risky part, and it is hard to test inside Obsidian. So the core design rule is:

> **The sync engine is plain TypeScript with no `obsidian` import.** It talks to three small interfaces (ports): `VaultPort`, `DriveClient` and `Clock`. The Obsidian plugin wires real implementations into them; the tests wire in-memory fakes.

With fakes for Drive (including a server clock, `Date` headers, failure injection and multiple "devices" sharing one fake Drive), acceptance tests A1–A14 and P1 run in CI in milliseconds. Only A15 (mobile) and a live smoke test need real devices and a real Google account.

## 2. Tech stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) | Obsidian standard |
| Bundler | esbuild (same setup as the official `obsidian-sample-plugin`) | Small, fast, the format Obsidian expects (`main.js` CJS) |
| Tests | Vitest | Fast, TS-native, fake timers |
| MD5 | `spark-md5` (`ArrayBuffer` API) | Pure JS, works on mobile (§8) |
| HTTP | Obsidian `requestUrl()` behind `HttpClient` | No CORS issues on desktop/mobile (§8) |
| Lint/format | ESLint + Prettier | — |
| CI | GitHub Actions: `typecheck`, `lint`, `test`, `build` | — |

No other runtime dependencies.

## 3. Repository layout

```
.
├── manifest.json            # id: gdrive-sync, isDesktopOnly: false
├── versions.json
├── package.json / tsconfig.json / esbuild.config.mjs / vitest.config.ts
├── README.md                # setup + refresh-token guide (§9), limitations (§12)
├── docs/PRD.md
├── src/
│   ├── main.ts              # Plugin class: load settings, command, ribbon, status bar, run lock
│   ├── settings.ts          # DEFAULT_DATA, mergeWithDefaults(), SettingTab (§7.1, §7.7)
│   ├── constants.ts         # EPOCH = 2000-01-01T00:00:00.000Z, 5 MB threshold, concurrency 4, retries 3
│   ├── ports/
│   │   ├── vault.ts         # VaultPort interface + ObsidianVault implementation
│   │   ├── clock.ts         # Clock interface (now()) + SystemClock
│   │   └── http.ts          # HttpClient interface + ObsidianHttp (requestUrl, throw:false)
│   ├── drive/
│   │   ├── auth.ts          # TokenProvider: refresh, cache in memory, invalidate on 401, invalid_grant → AuthError
│   │   ├── client.ts        # DriveClient: list/query, createFolder, multipart, resumable, update, download
│   │   ├── query.ts         # q-string builder + escaping of ' and \ in names
│   │   └── errors.ts        # classify: retryable (429, 403 rateLimitExceeded/userRateLimitExceeded, 5xx, network) vs fatal
│   ├── sync/
│   │   ├── engine.ts        # runSync(): Steps 0–6, returns SyncResult; never touches Obsidian directly
│   │   ├── folders.ts       # Step 2: resolve/create obsidian/<vault>, oldest-wins, cached-ID validation
│   │   ├── remoteIndex.ts   # Step 3: full walk + incremental query, folder map maintenance
│   │   ├── upload.ts        # Step 4
│   │   ├── download.ts      # Step 5
│   │   ├── conflict.ts      # conflict file name: "<name> (conflict YYYY-MM-DD HHmm).<ext>", collision suffix
│   │   ├── exclude.ts       # §7.4 rules (uses vault.configDir, not a hard-coded ".obsidian")
│   │   ├── paths.ts         # normalize, join, split, valid-local-name check
│   │   ├── pool.ts          # concurrency limiter (max 4)
│   │   ├── retry.ts         # exponential backoff + full jitter, injectable sleep
│   │   ├── progress.ts      # counters ↑done/total ↓done/total → status bar callback
│   │   └── result.ts        # SyncResult, summary notice text
│   ├── log/syncLog.ts       # ring buffer of 500 lines, written to <plugin dir>/sync.log, redaction
│   └── util/md5.ts          # md5(ArrayBuffer) → hex
└── tests/
    ├── fakes/
    │   ├── fakeDrive.ts     # in-memory Drive v3: folders, files, md5, server clock, Date header, query engine, fault injection
    │   ├── fakeVault.ts     # in-memory vault with per-device clock and mtime
    │   └── device.ts        # helper: a "device" = fakeVault + own data.json + own clock, sharing one fakeDrive
    ├── unit/                # one file per module
    ├── acceptance/          # A1–A14 as scenario tests
    └── perf/p1.test.ts
```

## 4. Key design decisions

### 4.1 Interfaces (ports)

```ts
interface VaultPort {
  name(): string;                                   // app.vault.getName()
  configDir(): string;                              // app.vault.configDir (usually ".obsidian")
  listFiles(): { path: string; mtime: number; size: number }[];
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;  // create or modifyBinary, creates parent folders
  exists(path: string): boolean;
  stat(path: string): { mtime: number } | null;
}

interface DriveClient {
  serverTime(): number | null;                      // Date header of the first response in this run
  findFolders(parentId: string, name?: string): Promise<DriveItem[]>;
  listChildren(folderId: string): Promise<DriveItem[]>;          // paged
  queryChangedSince(rfc3339: string): Promise<DriveItem[]>;      // paged
  findFile(parentId: string, name: string): Promise<DriveItem[]>;
  createFolder(parentId: string, name: string): Promise<DriveItem>;
  createFile(parentId: string, name: string, data: ArrayBuffer): Promise<DriveItem>;
  updateFile(id: string, data: ArrayBuffer): Promise<DriveItem>; // never sends modifiedTime
  download(id: string): Promise<ArrayBuffer>;                    // files.get?alt=media
  getItem(id: string): Promise<DriveItem | null>;
}
```

### 4.2 Watermarks (§6)

- `syncStart.local = clock.now()` and `syncStart.remote = Date header of the token-exchange response` are both captured in Step 1, before any listing. The `Date` header has 1-second resolution; truncating down only makes the window wider, which is safe.
- If the `Date` header is missing or unparsable, fall back to the `Date` header of the first Drive call; if that also fails, **fail the run** (never fall back to the local clock — that would reintroduce R2).
- `lastSync` is written in exactly one place: the end of `runSync()` when `failures.length === 0`. A unit test asserts no other code path calls `saveData` with a new `lastSync`.

### 4.3 HTTP layer

- `requestUrl({ throw: false })` so we can read status, body and headers on errors. Header names are normalized to lower case (`date`, `location`).
- Every Drive request goes through `withAuth()`: on `401`, invalidate the access token, refresh once, retry once.
- Retryable errors go through `retry.ts` (3 attempts per file, backoff `base 500 ms × 2^n`, full jitter, cap 8 s). Non-retryable errors (400, 404 on create, invalid name) fail that file right away.
- `invalid_grant` from the token endpoint throws `AuthError` → engine stops before touching any file (A13).

### 4.4 Uploads

- Multipart (`uploadType=multipart`) for ≤ 5 MB; resumable (`uploadType=resumable`, read `Location`, single `PUT` of the bytes) for > 5 MB.
- Metadata on create: `{ name, parents: [folderId] }`. On update: no metadata at all. **No `modifiedTime` anywhere** — a unit test inspects every outgoing request body to make sure (R1).
- Content type: best-effort from extension (`.md → text/markdown`), otherwise `application/octet-stream`.

### 4.5 Remote index and folder map (Step 3)

- `folderMap: { [folderId]: relativePath }` with the vault folder mapped to `""`. The engine also keeps a reverse `pathToFolderId` in memory.
- Incremental results are processed **folders first, then sorted by depth**, so a new folder whose parent is also new resolves in one pass. Only if a parent is still unknown after that does the engine fall back to a full walk.
- Items whose resolved path is excluded, or whose name is invalid locally (§7.4), are logged as `SKIP` and **do not count as failures** (otherwise `lastSync` would never move).
- Folder map is saved to `data.json` only together with `lastSync` (on success). On failure the in-memory map is discarded; the next run rebuilds what it needs. This keeps "state moves only on success" simple.

### 4.6 Upload pass (Step 4) — exact order

```
for each local file (not excluded) with mtime > lastSync.local:     # pool of 4
  folderId = ensureRemoteFolders(dirname(path))                      # creates + adds to folderMap
  remote   = remoteChanged[path] ?? findFile(folderId, basename)     # oldest if duplicates (+ warn)
  if !remote:                               create            → uploadedThisRun += id
  elif md5(local) == remote.md5Checksum:    SKIP
  elif remote.id in remoteChanged:          CONFLICT: download remote → conflict copy; update remote with local
  else:                                     update            → uploadedThisRun += id
```

`findFile` is only called for candidates, so an unchanged vault does zero per-file API calls (P1).

### 4.7 Download pass (Step 5)

```
for each item in remoteChanged, not folder, not google-apps.*, id ∉ uploadedThisRun:   # pool of 4
  if local missing:                         create (with folders)
  elif md5(local) == md5Checksum:           SKIP
  elif local.mtime > syncStart.local:       CONFLICT (see §6, risk #1)
  else:                                     overwrite with modifyBinary
```

### 4.8 Run lock, progress, notices

- `main.ts` holds `running: boolean`; `Sync` while running → `new Notice("Sync already running")` (A14). Ribbon icon calls the same function.
- Status bar text from `progress.ts`: `Syncing… ↑3/10 ↓1/4`, cleared at the end.
- Final notice from `result.ts`: `Sync done — ↑4 ↓2 ⚠1 conflict` or `Sync incomplete — 2 files failed, run Sync again`.

### 4.9 Log (§7.6)

- Lines: `2026-11-21T10:15:02.123Z UPLOAD notes/a.md created`. Ring buffer of 500, flushed once at the end of each run (and on failure) via `app.vault.adapter.write(`${manifest.dir}/sync.log`)`.
- `log()` only accepts `(action, path, reason)`; there is no way to pass a body or token into it. Error reasons are built from HTTP status + Google `error.reason`, never from request bodies or headers.

## 5. Milestones and tasks

Each task is a small PR-sized unit. "Tests" lists what must pass before the task is done.

### M0 — Project setup (½ day)

| # | Task | Tests / done when |
|---|---|---|
| 0.1 | Scaffold from the sample-plugin layout: `manifest.json` (`gdrive-sync`, `isDesktopOnly: false`), esbuild, tsconfig strict, `obsidian` types | `npm run build` produces `main.js` |
| 0.2 | Vitest, ESLint, Prettier, `npm run check` script | Empty test suite runs |
| 0.3 | GitHub Actions CI: typecheck, lint, test, build on push/PR | CI green |

### M1 — Skeleton, settings, auth, folders, `syncStart` (2 days)

| # | Task | Tests |
|---|---|---|
| 1.1 | `settings.ts`: `DEFAULT_DATA`, deep `mergeWithDefaults()`, SettingTab with 3 fields (secret + token as password inputs), read-only "Last successful sync" ("Never" when epoch), plain-text warning | Unit: missing/partial fields → defaults |
| 1.2 | `main.ts`: command `sync` / `Sync`, ribbon icon, status bar item, run lock, Step 0 empty-field check | Unit (engine-level): empty fields → stop, no HTTP |
| 1.3 | `ports/http.ts`: `ObsidianHttp` on `requestUrl`, header normalization | Unit with stub |
| 1.4 | `drive/auth.ts`: token refresh, in-memory cache, 401 → refresh once, `invalid_grant` → `AuthError` | Unit: 401 retry, invalid_grant |
| 1.5 | `syncStart` capture from local clock + `Date` header | Unit: header parsing, missing header fails run |
| 1.6 | `drive/query.ts` + `drive/client.ts` folder calls; `sync/folders.ts`: case-insensitive `obsidian` match, exact vault-name match, oldest-wins + warning, cached ID validation (missing/trashed → search again) | Unit + **A1 (folder part), A2** |
| 1.7 | `fakes/fakeDrive.ts` v1 (folders, `Date` header, query subset used by folders) | — |

### M2 — Remote index and folder map (2 days)

| # | Task | Tests |
|---|---|---|
| 2.1 | Fake Drive query engine: `modifiedTime >`, `trashed = false`, `'id' in parents`, `name =`, `mimeType`, paging with `nextPageToken` | Unit for the fake itself |
| 2.2 | Full recursive walk → `folderMap` + `remoteChanged` (first sync) | Unit: nested tree |
| 2.3 | Incremental query, filter to folder map, folders-first/depth ordering, fallback to full walk on unknown parent | Unit: new nested folders from another device; item outside vault ignored |
| 2.4 | Exclusion + invalid-name filtering on remote items (`SKIP`, not failure) | Unit |
| 2.5 | Duplicate remote file names in one folder → oldest wins + warning | Unit |

### M3 — Upload pass (2–3 days)

| # | Task | Tests |
|---|---|---|
| 3.1 | `exclude.ts` (uses `configDir`), `paths.ts`, `util/md5.ts` | Unit |
| 3.2 | `ensureRemoteFolders()` creating nested folders, updating `folderMap` | **A7** |
| 3.3 | Multipart create/update; resumable for > 5 MB | Unit: request shape; **no `modifiedTime` in any body** |
| 3.4 | Candidate selection (`mtime > lastSync.local`) and the 4.6 decision order (MD5 before conflict) | Unit per branch; **A4** |
| 3.5 | Conflicts: conflict-copy naming (+ ` 2`, ` 3` suffix if that name exists), download remote → copy, upload local | **A8** |
| 3.6 | `pool.ts` (max 4) and `retry.ts` | Unit with fake timers |

### M4 — Download, finish, retries, log, status bar (2 days)

| # | Task | Tests |
|---|---|---|
| 4.1 | Download pass per 4.7, skipping `uploadedThisRun` and `application/vnd.google-apps.*` | **A5, A12** |
| 4.2 | Finish step: `lastSync = syncStart` only with zero failures; save folder map/IDs together | **A3, A9, A13** |
| 4.3 | Fault injection in fake Drive (network error on Nth call, 429, 5xx, 401) | **A9** (no duplicates, no false conflicts on rerun) |
| 4.4 | Progress counters → status bar; summary notices | Unit on text |
| 4.5 | `syncLog.ts`: ring buffer 500, file write, redaction test (token string never appears) | Unit |

### M5 — Acceptance, perf, docs, release (2–3 days)

| # | Task | Tests |
|---|---|---|
| 5.1 | Multi-device scenarios on the fakes: **A6** (offline edit, no back-dating), **A10** (edit during sync via a hook in the fake vault), **A11** (device clock −10 min / +10 min, rerun A5 + A6), **A14** (concurrent `Sync` calls) | All A1–A14 green in CI |
| 5.2 | **P1**: 2,000 files, nothing changed, fake Drive with 50 ms latency per call → must finish < 10 s; assert the number of HTTP calls is O(1), not O(files) | Perf test |
| 5.3 | Live smoke test script (manual, opt-in via env vars, never in CI): run A1/A3/A4/A5 against a real test Google account and a scratch vault | Checklist in `docs/TESTING.md` |
| 5.4 | **A15**: manual run of the checklist on iOS and Android | Signed-off checklist |
| 5.5 | README: install, refresh-token guide (§9, including the 7-day "Testing" expiry), what is/isn't synced, limitations (§12), security note (§10) | Review |
| 5.6 | Release: version bump script, GitHub release with `main.js`, `manifest.json`, `styles.css` (if any) | Installable via BRAT |

**Rough total:** ~11–13 working days for one developer.

## 6. Requirements traceability

| PRD | Where | Verified by |
|---|---|---|
| G1 one command | `main.ts` | Manual + A14 |
| G2 refresh token | `drive/auth.ts` | Unit, A13 |
| G3 `obsidian/<vault>` layout | `sync/folders.ts`, `remoteIndex.ts` | A1, A2, A7 |
| G4 / §6 watermarks | `engine.ts` finish step | A3, A9, A10, A11 |
| G5 no data loss | `upload.ts`, `download.ts`, `conflict.ts` | A6, A8, A9, A10 |
| G6 mobile | `requestUrl`, `spark-md5`, `VaultPort` binary APIs | A15 |
| §7.4 exclusions | `exclude.ts` | Unit |
| §7.6 log | `log/syncLog.ts` | Unit (incl. redaction) |
| §8 rate limits / concurrency | `retry.ts`, `pool.ts`, `drive/errors.ts` | Unit |
| R1 no back-dating | `drive/client.ts` | Request-body unit test, A6 |
| R3 MD5 before conflict | `upload.ts` | A9 |
| R5 incremental index | `remoteIndex.ts` | P1 call-count assertion |

## 7. Risks and open questions for the PRD owner

These came up while planning. Items marked **(recommend in v1)** are cheap and protect G5; the rest need a decision.

1. **Local edit during the download pass can be overwritten. (recommend in v1)**
   Step 4 checks a file, then the user edits it, then Step 5 downloads a newer remote version over it. Step 5 as written would silently overwrite the edit, which breaks G5 and A10.
   *Plan:* in Step 5, if `local.mtime > syncStart.local` and MD5 differs, treat it as a conflict (keep both) instead of overwriting. Already included in §4.7.

2. **Drive search may lag behind writes.**
   `files.list` with a `q` filter is backed by a search index that is not guaranteed to be immediately consistent. If device B uploads a file a moment before device A's `syncStart.remote` and the index hasn't caught up, A's query misses it, A moves `lastSync.remote` past it, and A never downloads it.
   *Proposal:* query with a safety overlap (`modifiedTime > lastSync.remote − 2 min`). To avoid false conflicts on the overlap, keep a small `recentRemote: { fileId: md5 }` list of items already handled in that window during the last successful run, and only treat an overlap item as "changed" if its md5 isn't in that list. Validate during M2 with a live spike before committing; the v2 Changes API (§12.6) removes this problem entirely.

3. **Config folder isn't always `.obsidian`. (recommend in v1)**
   Users can change it. Use `app.vault.configDir` for the exclusion and the log path instead of the hard-coded string.

4. **Skipped remote items must not block `lastSync`. (recommend in v1)**
   Invalid names, Google-native files and excluded paths are `SKIP`, not failures. Otherwise one bad file on Drive would make every sync "incomplete" forever.

5. **Duplicate file names in one Drive folder.** Drive allows them; the PRD only covers duplicate folders. *Plan:* same rule as folders — use the oldest, log a warning.

6. **First sync on a second device with existing, different local files** (e.g. a copied vault that has since diverged) will produce one conflict copy per differing file. This follows "keep both" but may surprise users; mention it in the README.

7. **Local `mtime` can be misleading.** Files copied into the vault by other tools may keep an old `mtime` and never be uploaded. Document as a limitation; v2 file index fixes it.

8. **Resumable upload through `requestUrl`.** It has no streaming or progress, so a > 5 MB file is sent in one `PUT`. Fine for notes and normal attachments; very large files (hundreds of MB) may hit memory limits on mobile. Consider a max file size setting later.

9. **Case-only conflicts on case-insensitive file systems** (§12.5): detect two remote items whose paths differ only by case, log both, download neither.

## 8. Definition of done (v1)

- A1–A14 and P1 pass in CI; A15 checklist signed off on one iOS and one Android device.
- Live smoke test passes against a real Google account.
- No `modifiedTime` in any outgoing request; no token or file content in any log line (both enforced by tests).
- README covers setup, refresh-token guide, limitations and security.
- Tagged GitHub release with `main.js` + `manifest.json`.
