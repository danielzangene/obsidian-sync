# PRD — Obsidian Google Drive Sync Plugin

| | |
|---|---|
| **Status** | v1.2 — engineering review of v1.1 (changes in §11) |
| **Date** | 2026-11-21 |
| **Plugin ID** | `gdrive-sync` (working name) |
| **Platforms** | Obsidian desktop + mobile |

This file replaces the Google Doc "PRD - Obsidian Google Drive Sync Plugin.md" (v1.1). How and when it gets built is in [PLAN.md](../PLAN.md).

---

## 1. Summary

An Obsidian plugin with one command, **Sync**, that syncs the current vault with `My Drive/obsidian/<vault name>/` using a Google OAuth refresh token. Each run uploads local changes, downloads remote changes, keeps both versions when a file changed on both sides, and moves the stored "last sync" time forward only when the whole run succeeds.

## 2. Problem

People who use Obsidian on several devices need their notes in sync. Obsidian Sync is paid, and most alternatives need a desktop client or a complicated setup. Many users already have Google Drive and want a manual, one-button sync that keeps their notes as plain files in their own Drive.

## 3. Goals and non-goals

**Goals**

- **G1 — One command.** `Sync` is the only command. Nothing runs in the background.
- **G2 — Refresh-token auth.** The user pastes Client ID, Client Secret and Refresh Token once. No browser sign-in inside Obsidian.
- **G3 — Plain mirror.** Remote layout is `My Drive/obsidian/<vault name>/…`, mirroring the vault's folders. The plugin creates the folders on first use.
- **G4 — Incremental.** Only changes since the last successful sync are transferred. The first sync transfers everything.
- **G5 — No silent data loss.** A file changed on both sides keeps both versions. A failed run is finished by simply running Sync again.
- **G6 — Desktop and mobile.**
- **G7 — Visible.** Every run reports what it uploaded, downloaded, skipped, conflicted and failed.

**Non-goals (v1)**

- Automatic or scheduled sync.
- Syncing deletions or renames (§10).
- Syncing the Obsidian config folder.
- Merging text inside a file.
- Google Docs/Sheets/other Google-native files (skipped).
- Shared Drives.

## 4. Sync model

### 4.1 Stored state

Per device, in the plugin's `data.json` (`loadData` / `saveData`). It lives inside the config folder, so it is never synced.

```json
{
  "clientId": "",
  "clientSecret": "",
  "refreshToken": "",
  "lastSync": "2000-01-01T00:00:00.000Z",
  "vaultFolderId": null,
  "folders": {},
  "files": {}
}
```

| Field | Meaning |
|---|---|
| `lastSync` | **Google server time** at the start of the last fully successful run. Default `2000-01-01T00:00:00.000Z` = never synced. |
| `vaultFolderId` | Drive ID of `obsidian/<vault name>`. |
| `folders` | `relative folder path → Drive folder ID` for every synced subfolder. |
| `files` | The **index**: `relative path → { id, md5, mtime, size }` for every file as it was the last time this device synced it. `md5` is the **base** version for conflict detection; `mtime`/`size` are the local stat recorded at that moment. |

Missing fields fall back to these defaults. Any cached Drive ID that turns out to be missing or trashed is dropped and looked up again by path (created if needed).

### 4.2 Change detection

- **Local:** a file is *touched* if it has no index entry, or its current `mtime` or `size` differs from the entry. Only touched files are hashed. No clock comparison is involved, so a wrong or corrected device clock doesn't matter.
- **Remote:** files whose Drive `modifiedTime` is after `lastSync` minus a **5-minute overlap**. Both values come from Google's clock. The overlap covers Drive search results that lag slightly behind writes; files seen twice are no-ops because of the index.

### 4.3 Decision rule

For one path, with **L** = MD5 of the local file, **R** = Drive `md5Checksum`, **B** = base MD5 from the index:

| # | Situation | Action | New base |
|---|---|---|---|
| D1 | Only local exists | Upload (create) | L |
| D2 | Only remote exists | Download (create) | R |
| D3 | L = R | Nothing | L |
| D4 | L = B (only remote changed) | Download (overwrite) | R |
| D5 | R = B (only local changed) | Upload (update) | L |
| D6 | Anything else (both changed, or no base) | Conflict (§5.3) | L |

Rows are checked in order. D3 before D6 means a retried run never reports false conflicts.

### 4.4 `lastSync` rule

- At the start of each run, `syncStart` = the `Date` header of the first Google response in the run. If it can't be read, the run fails.
- **Run succeeds** (every file processed, zero failures) → `lastSync = syncStart`. This happens on every successful run, including runs that transferred nothing.
- **Anything fails** (auth, network, any file still failing after retries, Obsidian closed mid-run) → `lastSync` is unchanged and the next run redoes the work.
- The **start** time is used, not the end time, so a remote change made during a run is picked up by the next one.
- `folders` and `files` are saved at the end of **every** run, successful or not, because they describe what was actually transferred. That is what makes re-running safe.

### 4.5 Guarantees

- Running Sync twice in a row, or again after a failure, never creates duplicates or false conflicts and never loses data.
- A local file is only overwritten when it still matches its base (D4). Anything else becomes a conflict.
- The plugin never sets a remote `modifiedTime`. Google stamps server time, so other devices can't miss a change because it was back-dated.

## 5. Functional requirements

### 5.1 Settings tab

| Setting | Type | Notes |
|---|---|---|
| Client ID | text | |
| Client Secret | password field | |
| Refresh Token | password field | |
| Last successful sync | read-only | `lastSync` in the user's local time, or "Never" |

A short warning says the refresh token is stored in plain text on this device (§7).

### 5.2 The `Sync` command

Command ID `sync`, name `Sync`. A ribbon icon runs the same command. Only one run at a time; pressing Sync during a run shows "Sync already running" and does nothing.

1. **Check.** If Client ID, Client Secret or Refresh Token is empty → notice, stop.
2. **Token and start time.** `POST https://oauth2.googleapis.com/token` with `grant_type=refresh_token`. Keep the access token in memory only. On `invalid_grant` → notice "Refresh token is invalid or revoked", stop. Record `syncStart` (§4.4).
3. **Vault folder.** Use `vaultFolderId` if it is still valid. Otherwise find the folder named `obsidian` in My Drive root (**case-insensitive**, so an existing `Obsidian` is reused) and, inside it, the folder named exactly the vault name. Create either one if missing. If several match, use the oldest (`createdTime`) and show a warning. **If the vault folder ID differs from the cached one, reset `lastSync`, `folders` and `files` to defaults** so the run is a full sync.
4. **Remote changes.**
   - If `lastSync` is the default: list the vault folder tree recursively.
   - Otherwise: run one query, `modifiedTime > '<lastSync − 5 min>' and trashed = false`, across My Drive. Resolve each result's path through `folders`: add result folders whose parent is known, repeat until nothing new resolves, then ignore every item whose parent is still unknown (it is outside the vault).
   - If two remote files map to the same path, use the oldest and show a warning.
   - Result: `remoteChanged` = `path → { id, md5Checksum, modifiedTime }`.
5. **Upload pass.** For each touched local file (§4.2) that isn't excluded (§5.4):
   - L = B (content unchanged) → just update the index stat. The file may still be downloaded in step 6.
   - Otherwise get R: from `remoteChanged`; else from the index (remote unchanged, so R = B); else look up the path on Drive to avoid creating a duplicate.
   - Apply §4.3 (D1, D3, D5, D6). Create missing remote folders; each folder is created only once per run, even with parallel uploads.
6. **Download pass.** For each file in `remoteChanged` that wasn't handled in step 5:
   - Skip Google-native types, excluded paths and invalid names (§5.4).
   - R = B → nothing to do.
   - Otherwise apply §4.3 (D2, D3, D4, D6). Right before overwriting, re-check that the local file still matches its base. If it was edited in the meantime, it is a conflict.
7. **Finish.** Save `folders` and `files`. If no file failed, set `lastSync = syncStart` and save. Show the summary notice (§5.6).

### 5.3 Conflicts

1. Save the remote version next to the file as `<name> (conflict YYYY-MM-DD HHmm).<ext>`, using the remote `modifiedTime` in local time. The name depends only on the remote version, so a retried run reuses the same copy. If a different file already has that name, add ` 2`, ` 3`, ….
2. Upload the local version as the main file.
3. Count it in the summary. The user merges by hand. The conflict copy is a normal file and is uploaded on the next sync, so every device sees it.

### 5.4 What is synced

Everything in the vault except:

- any path with a file or folder name starting with `.` (covers the config folder, `.trash/`, `.git/`, `.DS_Store`);
- `Thumbs.db`;
- Google-native files (`application/vnd.google-apps.*`);
- remote items whose names Obsidian can't use (containing any of `* " \ / < > : | ?`).

Skipped items are logged and **do not count as failures**.

### 5.5 Errors and retries

- Network errors, `429`, `403 rateLimitExceeded`/`userRateLimitExceeded` and `5xx` are retried up to 3 times with exponential backoff and jitter.
- `401` → get a new access token once and retry.
- A file that still fails is recorded as failed; the run continues with the other files and ends "incomplete".
- At most 4 transfers run at once.

### 5.6 Feedback

- **Status bar** during a run: `Syncing… ↑3/10 ↓1/4`.
- **Notices:** `Sync done — ↑4 ↓2 ⚠1 conflict`, `Sync incomplete — 2 files failed, run Sync again`, plus the stop/warning messages above.
- **Log:** the last 500 lines in `sync.log` inside the plugin's folder (never synced). One line per action: time, `UPLOAD` / `DOWNLOAD` / `SKIP` / `CONFLICT` / `ERROR`, path, reason. Never tokens or file contents.

## 6. Technical constraints

- **HTTP:** Obsidian `requestUrl()`, not `fetch`, to avoid CORS on desktop and mobile.
- **API:** Google Drive API v3. Multipart upload up to 5 MB, resumable above.
- **Scope:** `https://www.googleapis.com/auth/drive`. `drive.file` can't see an `obsidian` folder the user created.
- **Times:** compared as UTC milliseconds; RFC 3339 in Drive queries.
- **File I/O:** `app.vault` binary APIs (`readBinary`, `createBinary`, `modifyBinary`, `createFolder`).
- **Hashing:** MD5 in pure JS (e.g. `spark-md5`); Web Crypto has no MD5.
- **Manifest:** `isDesktopOnly: false`.

## 7. Security

- The refresh token gives full Drive access and is stored in plain text in `data.json`. The settings tab says so.
- `data.json` lives in the config folder, which is never synced, so the token never reaches Drive.
- Tokens and file contents never go to the console or the log.

## 8. Getting a refresh token (for the README)

1. In Google Cloud Console, create a project and enable the **Google Drive API**.
2. Configure the OAuth consent screen and add your account as a test user.
3. Create an **OAuth client ID** of type **Web application** with the authorized redirect URI `https://developers.google.com/oauthplayground`. Copy the Client ID and Client Secret.
4. In the OAuth 2.0 Playground, open the gear icon, tick "Use your own OAuth credentials", enter them, authorize scope `https://www.googleapis.com/auth/drive`, and exchange the code for a refresh token.
5. Paste the three values into the plugin settings.

While the consent screen is in "Testing", Google expires refresh tokens after 7 days. Set it to "In production" for a long-lived token; Google then shows an "unverified app" warning during step 4, which is expected for a personal client.

## 9. Acceptance tests

| # | Scenario | Expected |
|---|---|---|
| A1 | First sync, no `obsidian/` folder | `obsidian/<vault>` created; all files uploaded; `lastSync` set |
| A2 | First sync, `Obsidian/` already exists | Existing folder reused; no duplicate |
| A3 | Second sync, no changes | 0 up, 0 down; `lastSync` = this run's start |
| A4 | Edit one note, sync | Exactly 1 upload |
| A5 | Edit on B, sync B, then sync A | A downloads exactly that file |
| A6 | B edits offline Monday, A syncs Tuesday, B syncs Wednesday, A syncs Thursday | A gets B's edit (no back-dating) |
| A7 | New `a/b/c.md` and `a/b/d.md` in one run | Remote `a/` and `a/b/` created once each; both uploaded |
| A8 | Same note edited on both devices | Conflict copy created; both versions kept |
| A9 | Network drops mid-sync | "Sync incomplete"; `lastSync` unchanged; next sync finishes with no duplicates and no conflicts |
| A10 | Note edited during a sync, both during the upload pass and right before its download | Edit kept (conflict copy if needed) and uploaded next sync |
| A11 | Device clock 10 minutes wrong, and clock corrected between syncs | A4, A5, A6 still pass |
| A12 | A downloads B's edit; B edits the same note again; A syncs | A downloads it; no upload, no conflict |
| A13 | Revoked refresh token | Clear notice; nothing changed; `lastSync` unchanged |
| A14 | Sync pressed twice quickly | Second run refused |
| A15 | Vault folder trashed in Drive, then Sync | Folder recreated; whole vault uploaded |
| A16 | Remote Google Doc and a remote file named `a:b.md` | Both skipped and logged; run reports "done" |
| P1 | 2,000 notes, nothing changed | Finishes in under 10 s on desktop |
| P2 | iOS and Android | A1–A16 pass |

## 10. Known limitations

1. **Deletions don't sync.** A note deleted on one device stays on Drive and on other devices, and comes back on a device that deleted it if the Drive copy changes.
2. **Renames and moves** look like a new file; the old path stays.
3. **Conflicts always keep both.** A "local wins / remote wins" setting can come later.
4. **Case-only name differences** (`Note.md` vs `note.md`) can clash on case-insensitive file systems. Logged, not resolved.
5. **Obsidian closed mid-sync:** the index for that run isn't saved, so the next run may create an unnecessary conflict copy. No data is lost.
6. **Local detection uses `mtime` + `size`.** A tool that changes content but keeps both unchanged isn't detected.
7. **v2:** switch the remote side to the Drive Changes API (`changes.list` with a saved page token). It enables deletion and rename sync and removes the need for the 5-minute overlap.

## 11. Changelog v1.1 → v1.2

| # | Finding in v1.1 | Severity | Change |
|---|---|---|---|
| C1 | If a conflicted file's upload failed, step 5 downloaded the remote version over the local edit; the conflict copy also held the remote version, so the local edit was lost. Step 5 also overwrote notes edited during the run. | **Critical (data loss)** | Download only overwrites a file that still matches its base (D4); otherwise conflict. Files handled in the upload pass are skipped (§5.2 steps 5–6, A10). |
| C2 | Conflicts were "local changed since lastSync and remote changed since lastSync". A file downloaded in one run had a new `mtime`, so if the other device edited it again it was reported as a conflict on every sync. | High | Per-file index with a base MD5; three-way decision rule (§4.3, A12). |
| C3 | The incremental query covers all of My Drive, so almost every result has a parent outside the folder map. The "unknown parent → full listing" fallback would run on nearly every sync. | High | Resolve new folders until stable, then ignore unknown parents (§5.2 step 4). |
| C4 | If the vault folder was trashed and recreated, incremental sync never re-uploaded files that hadn't changed. | High | Reset state when the vault folder ID changes; drop stale cached IDs everywhere (§4.1, §5.2 step 3, A15). |
| C5 | `lastSync.local` broke when a device clock was corrected backwards (edits in between were never uploaded). With the index it is redundant. | Medium | Local side compares `mtime`/`size` with the index; one `lastSync` on Google's clock (§4.2, A11). |
| C6 | Parallel uploads into the same new folder could create duplicate Drive folders. | Medium | Each folder created once per run (A7). |
| C7 | Refresh-token guide said "Desktop app" client; the OAuth Playground needs its own redirect URI, which only a "Web application" client allows. | Medium | Guide fixed (§8). |
| C8 | Drive search can lag behind writes; a change made just before `syncStart` could be missed for good. | Medium | 5-minute overlap; re-seen files are no-ops (§4.2). |
| C9 | Conflict copy named after the current time, so a retried run created a second copy. | Low | Named after the remote `modifiedTime` (§5.3). |
| C10 | Exclusion list hard-coded `.obsidian/`, which users can rename. | Low | Exclude any name starting with `.` (§5.4). |
| C11 | Same rules repeated in several sections (lastSync, retries, idempotency); user stories duplicated goals; milestones duplicated the plan; `rootFolderId` unused after setup. | Editorial | Each rule stated once; stories folded into goals (G7 added); milestones moved to PLAN.md; `rootFolderId` removed. |
