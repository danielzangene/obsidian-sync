# Technical Design: Google Drive Sync for Obsidian

|                  |                                                                            |
| ---------------- | -------------------------------------------------------------------------- |
| **Status**       | Implemented in 0.1.0 (verification on real Drive and devices pending, §10) |
| **Version**      | 1.1                                                                        |
| **Last updated** | 2026-11-21                                                                 |
| **Authors**      | TBD                                                                        |
| **Reviewers**    | TBD                                                                        |
| **Implements**   | [PRD v1.4](PRD.md)                                                         |

This document describes **how** the plugin meets the [PRD](PRD.md). It doesn't restate requirements; it references them by ID (FR-, NFR-, AT-).

---

## 1. Context and scope

The plugin is a manual, one-command, two-way file sync between one Obsidian vault and one Google Drive folder (FR-2, FR-4). It runs inside Obsidian on desktop and mobile (NFR-3), so it can only use Obsidian's APIs for file and network access. There is no server component.

## 2. Terminology

| Term                  | Meaning                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------- |
| **Run**               | One execution of the Sync command.                                                       |
| **Sync index**        | Per-device record of every file as it was when this device last synced it (§4).          |
| **Base**              | The MD5 of a file's last synced version, taken from the sync index.                      |
| **Touched**           | A local file with no index entry, or whose modified time or size differs from its entry. |
| **Remote change set** | Remote files modified since the last successful run, keyed by vault-relative path.       |
| **Watermark**         | `lastSyncTime`: Google server time at the start of the last successful run.              |

## 3. Architecture

### 3.1 Layers

Ports-and-adapters (hexagonal) layout. The sync logic has no dependency on Obsidian or Google, so it is tested with in-memory fakes.

```
            ┌──────────────────────────────────────────────────┐
  ui/  ───▶ │ app/      SyncService: run lifecycle, passes     │
            │   │                                              │
            │   ▼                                              │
            │ domain/   decide(), exclusions, conflict name    │  pure, no I/O
            │   ▲                                              │
            │ ports/    LocalFiles · RemoteFiles · StateStore  │  interfaces only
            │           Clock · SyncLog · HttpTransport        │
            └───▲──────────────────────────────────────────────┘
                │ implements
  adapters/  obsidian/ (vault, plugin data, log, requestUrl) · google/ (OAuth, Drive) · system/ (clock)
  main.ts    composition root: builds adapters, injects them into SyncService
```

| Layer                | Responsibility                                                                             | May import                              |
| -------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------- |
| `domain/`            | Pure rules and types: decision rule, exclusions, conflict naming, paths, constants, errors | nothing                                 |
| `ports/`             | Interfaces the app and adapters depend on                                                  | `domain/`                               |
| `lib/`               | Generic utilities: MD5, concurrency pool, retry                                            | nothing                                 |
| `app/`               | Run lifecycle, upload and download passes, conflict resolution                             | `domain/`, `ports/`, `lib/`             |
| `adapters/google/`   | `RemoteFiles` on Drive v3; no Obsidian dependency                                          | `domain/`, `ports/`, `lib/`             |
| `adapters/obsidian/` | Vault files, plugin data, sync log, `requestUrl` transport                                 | `domain/`, `ports/`, `lib/`, `obsidian` |
| `ui/`                | Settings tab, progress indicator, report text                                              | `app/`, `domain/`, `ports/`, `obsidian` |
| `main.ts`            | Plugin entry; wires everything                                                             | everything                              |

These rules are enforced by ESLint `no-restricted-imports` per folder (`eslint.config.mjs`). Keeping the Google adapter free of Obsidian lets the acceptance tests run it unmodified against a fake Drive.

### 3.2 Ports

| Port            | Purpose                                                                                                      | Adapter                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `LocalFiles`    | List vault files with stat; fresh stat; read/write bytes (creating folders)                                  | `ObsidianLocalFiles` (Vault API)               |
| `RemoteFiles`   | Path-based view of the remote folder: `connect`, `listAll`, `listChangedSince`, `find`, `upload`, `download` | `GoogleDriveRemoteFiles`                       |
| `StateStore`    | The single in-memory copy of persisted data, shared by UI and sync; `save()`                                 | `PluginDataStateStore` (`loadData`/`saveData`) |
| `Clock`         | `now()`, `sleep()`                                                                                           | `SystemClock`                                  |
| `SyncLog`       | `record(action, path, reason)`; `flush()`                                                                    | `FileSyncLog`                                  |
| `HttpTransport` | Send one HTTP request; rejects only on network failure                                                       | `obsidianTransport` (`requestUrl`)             |

`RemoteFiles` is **path-based**. Mapping paths onto Drive's ID/parent graph (folder IDs, folder creation, vault folder resolution) is a Drive detail and stays inside the Google adapter. The app layer only sees paths, opaque remote IDs, MD5s and server timestamps.

### 3.3 Source layout

File names are kebab-case; one main export per file.

```
src/
  main.ts
  domain/   constants.ts  types.ts  errors.ts  decide.ts  exclusions.ts  conflict-name.ts  paths.ts
  ports/    local-files.ts  remote-files.ts  state-store.ts  clock.ts  sync-log.ts  http-transport.ts
  lib/      md5.ts  pool.ts  retry.ts
  app/      sync-service.ts  upload-pass.ts  download-pass.ts  conflict-resolver.ts  run-context.ts  sync-report.ts
  adapters/
    google/    google-drive-remote-files.ts  drive-api.ts  oauth-token-provider.ts  http-client.ts  drive-query.ts  drive-errors.ts
    obsidian/  obsidian-local-files.ts  obsidian-transport.ts  plugin-data-state-store.ts  persisted-data.ts  file-sync-log.ts
    system/    system-clock.ts
  ui/       settings-tab.ts  progress-indicator.ts  report-text.ts
tests/
  fakes/       fake-drive.ts (HTTP-level Drive)  memory-*.ts  sim-world.ts  device.ts
  unit/  acceptance/  perf/
```

## 4. Data model

### 4.1 Persisted state

Stored per device in the plugin's `data.json`, which lives in the config folder and is therefore never synced (FR-5). Secrets are not stored here: the settings hold only the **names** of entries in Obsidian's secret storage (NFR-5).

```json
{
  "schemaVersion": 1,
  "settings": {
    "clientId": "",
    "clientSecretName": "",
    "refreshTokenName": "",
    "remoteFolderName": ""
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

| Field                | Owner               | Meaning                                                                                                                     |
| -------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`      | `persisted-data.ts` | Version of this layout. Migrations go in `normalizePersistedData`.                                                          |
| `settings.*`         | `ui/`               | Client ID, secret-storage names of the client secret and refresh token, optional remote folder name (FR-1).                 |
| `state.lastSyncTime` | `app/`              | Watermark. `2000-01-01T00:00:00.000Z` (`EPOCH_ISO`) means never synced.                                                     |
| `state.fileIndex`    | `app/`              | Sync index: vault-relative path → `remoteId`, base `md5`, and the local `mtimeMs`/`size` recorded when the file was synced. |
| `state.driveCache`   | Google adapter      | Drive IDs of the vault folder and its subfolders, keyed by vault-relative path.                                             |

Missing or malformed fields fall back to defaults, so a damaged state file leads to a full (safe) sync, not an error.

### 4.2 Write rules

| What                        | When                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fileIndex`, `driveCache`   | Checkpoint every `INDEX_CHECKPOINT_INTERVAL` transfers and at the end of every run, successful or not. They record what was actually transferred. |
| `lastSyncTime`              | Only at the end of a run with zero failures, set to that run's `syncStartTime`. This is the single place it is written (`SyncService.execute`).   |
| `fileIndex`, `lastSyncTime` | Reset to defaults when `connect()` reports that the vault folder was replaced (FR-4); the adapter resets `driveCache` itself.                     |

### 4.3 Constants

All in `domain/constants.ts` unless noted.

| Name                               | Value                             |
| ---------------------------------- | --------------------------------- |
| `EPOCH_ISO`                        | `2000-01-01T00:00:00.000Z`        |
| `REMOTE_QUERY_OVERLAP_MS`          | 300 000 (5 min)                   |
| `MAX_CONCURRENT_TRANSFERS`         | 4                                 |
| `MAX_RETRIES`                      | 3 (4 attempts in total)           |
| `RESUMABLE_UPLOAD_THRESHOLD_BYTES` | 5 MiB                             |
| `MAX_FILE_SIZE_BYTES`              | 100 MiB (PRD OQ-4)                |
| `INDEX_CHECKPOINT_INTERVAL`        | 100 transfers                     |
| `LOG_MAX_LINES`                    | 500                               |
| `ROOT_FOLDER_NAME`                 | `obsidian`                        |
| `ID_BATCH_SIZE` (`drive-api.ts`)   | 100 pre-generated IDs per request |

## 5. Sync algorithm

### 5.1 Run lifecycle (`SyncService.run`)

1. **Lock.** If a run is active, return `already-running` (FR-2).
2. **Connect.** `remote.connect()` gets an access token (missing credentials or a rejected token abort the run, FR-3), reads `syncStartTime` from the first Google response, and resolves the vault folder (§6.3). If the folder was replaced, reset state (§4.2).
3. **Remote change set.** `lastSyncTime == EPOCH` → `remote.listAll()`; otherwise `remote.listChangedSince(lastSyncTime − REMOTE_QUERY_OVERLAP_MS)`.
4. **Upload pass** (§5.4).
5. **Download pass** (§5.5).
6. **Commit** (§4.2).
7. **Report.** Persist state, flush the log, release the lock (in `finally`). The UI turns the report into notices.

`syncStartTime` comes from Google's clock and is compared only with Drive `modifiedTime` values. Local changes are detected by stat comparison, not by time. So no device clock is ever compared with another clock (NFR-4). The HTTP `Date` header has 1-second precision; truncation makes the watermark slightly earlier, which is safe.

### 5.2 Change detection

- **Local:** a file is touched if it has no `fileIndex` entry, or its `mtimeMs` or `size` differs from the entry. Only touched files are hashed. The stat is taken **before** reading the bytes, so an edit during the read is seen as touched on the next run. After a download, the file's new stat is recorded.
- **Remote:** the remote change set from step 3. The overlap re-reads files already synced; they are no-ops because their MD5 equals the base. Right after a bulk upload this re-lists those files once.

### 5.3 Decision rule (`domain/decide.ts`)

`decide(localMd5?, remoteMd5?, baseMd5?) → SyncAction`. The first matching row wins.

| #   | Condition                            | Action                 | New base |
| --- | ------------------------------------ | ---------------------- | -------- |
| D1  | local only                           | `upload` (create)      | local    |
| D2  | remote only                          | `download` (create)    | remote   |
| D3  | local = remote                       | `none`                 | local    |
| D4  | local = base                         | `download` (overwrite) | remote   |
| D5  | remote = base                        | `upload` (update)      | local    |
| D6  | otherwise (both changed, or no base) | `conflict`             | local    |

D3 before D6 makes retries safe: content already equal on both sides is never a conflict (FR-9).

### 5.4 Upload pass (`app/upload-pass.ts`)

For each local file that is not excluded and is touched, with at most `MAX_CONCURRENT_TRANSFERS` in parallel:

1. Files over `MAX_FILE_SIZE_BYTES` are skipped and logged.
2. Hash it. If `local = base`, only refresh the stat in the index; a remote change, if any, is left to §5.5.
3. Find the remote counterpart: from the remote change set; else from the index (the file isn't in the change set, so remote = base); else `remote.find(path)`, so a new local file never creates a duplicate.
4. Apply `decide()` and mark the path as handled. Failed paths are also marked, so the download pass never overwrites a local file whose upload failed (NFR-1).

### 5.5 Download pass (`app/download-pass.ts`)

For each entry of the remote change set that wasn't handled in §5.4:

1. If `remote = base`, skip (no hashing needed).
2. If the local file is missing → D2. Otherwise hash it and apply `decide()`.
3. Downloads are verified against `md5Checksum`.
4. Before a D4 overwrite, re-stat the local file. If it changed since it was hashed and no longer matches its base, it becomes a conflict instead of being overwritten (NFR-1, AT-10).

### 5.6 Conflict resolution (`app/conflict-resolver.ts`)

1. Name the copy with `conflictCopyPath(path, remote.modifiedTimeMs)` → `<name> (conflict YYYY-MM-DD HHmm).<ext>` in local time. The name depends only on the remote version, so a retried run finds the copy it already wrote (same MD5) and reuses it. If a different file has that name, a counter is appended (` 2`, ` 3`, …).
2. Write the remote version to the copy. It is not indexed, so the next run uploads it as D1 and every device receives it (FR-8).
3. Upload the local version to the main file; the new base is the local MD5.

## 6. Google Drive integration

### 6.1 Endpoints

| Purpose               | Request                                                                                |
| --------------------- | -------------------------------------------------------------------------------------- |
| Access token          | `POST https://oauth2.googleapis.com/token` (`grant_type=refresh_token`)                |
| Query / list          | `GET /drive/v3/files?q=…&fields=…&pageSize=1000&pageToken=…&spaces=drive`              |
| Get metadata          | `GET /drive/v3/files/{id}?fields=…`                                                    |
| Pre-generate IDs      | `GET /drive/v3/files/generateIds?count=100&space=drive&type=files`                     |
| Create folder         | `POST /drive/v3/files` (metadata: `id`, `name`, `parents`, `mimeType`)                 |
| Create file ≤ 5 MiB   | `POST /upload/drive/v3/files?uploadType=multipart` (metadata: `id`, `name`, `parents`) |
| Update file ≤ 5 MiB   | `PATCH /upload/drive/v3/files/{id}?uploadType=media` (bytes only, no metadata)         |
| Create/update > 5 MiB | Same paths with `uploadType=resumable`; read `Location`; `PUT` the bytes               |
| Download              | `GET /drive/v3/files/{id}?alt=media`                                                   |

Requested fields: `id, name, mimeType, parents, createdTime, modifiedTime, md5Checksum, size, trashed`.

**The plugin never sends `modifiedTime`.** Google stamps server time, so a change can't be back-dated below another device's watermark (AT-06). Updates send bytes only, so this holds by construction; the fake Drive also rejects any request that contains it.

### 6.2 Remote change set

`listChangedSince(t)` runs one query, `modifiedTime > '<t RFC 3339>' and trashed = false`, across My Drive, then:

1. Adds result folders whose parent is a known folder ID to `folderIds`, repeating until nothing changes.
2. Keeps files whose parent is a known folder. Everything else is outside the vault and is ignored.
3. Skips Google-native types, excluded or invalid names, files over 100 MB and files without a checksum (FR-5), and reports them.
4. If two files map to the same path, keeps the oldest (`createdTime`) and warns.

`listAll()` walks the vault folder recursively, applying the same steps 3–4, and rebuilds `folderIds`.

### 6.3 Folder resolution and idempotency

- **Vault folder.** Use the cached `vaultFolderId` if it still exists, isn't trashed and has the expected name. Otherwise list root folders, match `obsidian` case-insensitively on the client, then match the remote folder name exactly inside it; create what's missing; pick the oldest of duplicates and warn. If the resulting ID differs from the cached one, `connect()` reports `vaultFolderReplaced`.
- **Subfolders.** `ensureFolder(path)` memoizes one in-flight promise per path per run, so parallel uploads create each folder once (AT-07). Cached folder IDs are validated once per run before use.
- **Stale IDs.** A cached file or folder ID that returns 404 or `trashed: true` is dropped and resolved again by path; an upload to a stale file ID becomes a create.
- **Idempotent creates.** Files and folders are created with IDs from `generateIds`. If a create fails (including when Drive applied it but the response was lost), the ID is looked up before retrying, so a retry can never create a duplicate (FR-9).
- **Query escaping.** `'` and `\` in names are escaped in `q` strings.

### 6.4 HTTP, auth and errors

- All calls go through the `HttpTransport` port; in Obsidian it is `requestUrl({ throw: false })` (CORS-safe on mobile). Header names are lower-cased.
- The access token is kept in memory only. On `401`, refresh once and retry. `invalid_grant` raises `AuthError`; `invalid_client` raises `AuthError` with a client-credentials message. Both stop the run before any file changes (FR-3, AT-13).
- Retried: network errors, `429`, `403` with reason `rateLimitExceeded` or `userRateLimitExceeded`, and `5xx`. Backoff: `random × min(8 s, 0.5 s × 2^attempt)` (full jitter), or `Retry-After` when present; up to `MAX_RETRIES`.
- Other `4xx` errors fail that file immediately. A failed file is logged, counted, and doesn't stop the other files (FR-9).

## 7. Cross-cutting concerns

| Concern               | Approach                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Security**          | Client secret and refresh token live in Obsidian's secret storage; `data.json` holds only their names. The `drive` scope grants full Drive access (PRD OQ-5): the token never leaves the device except to Google, is never logged, and the user owns the OAuth client and can revoke it. Network access only to `oauth2.googleapis.com` and `www.googleapis.com`. MD5 is a content checksum (Drive's `md5Checksum`), not a security control. |
| **Privacy / logging** | `SyncLog.record(action, path, reason)` is the only logging API, so file contents and tokens can't reach the log. Error messages carry only HTTP status and Google's error reason. No console output, no telemetry.                                                                                                                                                                                                                           |
| **Reliability**       | Idempotent passes (D3 first, stable conflict names, lookup before create, pre-generated IDs), checksum-verified downloads, state checkpoints, watermark advanced only on full success.                                                                                                                                                                                                                                                       |
| **Performance**       | An unchanged vault costs at most a token request, a vault folder check and one query; zero per-file calls and zero hashing (PT-01). Index size is about 130 B per file (≈ 260 KB for 2,000 files).                                                                                                                                                                                                                                           |
| **Compatibility**     | Only APIs available on mobile: `requestUrl`, Vault binary APIs, `normalizePath`, secret storage; pure-JS MD5 (`spark-md5`), since Web Crypto has no MD5. `minAppVersion` 1.13.2 (declarative settings with secret controls). `isDesktopOnly: false`.                                                                                                                                                                                         |

## 8. Testing strategy

| Level       | Scope                                                                                                                                                                        | Runs in                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Unit        | `domain/`, `lib/`, error classification, state normalization, UI text; `decide()` for every input combination                                                                | CI                                     |
| Acceptance  | AT-01 … AT-16 plus robustness scenarios: one or two simulated `Device`s (real `SyncService` and Google adapter, in-memory vault, own state and clock) sharing one fake Drive | CI                                     |
| Performance | PT-01: 2,000 files, 50 ms simulated latency per request; asserts < 10 s and at most 3 requests                                                                               | CI                                     |
| Contract    | The acceptance scenarios against real Drive, to keep the fake faithful                                                                                                       | Manual, M5 (credentials from env vars) |
| Device      | CT-01 checklist on iOS and Android                                                                                                                                           | Manual, per release                    |

The **fake Drive** is HTTP-level: it implements the OAuth token endpoint and the Drive v3 requests in §6.1 behind `HttpTransport`, so tests exercise the real Google adapter, including request building, multipart encoding and paging. It models a server clock independent of device clocks, `Date` headers, the `q` subset in §6.2 (unknown clauses fail the test), trash inheritance, fault injection (errors, dropped responses after the request was applied), and search lag. It rejects any request containing `modifiedTime`.

The safety mechanisms (re-check before overwrite, idempotent creates, folder memoization, query overlap, reset on folder replacement, D3, conflict-copy reuse) were each removed in turn to confirm a test fails.

## 9. Alternatives considered

| Alternative                                                          | Decision            | Reason                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Conflict = "changed locally and remotely since last sync" (PRD v1.1) | Rejected            | A downloaded file gets a new modified time, so the next remote edit was flagged as a conflict on every sync. Combined with download-after-failed-upload, a local edit could be lost. Replaced by the sync index and three-way rule (§5.3). |
| Local watermark on the device clock (v1.1 `lastSync.local`)          | Rejected            | Edits were missed after a clock was corrected backwards; redundant once the index exists.                                                                                                                                                  |
| Set remote `modifiedTime` to the local `mtime`                       | Rejected            | Back-dates files below other devices' watermarks; they'd never download them.                                                                                                                                                              |
| Walk the whole remote tree every run                                 | Rejected            | O(files) API calls; fails PT-01.                                                                                                                                                                                                           |
| On unknown parent, fall back to a full listing (v1.1)                | Rejected            | The query covers all of My Drive, so nearly every run would fall back.                                                                                                                                                                     |
| Conflict copy named after the current time                           | Rejected            | Retries created duplicate copies.                                                                                                                                                                                                          |
| Plain retries of create requests                                     | Rejected            | A create whose response is lost would be applied twice; pre-generated IDs make creates idempotent.                                                                                                                                         |
| Credentials in `data.json`                                           | Rejected            | Obsidian's secret storage keeps them out of the plugin's data file.                                                                                                                                                                        |
| Imperative settings tab (works from Obsidian 1.11.4)                 | Rejected            | The declarative API makes settings searchable and is what Obsidian's lint rules ask for; needs 1.13.2.                                                                                                                                     |
| Drive Changes API (`changes.list` + page token)                      | Deferred to v2      | Most robust remote tracking and enables deletion/rename sync, but v1 keeps the PRD's watermark model and smaller scope. Revisit if the search-lag spike fails (OQ-T2).                                                                     |
| `drive.file` scope                                                   | Deferred (PRD OQ-5) | Least privilege, but can't see files added outside the plugin.                                                                                                                                                                             |

## 10. Decisions and open questions

| ID    | Question                                                                          | Decision / next step                                                                                                                                 | Status   |
| ----- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| OQ-T1 | Where to store credentials, and which `minAppVersion`                             | Obsidian secret storage; `minAppVersion` 1.13.2                                                                                                      | Decided  |
| OQ-T2 | Is a 5-minute overlap enough to cover Drive search lag?                           | The mechanism is tested against simulated lag; measure real lag on a test account (PLAN M5) and raise the overlap or adopt the Changes API if needed | **Open** |
| OQ-T3 | Can `stat` after `modifyBinary` be trusted on iOS/Android (§5.2)?                 | Verify on devices (CT-01)                                                                                                                            | **Open** |
| OQ-T4 | Do the declarative settings and secret controls behave as typed in real Obsidian? | Only type-checked so far; verify in the manual smoke test                                                                                            | **Open** |
