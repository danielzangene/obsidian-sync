# Technical Design: Google Drive Sync for Obsidian

| | |
|---|---|
| **Status** | In review |
| **Version** | 1.0 |
| **Last updated** | 2026-11-21 |
| **Authors** | TBD |
| **Reviewers** | TBD |
| **Implements** | [PRD v1.3](PRD.md) |

This document describes **how** the plugin meets the [PRD](PRD.md). It doesn't restate requirements; it references them by ID (FR-, NFR-, AT-).

---

## 1. Context and scope

The plugin is a manual, one-command, two-way file sync between one Obsidian vault and one Google Drive folder (FR-2, FR-4). It runs inside Obsidian on desktop and mobile (NFR-3), so it can only use Obsidian's APIs for file and network access. There is no server component.

## 2. Terminology

| Term | Meaning |
|---|---|
| **Run** | One execution of the Sync command. |
| **Sync index** | Per-device record of every file as it was when this device last synced it (§4). |
| **Base** | The MD5 of a file's last synced version, taken from the sync index. |
| **Touched** | A local file with no index entry, or whose modified time or size differs from its entry. |
| **Remote change set** | Remote files modified since the last successful run, keyed by vault-relative path. |
| **Watermark** | `lastSyncTime`: Google server time at the start of the last successful run. |

## 3. Architecture

### 3.1 Layers

Ports-and-adapters (hexagonal) layout. The sync logic has no dependency on Obsidian or Google, so it can be tested with in-memory fakes.

```
            ┌───────────────────────────────────────────────┐
  ui/  ───▶ │ app/      SyncService: run lifecycle, passes  │
            │   │                                           │
            │   ▼                                           │
            │ domain/   decide(), exclusions, conflict name │  pure, no I/O
            │   ▲                                           │
            │ ports/    LocalFiles · RemoteFiles ·          │  interfaces only
            │           StateStore · Clock · SyncLog        │
            └───▲───────────────────────────────────────────┘
                │ implements
  adapters/  obsidian/ (vault, plugin data, log file) · google/ (OAuth, Drive) · system/ (clock)
  main.ts    composition root: builds adapters, injects them into SyncService
```

| Layer | Responsibility | May import |
|---|---|---|
| `domain/` | Pure rules: decision rule, exclusions, conflict naming, path helpers | nothing |
| `ports/` | Interfaces the app depends on | `domain/` types |
| `app/` | Run lifecycle, upload and download passes, run lock | `domain/`, `ports/`, `lib/` |
| `adapters/` | Port implementations on Obsidian, Google Drive, system clock | `ports/`, `domain/` types, `lib/`, `obsidian` |
| `ui/` | Settings tab, status bar, notices | `app/`, `obsidian` |
| `lib/` | Generic utilities: MD5, concurrency pool, retry | nothing |
| `main.ts` | Plugin entry; wires everything | everything |

These rules are enforced by ESLint `no-restricted-imports` per folder.

### 3.2 Ports

| Port | Purpose | Adapter |
|---|---|---|
| `LocalFiles` | List vault files with stat; read/write bytes; create folders | `ObsidianLocalFiles` (Vault API) |
| `RemoteFiles` | Path-based view of the remote folder: `connect`, `listAll`, `listChangedSince`, `find`, `upload`, `download` | `GoogleDriveRemoteFiles` |
| `StateStore` | Load/save persisted state (§4) | `PluginDataStateStore` (`loadData`/`saveData`) |
| `Clock` | `now()`, `sleep()` | `SystemClock` |
| `SyncLog` | `record(action, path, reason)`; `flush()` | `FileSyncLog` |

`RemoteFiles` is **path-based**. Mapping paths onto Drive's ID/parent graph (folder IDs, folder creation, vault folder resolution) is a Drive detail and stays inside the Google adapter. The app layer only sees paths, opaque remote IDs, MD5s and server timestamps.

### 3.3 Source layout

File names are kebab-case; one exported class or main function per file.

```
src/
  main.ts
  ui/        settings-tab.ts  status-bar.ts  notices.ts
  app/       sync-service.ts  upload-pass.ts  download-pass.ts  conflict-resolver.ts  run-lock.ts
  domain/    decide.ts  exclusions.ts  conflict-name.ts  paths.ts  types.ts  constants.ts
  ports/     local-files.ts  remote-files.ts  state-store.ts  clock.ts  sync-log.ts
  adapters/
    obsidian/  obsidian-local-files.ts  plugin-data-state-store.ts  file-sync-log.ts
    google/    http-client.ts  oauth-token-provider.ts  google-drive-remote-files.ts  drive-query.ts  drive-errors.ts
    system/    system-clock.ts
  lib/       md5.ts  pool.ts  retry.ts
tests/
  fakes/  unit/  acceptance/  contract/  perf/
```

## 4. Data model

### 4.1 Persisted state

Stored per device in the plugin's `data.json`, which lives in the config folder and is therefore never synced (FR-5, NFR-5).

```json
{
  "schemaVersion": 1,
  "settings": {
    "clientId": "",
    "clientSecret": "",
    "refreshToken": ""
  },
  "state": {
    "lastSyncTime": "2000-01-01T00:00:00.000Z",
    "fileIndex": {
      "notes/a.md": { "remoteId": "1AbC…", "md5": "9e10…", "mtimeMs": 1763719502123, "size": 2048 }
    },
    "driveCache": {
      "vaultFolderId": null,
      "folderIds": { "notes": "1XyZ…" }
    }
  }
}
```

| Field | Owner | Meaning |
|---|---|---|
| `schemaVersion` | `StateStore` | Version of this layout. Migrations run on load. |
| `settings.*` | `ui/` | User credentials (FR-1). |
| `state.lastSyncTime` | `app/` | Watermark. `2000-01-01T00:00:00.000Z` (`EPOCH`) means never synced. |
| `state.fileIndex` | `app/` | Sync index: vault-relative path → `remoteId`, base `md5`, and the local `mtimeMs`/`size` recorded when the file was synced. |
| `state.driveCache` | Google adapter | Drive IDs of the vault folder and its subfolders, keyed by vault-relative path. |

Missing or malformed fields fall back to defaults, so a damaged state file leads to a full (safe) sync, not an error.

### 4.2 Write rules

| What | When |
|---|---|
| `fileIndex`, `driveCache` | Checkpoint every `INDEX_CHECKPOINT_INTERVAL` transfers and at the end of every run, successful or not. They record what was actually transferred. |
| `lastSyncTime` | Only at the end of a run with zero failures, set to that run's `syncStartTime`. This is the single place it is written. |
| Everything except `settings` | Reset to defaults when the adapter reports that the vault folder was replaced (FR-4). |

### 4.3 Constants

| Name | Value |
|---|---|
| `EPOCH` | `2000-01-01T00:00:00.000Z` |
| `REMOTE_QUERY_OVERLAP_MS` | 300 000 (5 min) |
| `MAX_CONCURRENT_TRANSFERS` | 4 |
| `MAX_RETRIES` | 3 (4 attempts in total) |
| `RESUMABLE_UPLOAD_THRESHOLD_BYTES` | 5 MiB |
| `INDEX_CHECKPOINT_INTERVAL` | 100 transfers |
| `LOG_MAX_LINES` | 500 |

## 5. Sync algorithm

### 5.1 Run lifecycle (`SyncService.run`)

1. **Lock.** If a run is active, show "already running" and return (FR-2).
2. **Validate settings** (FR-3).
3. **Connect.** `remote.connect()` gets an access token, reads `syncStartTime` from the first Google response, and resolves the vault folder (§6.3). It returns `{ syncStartTime, vaultFolderReplaced }`. If the folder was replaced, reset state (§4.2).
4. **Remote change set.** `lastSyncTime == EPOCH` → `remote.listAll()`; otherwise `remote.listChangedSince(lastSyncTime − REMOTE_QUERY_OVERLAP_MS)`.
5. **Upload pass** (§5.4).
6. **Download pass** (§5.5).
7. **Commit** (§4.2).
8. **Report.** Notice, log flush, release lock. Steps 7–8 run in `finally`.

`syncStartTime` comes from Google's clock and is compared only with Drive `modifiedTime` values. Local changes are detected by stat comparison, not by time. So no device clock is ever compared with another clock (NFR-4). The HTTP `Date` header has 1-second precision; truncation makes the watermark slightly earlier, which is safe.

### 5.2 Change detection

- **Local:** a file is touched if it has no `fileIndex` entry, or its `mtimeMs` or `size` differs from the entry. Only touched files are hashed. The stat is taken **before** reading the bytes, so an edit during the read is seen as touched on the next run.
- **Remote:** the remote change set from step 4. The overlap re-reads a few files already synced; they are no-ops because their MD5 equals the base.

### 5.3 Decision rule (`domain/decide.ts`)

`decide(localMd5?, remoteMd5?, baseMd5?) → Action`. The first matching row wins.

| # | Condition | Action | New base |
|---|---|---|---|
| D1 | local only | `upload` (create) | local |
| D2 | remote only | `download` (create) | remote |
| D3 | local = remote | `none` | local |
| D4 | local = base | `download` (overwrite) | remote |
| D5 | remote = base | `upload` (update) | local |
| D6 | otherwise (both changed, or no base) | `conflict` | local |

D3 before D6 makes retries safe: content already equal on both sides is never a conflict (FR-9).

### 5.4 Upload pass (`app/upload-pass.ts`)

For each local file that is not excluded and is touched, with at most `MAX_CONCURRENT_TRANSFERS` in parallel:

1. Hash it. If `local = base`, only refresh the stat in the index; the file may still be downloaded in §5.5.
2. Find the remote counterpart: from the remote change set; else from the index (the file isn't in the change set, so remote = base); else `remote.find(path)`, so a new local file never creates a duplicate.
3. Apply `decide()`. Mark the path as handled.

### 5.5 Download pass (`app/download-pass.ts`)

For each entry of the remote change set that wasn't handled in §5.4 and isn't excluded:

1. If `remote = base`, skip (no hashing needed).
2. If the local file is missing → D2. Otherwise hash it and apply `decide()`.
3. Before a D4 overwrite, re-stat the local file. If the stat changed since it was hashed, re-hash and decide again; an edit made during the run becomes a conflict instead of being overwritten (NFR-1, AT-10).

### 5.6 Conflict resolution (`app/conflict-resolver.ts`)

1. Name the copy with `conflictName(path, remote.modifiedTime, localTimeZone)` → `<name> (conflict YYYY-MM-DD HHmm).<ext>`. The name depends only on the remote version, so a retried run finds the copy it already wrote (same MD5) and reuses it. If a different file has that name, append ` 2`, ` 3`, ….
2. Download the remote version into the copy. It is not indexed, so the next run uploads it as D1 and every device receives it (FR-8).
3. Upload the local version to the main file; the new base is the local MD5.

## 6. Google Drive integration

### 6.1 Endpoints

| Purpose | Request |
|---|---|
| Access token | `POST https://oauth2.googleapis.com/token` (`grant_type=refresh_token`) |
| Query / list | `GET /drive/v3/files?q=…&fields=…&pageSize=1000&pageToken=…` |
| Get metadata | `GET /drive/v3/files/{id}?fields=…` |
| Create folder | `POST /drive/v3/files` (metadata only) |
| Create file ≤ 5 MiB | `POST /upload/drive/v3/files?uploadType=multipart` (metadata: `name`, `parents`) |
| Update file ≤ 5 MiB | `PATCH /upload/drive/v3/files/{id}?uploadType=media` (bytes only, no metadata) |
| Create/update > 5 MiB | Same paths with `uploadType=resumable`; read `Location`; `PUT` the bytes |
| Download | `GET /drive/v3/files/{id}?alt=media` |

Requested fields: `nextPageToken, files(id, name, mimeType, parents, createdTime, modifiedTime, md5Checksum, trashed)`.

**The plugin never sends `modifiedTime`.** Google stamps server time, so a change can't be back-dated below another device's watermark (AT-06). Updates send bytes only, so this holds by construction; the fake Drive also rejects any request that contains it.

### 6.2 Remote change set

`listChangedSince(t)` runs one query, `modifiedTime > '<t RFC 3339>' and trashed = false`, across My Drive, then:

1. Adds result folders whose parent is a known folder ID to `folderIds`, repeating until nothing changes.
2. Keeps files whose parent is a known folder. Everything else is outside the vault and is ignored.
3. Skips Google-native types and names excluded by `domain/exclusions.ts` (FR-5), and reports them to the log.
4. If two files map to the same path, keeps the oldest (`createdTime`) and warns.

`listAll()` walks the vault folder recursively, applying the same steps 3–4.

### 6.3 Folder resolution

- **Vault folder.** Use the cached `vaultFolderId` if it still exists and isn't trashed. Otherwise list root folders, match `obsidian` case-insensitively on the client (independent of Drive's `name =` matching), then match the vault name exactly inside it; create what's missing; pick the oldest of duplicates and warn. If the resulting ID differs from the cached one, `connect()` reports `vaultFolderReplaced`.
- **Subfolders.** `ensureFolder(path)` memoizes one in-flight promise per path per run, so parallel uploads create each folder once (AT-07).
- **Stale IDs.** A cached file or folder ID that returns 404 or `trashed: true` is dropped and resolved again by path; an upload to a stale file ID becomes a create.
- **Query escaping.** `'` and `\` in names are escaped in `q` strings.

### 6.4 HTTP, auth and errors

- All calls go through `HttpClient` on Obsidian's `requestUrl({ throw: false })` (CORS-safe on mobile). Header names are lower-cased.
- The access token is kept in memory only. On `401`, refresh once and retry. `invalid_grant` raises `AuthError`, which stops the run before any file changes (FR-3, AT-13).
- Retried: network errors, `429`, `403` with reason `rateLimitExceeded` or `userRateLimitExceeded`, and `5xx`. Backoff: `min(8 s, 0.5 s × 2^attempt)` with full jitter, or `Retry-After` when present; up to `MAX_RETRIES`.
- Other `4xx` errors fail that file immediately. A failed file is logged, counted, and doesn't stop the other files (FR-9).

## 7. Cross-cutting concerns

| Concern | Approach |
|---|---|
| **Security** | Credentials live in `data.json` (plain text, disclosed in the UI; see OQ-T1). Network access only to `oauth2.googleapis.com` and `www.googleapis.com`. MD5 is used as a content checksum (Drive's `md5Checksum`), not for security. |
| **Privacy / logging** | `SyncLog.record(action, path, reason)` is the only logging API, so file contents and tokens can't reach the log. Error reasons come from HTTP status and Google `error.reason`, never from request bodies or headers. Nothing goes to the console in production builds. |
| **Reliability** | Idempotent passes (D3 first, stable conflict names, lookup before create), state checkpoints, watermark advanced only on full success. |
| **Performance** | An unchanged vault costs: token request, vault folder check, one query, zero per-file calls, zero hashing (PT-01). Index size is about 130 B per file (≈ 260 KB for 2,000 files). |
| **Compatibility** | Only Obsidian APIs available on mobile: `requestUrl`, Vault binary APIs, `normalizePath`; pure-JS MD5 (`spark-md5`), since Web Crypto has no MD5. Manifest `isDesktopOnly: false`. |

## 8. Testing strategy

| Level | Scope | Runs in |
|---|---|---|
| Unit | Every `domain/` and `lib/` module; `decide()` covered for every input combination | CI |
| Acceptance | AT-01 … AT-16 as scenarios: one or two simulated devices (fake vault + own state + own clock) sharing one fake Drive | CI |
| Contract | The same `RemoteFiles` test suite against the fake **and** the real Google adapter, so the fake stays faithful | Real Drive: manual, credentials from env vars |
| Performance | PT-01: 2,000 files, 50 ms simulated latency per call; assert < 10 s and a constant number of HTTP calls | CI |
| Device | CT-01 checklist on iOS and Android | Manual, per release |

The **fake Drive** models folders and files with MD5, its own server clock (offset from device clocks), `Date` headers, the query subset in §6.2, paging, fault injection (network error on the n-th call, 401, 429, 5xx) and optional search lag. It rejects requests containing `modifiedTime`.

## 9. Alternatives considered

| Alternative | Decision | Reason |
|---|---|---|
| Conflict = "changed locally and remotely since last sync" (PRD v1.1) | Rejected | A downloaded file gets a new modified time, so the next remote edit was flagged as a conflict on every sync. Combined with download-after-failed-upload, a local edit could be lost. Replaced by the sync index and three-way rule (§5.3). |
| Local watermark on the device clock (v1.1 `lastSync.local`) | Rejected | Edits were missed after a clock was corrected backwards; redundant once the index exists. |
| Set remote `modifiedTime` to the local `mtime` | Rejected | Back-dates files below other devices' watermarks; they'd never download them. |
| Walk the whole remote tree every run | Rejected | O(files) API calls; fails PT-01. |
| On unknown parent, fall back to a full listing (v1.1) | Rejected | The query covers all of My Drive, so nearly every run would fall back. |
| Conflict copy named after the current time | Rejected | Retries created duplicate copies. |
| Drive Changes API (`changes.list` + page token) | Deferred to v2 | Most robust remote tracking and enables deletion/rename sync, but v1 keeps the PRD's watermark model and smaller scope. Revisit if the M2 search-lag spike fails. |
| `drive.file` scope | Deferred (PRD OQ-5) | Least privilege, but can't see files added outside the plugin. |

## 10. Open questions

| ID | Question | Recommendation | Blocks |
|---|---|---|---|
| OQ-T1 | Store credentials with Obsidian's secret-storage API instead of plain `data.json`? Depends on which Obsidian version provides it on desktop and mobile, which also sets `minAppVersion`. | Verify the API and its minimum version; use it if it is available on current mobile releases | M1 |
| OQ-T2 | Is a 5-minute overlap enough to cover Drive search lag? | Measure in the M2 spike; raise the overlap or adopt the Changes API if not | M2 |
| OQ-T3 | Can `stat` after `modifyBinary` be trusted on iOS/Android (§5.2 relies on it)? | Verify on devices during M3, not only at release | M3 |
