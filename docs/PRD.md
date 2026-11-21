# PRD — Obsidian Google Drive Sync Plugin

> Source of truth: the Google Doc "PRD - Obsidian Google Drive Sync Plugin.md" (Final v1.1).
> This is a copy kept next to the code for reference. If the two disagree, the Google Doc wins.

| | |
|---|---|
| **Status** | **Final v1.1** (reviewed) |
| **Date** | 2026-11-21 |
| **Plugin ID** | `gdrive-sync` (working name) |
| **Platforms** | Obsidian desktop + mobile |

---

## 1. Summary

An Obsidian plugin that syncs the current vault with Google Drive using a Google account **refresh token**. It has exactly **one command: `Sync`**. Each run:

1. Makes sure the remote folder `obsidian/<vault name>` exists (and creates it on the first connection).
2. **Uploads** every local file changed since the last successful sync.
3. **Downloads** every remote file changed since the last successful sync.
4. **Saves the new "last sync" time — on every successful sync, and only then.**

On the very first run, "last sync" is **2000-01-01T00:00:00Z**, so everything is uploaded and downloaded once.

## 2. Problem

People who use Obsidian on several devices need their notes in sync. Obsidian Sync costs money, and most third-party options need a desktop client or a complicated setup. Many users already have Google Drive. They want a simple, manual, one-button sync that keeps their notes as plain files in their own Drive.

## 3. Goals

- **G1:** One command (`Sync`). No background magic, no extra commands.
- **G2:** Authentication with a Google OAuth **refresh token** (no browser sign-in inside Obsidian).
- **G3:** Remote layout is always `My Drive/obsidian/<vault name>/…`, mirroring the vault's folder tree.
- **G4:** Incremental sync based on a stored "last sync" time. The first run uses `2000-01-01T00:00:00Z`.
- **G5:** **No silent data loss, ever.** If a file changed on both sides, both versions are kept. If a run fails, the next run redoes the work.
- **G6:** Works on desktop and mobile.

## 4. Non-goals (v1)

- Automatic or scheduled sync (on save, on startup, on a timer).
- Syncing deletions or renames (see §12).
- Syncing the `.obsidian/` config folder.
- Merging text inside a file.
- Google Docs/Sheets native files (they are skipped).
- Shared Drives.

## 5. Users and stories

- **US1:** As a user, I paste my Client ID, Client Secret and Refresh Token into the settings once and can sync from then on.
- **US2:** As a user, I run **Sync** on a new vault and the plugin creates `obsidian/<vault name>` in my Drive for me.
- **US3:** As a user, I edit notes on my laptop, run **Sync**, then run **Sync** on my phone and get the changes.
- **US4:** As a user, I see what happened: files uploaded, downloaded, conflicts, errors.
- **US5:** As a user, if I edited the same note on two devices, I get both versions and nothing is lost.
- **US6:** As a user, if sync fails halfway (bad network), I just run **Sync** again and it finishes the job.

## 6. The "last sync" time (core rule)

### 6.1 What is stored

The device compares two different clocks, so it stores **two** watermarks taken at the same moment:

| Field | Clock | Used for |
|---|---|---|
| `lastSync.local` | This device's clock | Comparing with local file `mtime` (upload side) |
| `lastSync.remote` | Google's server clock | Comparing with Drive `modifiedTime` (download side) |

Both default to **`2000-01-01T00:00:00.000Z`**.

Why two: a phone whose clock is 5 minutes off would otherwise miss or repeat changes. Local files are compared with the local clock, and Drive files with Google's clock, so clock drift between devices doesn't matter.

### 6.2 When it changes

- At the **start** of each run, the plugin records `syncStart.local = Date.now()` and `syncStart.remote` = the `Date` header of the first Google API response in the run.
- **If the run succeeds** (every file processed, zero failures): `lastSync = syncStart` and plugin data is saved. **This happens on every successful sync.**
- **If anything fails** (auth error, network error, any single file still failing after retries, Obsidian closed mid-run): `lastSync` is **not changed**. The next run starts from the same point and redoes the work. This is safe because every step is idempotent (§7.5).

### 6.3 Why the *start* time and not the end time

If a note is edited *while* a sync is running (on this device or another one), its change time is after `syncStart`. The next sync picks it up. Using the end time would skip that edit forever.

## 7. Functional requirements

### 7.1 Settings tab

| Setting | Type | Notes |
|---|---|---|
| Client ID | text | Google OAuth client ID |
| Client Secret | password field | Google OAuth client secret |
| Refresh Token | password field | Long-lived refresh token |
| Last successful sync | read-only text | Shows `lastSync.local` in the user's local time, or "Never" |

The settings tab shows a short warning that the refresh token is stored in plain text on this device (§10).

### 7.2 The `Sync` command

- **Command ID:** `sync`, **name:** `Sync`. Also triggered by a ribbon icon (same action, not a second command).
- Only one sync at a time. A second **Sync** while one is running shows "Sync already running" and does nothing.
- While running, the status bar shows `Syncing… ↑3/10 ↓1/4`.

**Step 0 — Check**
- If Client ID, Client Secret or Refresh Token is empty → notice, stop.

**Step 1 — Get an access token**
- `POST https://oauth2.googleapis.com/token` with `grant_type=refresh_token`, `client_id`, `client_secret`, `refresh_token`.
- Keep the access token in memory only. Get a new one if a call returns `401`.
- On `invalid_grant` → notice "Refresh token is invalid or revoked", stop.
- Record `syncStart.local` and `syncStart.remote` (§6.2).

**Step 2 — Resolve or create the remote folders (first connection)**
- Find a folder named `obsidian` in My Drive root (`'root' in parents`, folder mime type, not trashed). Match **case-insensitively**, so an existing `Obsidian` folder is reused. If none exists, create `obsidian`.
- Inside it, find a folder named exactly the vault name (`app.vault.getName()`). If none exists, create it.
- If more than one match exists (for example two devices created it at the same time), use the **oldest** (`createdTime`) and show a warning.
- Cache both folder IDs in plugin data. If a cached ID is missing or trashed, search again.

**Step 3 — Build the remote index**
- **First sync** (`lastSync.remote` = 2000-01-01): list the whole vault folder tree recursively and cache a **folder map** (`folderId → relative path`) in plugin data.
- **Later syncs**: run **one** query instead of walking the tree:
  `modifiedTime > '<lastSync.remote>' and trashed = false`
  then keep only items whose parent is in the folder map. New folders show up in this query too and are added to the map. If a result's parent is unknown, fall back to a full recursive listing.
- Request fields: `id, name, mimeType, parents, modifiedTime, md5Checksum, size`.
- Result: `remoteChanged` = remote files changed since `lastSync.remote`, each with its relative path.

**Step 4 — Upload local changes**
- Go through every vault file (`app.vault.getFiles()`), skipping excluded paths (§7.4).
- A file is a candidate when `file.stat.mtime > lastSync.local`.
- For each candidate, in this order:
  1. Find the remote file at the same path (create missing remote subfolders).
  2. **No remote file** → create it.
  3. **Same content** (MD5 of local bytes = remote `md5Checksum`) → skip. *This check must come before the conflict check, otherwise a retried sync reports false conflicts.*
  4. **Remote file is also in `remoteChanged`** → **conflict** (§7.3).
  5. **Otherwise** → update the remote file's content.
- **Do not set the remote `modifiedTime` yourself.** Let Google stamp it with server time. (Setting it to the local `mtime` would back-date the file, and other devices whose `lastSync.remote` is already later would never download it.)
- Files over 5 MB use resumable upload, smaller ones multipart upload.
- Add each uploaded file ID to `uploadedThisRun`.

**Step 5 — Download remote changes**
- For each file in `remoteChanged` that is **not** in `uploadedThisRun` and not a Google-native type (`application/vnd.google-apps.*`):
  1. Local file missing → create it (and missing local folders).
  2. Local MD5 = remote `md5Checksum` → skip.
  3. Otherwise → overwrite the local file with `app.vault.modifyBinary`.
- Downloaded files get a new local `mtime`, so the next sync sees them as candidates in Step 4. Step 4.3 (same MD5) skips them. No extra state is needed.

**Step 6 — Finish**
- Each failed file is retried up to 3 times with exponential backoff.
- **All files OK** → `lastSync = syncStart`, save plugin data, notice `Sync done — ↑4 ↓2 ⚠1 conflict`.
- **Any file failed** → keep the old `lastSync`, notice `Sync incomplete — 2 files failed, run Sync again`, and list the failed paths in the log (§7.6).

### 7.3 Conflicts

A conflict is a file changed locally **and** remotely since the last sync, with different content.

- Download the remote version to `<name> (conflict YYYY-MM-DD HHmm).<ext>` in the same folder.
- Upload the local version as the main file.
- Count it in the summary notice. The user merges by hand.
- The conflict copy is a normal file and gets uploaded on the next sync, so every device sees it.

### 7.4 Excluded paths

Never uploaded or downloaded:

- `.obsidian/` (config, plugins, and this plugin's `data.json` with the refresh token)
- `.trash/`, `.git/`
- `.DS_Store`, `Thumbs.db`
- Any remote item whose name contains `/` or `\` or isn't a valid local file name (skipped and logged)

### 7.5 Idempotency (why retrying is always safe)

Running **Sync** twice in a row, or re-running after a failure, must never duplicate or lose data:

- Uploads look up the existing remote file first, so they update instead of creating duplicates.
- The MD5 check skips files that are already the same on both sides.
- `lastSync` moves forward only after a fully successful run.

### 7.6 Log

- The last 500 lines of sync activity are kept in `.obsidian/plugins/gdrive-sync/sync.log` (never synced).
- One line per action: time, `UPLOAD` / `DOWNLOAD` / `SKIP` / `CONFLICT` / `ERROR`, path, reason.
- No tokens and no file contents in the log.

### 7.7 Stored state (`data.json` via `loadData` / `saveData`)

```json
{
  "clientId": "",
  "clientSecret": "",
  "refreshToken": "",
  "lastSync": {
    "local": "2000-01-01T00:00:00.000Z",
    "remote": "2000-01-01T00:00:00.000Z"
  },
  "rootFolderId": null,
  "vaultFolderId": null,
  "folderMap": {}
}
```

- Missing fields fall back to these defaults, so the first sync is always a full sync.
- The file is per device (inside `.obsidian/`) and never synced, so each device keeps its own `lastSync`.

## 8. Technical notes

- **HTTP:** Use Obsidian's `requestUrl()` (not `fetch`) to avoid CORS problems on desktop and mobile. Read the `Date` response header for `syncStart.remote`.
- **API:** Google Drive API v3 (`/drive/v3`, `/upload/drive/v3`).
- **OAuth scope:** `https://www.googleapis.com/auth/drive`. The narrower `drive.file` scope only sees files the app created, so it can't find an `obsidian` folder the user created.
- **Times:** All comparisons in UTC milliseconds. Drive query times in RFC 3339.
- **File I/O:** `app.vault.readBinary` / `createBinary` / `modifyBinary`, `app.vault.createFolder`.
- **Hashing:** MD5 in pure JS (for example `spark-md5`), since Web Crypto has no MD5. Hash only candidate files, not the whole vault.
- **Rate limits:** On `403 rateLimitExceeded` / `429` / `5xx`, exponential backoff with jitter. At most 4 transfers at once.
- **Manifest:** `isDesktopOnly: false`.

## 9. Getting a refresh token (for the README)

1. In Google Cloud Console, create a project and turn on the **Google Drive API**.
2. Set up the OAuth consent screen and add your Google account as a test user.
3. Create an **OAuth client ID** (type "Desktop app"). Copy the Client ID and Client Secret.
4. Get a refresh token with scope `https://www.googleapis.com/auth/drive`, for example in the OAuth 2.0 Playground (gear icon → "Use your own OAuth credentials").
5. Paste the three values into the plugin settings.

Note: while the consent screen is in "Testing" mode, Google expires refresh tokens after 7 days. Move the app to "In production" for a long-lived token.

## 10. Security

- The refresh token gives full Drive access and is stored in plain text in `data.json` on each device. The settings tab says so.
- `.obsidian/` is always excluded, so the token never goes to Drive.
- Tokens and file contents are never written to the console or the log.

## 11. Acceptance tests

| # | Scenario | Expected |
|---|---|---|
| A1 | First sync, no `obsidian/` folder | `obsidian/<vault>` created; all files uploaded; `lastSync` set |
| A2 | First sync, `Obsidian/` already exists | Existing folder reused; no duplicate |
| A3 | Second sync, no changes | 0 up, 0 down; **`lastSync` updated to this run's start time** |
| A4 | Edit one note, sync | Exactly 1 upload; `lastSync` updated |
| A5 | Edit on device B, sync B, then sync A | A downloads exactly that file |
| A6 | Device B edits offline Monday, A syncs Tuesday, B syncs Wednesday, A syncs Thursday | A gets B's edit (proves remote time isn't back-dated) |
| A7 | New nested `a/b/c.md` | Remote `a/b/` created, file uploaded |
| A8 | Same note edited on both devices | Both versions kept (`(conflict …)` copy); nothing lost |
| A9 | Network drops mid-sync | "Sync incomplete"; **`lastSync` unchanged**; next sync finishes with no duplicates and no false conflicts |
| A10 | Note edited *during* a sync | Picked up by the next sync |
| A11 | Device clock 10 minutes wrong | A5 and A6 still pass |
| A12 | Downloaded file, next sync | Not uploaded again (MD5 skip) |
| A13 | Revoked refresh token | Clear notice; nothing changed; `lastSync` unchanged |
| A14 | **Sync** pressed twice quickly | Second run refused |
| A15 | Mobile (iOS/Android) | A1–A14 pass |
| P1 | 2,000 notes, nothing changed | Sync finishes in under 10 s on desktop |

## 12. Known limitations and decisions

1. **Deletions don't sync.** A note deleted on one device comes back from the other side. *v2:* keep a file index and move deleted files to Drive trash.
2. **Renames/moves** look like a new file; the old path stays elsewhere. Same v2 fix.
3. **Upload runs before download** (as requested). The conflict rule in §7.3 makes sure this never overwrites a remote change without keeping a copy.
4. **Conflict policy** is always "keep both" in v1. A setting (local wins / remote wins) can come later.
5. **Case-only renames** (`Note.md` → `note.md`) can clash on Windows/macOS. Logged, not handled in v1.
6. **v2 candidate:** switch the remote side to the Drive Changes API (`changes.list` with a saved page token). It's the most reliable way to track remote changes and would also enable deletion sync.

## 13. Milestones

| Milestone | Scope |
|---|---|
| M1 | Skeleton, settings tab, token refresh, folder resolve/create, `syncStart` capture |
| M2 | Remote index (full + incremental) and folder map |
| M3 | Upload pass (MD5-first, conflicts, no back-dating) |
| M4 | Download pass, finish step, `lastSync` rule, retries, log, status bar |
| M5 | Acceptance tests A1–A15 + P1, README, release |

## 14. Review changelog (v1.0 → v1.1)

| # | Finding | Severity | Fix |
|---|---|---|---|
| R1 | Setting remote `modifiedTime` to the local `mtime` back-dates files, so other devices can miss them forever | **Critical (data loss)** | Never set `modifiedTime`; Google stamps server time (§7.2 Step 4, test A6) |
| R2 | One `lastSync` compared across two clocks breaks on devices with a wrong clock | High | Two watermarks: local and server time (§6.1, test A11) |
| R3 | Conflict check ran before the MD5 check, so a retried sync reported false conflicts | High | MD5 check first (§7.2 Step 4.3, test A9) |
| R4 | `lastSync` update rule was spread across sections and unclear | Medium | Own section: updated on every successful sync, to the start time, never on failure (§6) |
| R5 | Walking the whole Drive folder tree on every sync is slow for large vaults | Medium | Folder map + one incremental query (§7.2 Step 3, test P1) |
| R6 | Two devices can create duplicate folders at the same moment | Medium | Use the oldest, warn (§7.2 Step 2) |
| R7 | Setting the local `mtime` on download isn't reliable on mobile | Low | Dropped; the MD5 check handles it (§7.2 Step 5) |
| R8 | No way to see what a sync did | Low | Sync log + status bar (§7.6) |
