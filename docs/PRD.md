# PRD: Google Drive Sync for Obsidian

| | |
|---|---|
| **Status** | In review |
| **Version** | 1.3 |
| **Last updated** | 2026-11-21 |
| **Owner** | TBD |
| **Reviewers** | TBD |
| **Related** | [Technical design](DESIGN.md) · [Execution plan](PLAN.md) |

This document defines **what** the plugin does and **why**. How it works is in [DESIGN.md](DESIGN.md); when it ships is in [PLAN.md](PLAN.md). Requirement keywords **MUST**, **SHOULD** and **MAY** follow [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

---

## 1. Overview

An Obsidian plugin with one command, **Sync**, that syncs the current vault with a folder in the user's Google Drive. Each run uploads local changes and downloads remote changes. When a file changed on both sides, both versions are kept. The "last successful sync" time moves forward only when the whole run succeeds.

## 2. Problem statement

People who use Obsidian on several devices need their notes in sync. Obsidian Sync is paid, and most alternatives need a desktop client or a complicated setup. Many users already have Google Drive and want a manual, one-button sync that keeps their notes as plain files in their own Drive.

## 3. Target users

Obsidian users with two or more devices (desktop and/or mobile) and a Google account, who are comfortable creating an OAuth client in Google Cloud Console (Appendix A). Users who can't do that one-time setup are not served by v1.

## 4. Goals and non-goals

### Goals

| ID | Goal |
|---|---|
| G1 | **One command.** Sync runs only when the user asks. |
| G2 | **Simple auth.** The user pastes client ID, client secret and refresh token once. No browser sign-in inside Obsidian. |
| G3 | **Plain mirror.** Notes are stored as ordinary files under `My Drive/obsidian/<vault name>/`, with the vault's folder structure. |
| G4 | **Incremental.** Only changes since the last successful sync are transferred. |
| G5 | **No silent data loss.** Conflicting edits keep both versions; a failed run is completed by running Sync again. |
| G6 | **Desktop and mobile.** |
| G7 | **Transparent.** Every run reports what it uploaded, downloaded, skipped, conflicted and failed. |

### Non-goals (v1)

- Automatic or scheduled sync.
- Syncing deletions or renames (§10).
- Syncing the Obsidian config folder.
- Merging text inside a file.
- Google-native files (Docs, Sheets, …).
- Shared Drives.
- Localization (UI is English only).

## 5. Success metrics

No telemetry is collected (NFR-5), so success is measured by release criteria and issue reports.

| Metric | Target |
|---|---|
| Acceptance criteria (§9) | 100 % pass on desktop, iOS and Android |
| Dogfooding before 1.0.0 | 2 weeks on ≥ 2 devices, zero data-loss incidents |
| Data-loss reports after release | Zero confirmed |

## 6. Functional requirements

| ID | Requirement |
|---|---|
| **FR-1 Settings** | The settings tab MUST have: *Client ID* (text), *Client secret* (password), *Refresh token* (password), and a read-only *Last successful sync* (local time, or "Never"). It MUST warn that credentials are stored in plain text on this device. |
| **FR-2 Command** | The plugin MUST register exactly one command, *Sync*, with no default hotkey, plus a ribbon icon that runs the same command. Only one run MAY be active; a second request MUST show "Sync already running" and do nothing. |
| **FR-3 Preconditions** | If any credential is missing, or Google rejects the refresh token, the run MUST stop before changing any file and show a notice saying what to fix (§8). |
| **FR-4 Remote location** | Files MUST be stored under `My Drive/obsidian/<vault name>/`, mirroring the vault's folders. An existing `obsidian` folder MUST be reused regardless of letter case. Missing folders MUST be created. If several candidate folders exist, the oldest MUST be used and a warning shown. If the vault folder is replaced (e.g. trashed and recreated), the next run MUST re-upload the whole vault. |
| **FR-5 Scope** | All vault files MUST be synced except: names starting with `.` at any level (config folder, `.trash`, `.git`, `.DS_Store`), `Thumbs.db`, Google-native files, and remote names Obsidian can't use (`* " \ / < > : \| ?`). Skipped items MUST be logged and MUST NOT make a run fail. |
| **FR-6 Upload** | Every local file created or changed since this device last synced it MUST be uploaded. |
| **FR-7 Download** | Every remote file created or changed since this device's last successful sync MUST be downloaded. A change synced from any device MUST reach every other device on its next successful sync, regardless of device clocks. |
| **FR-8 Conflicts** | If a file changed both locally and remotely, the local version MUST stay the main file and the remote version MUST be saved next to it as `<name> (conflict YYYY-MM-DD HHmm).<ext>`. The conflict copy MUST sync to all devices like any other file. Retrying a run MUST NOT create a second copy of the same version. |
| **FR-9 Failure handling** | If any file fails after retries, the run MUST report "incomplete" and MUST NOT advance *Last successful sync*. Re-running MUST finish the work without duplicate remote files or false conflicts. |
| **FR-10 Feedback** | A status bar item MUST show progress during a run. A notice MUST summarize each run. A log of the last 500 actions MUST be kept on the device (§8). |

## 7. Non-functional requirements

| ID | Requirement |
|---|---|
| **NFR-1 Data safety** | The plugin MUST NOT overwrite a local or remote version that exists nowhere else without first keeping a copy. |
| **NFR-2 Performance** | With 2,000 notes and no changes, a run MUST finish in under 10 s on desktop. |
| **NFR-3 Platforms** | MUST work on Obsidian desktop (Windows, macOS, Linux), iOS and Android. |
| **NFR-4 Clock independence** | Correctness MUST NOT depend on device clocks being right or stable. |
| **NFR-5 Security and privacy** | Credentials MUST never be synced, logged or shown. The plugin MUST only contact Google OAuth and Drive endpoints and MUST NOT collect telemetry. The README MUST disclose the network use and the Google account requirement (Obsidian developer policy). |
| **NFR-6 Fair use** | The plugin MUST respect Google rate limits and MUST NOT run more than 4 transfers at once. |
| **NFR-7 Platform guidelines** | The plugin MUST follow Obsidian's plugin guidelines (sentence-case UI, no default hotkeys, Vault API for vault files, `normalizePath` for user paths). |

## 8. User experience

All UI text uses sentence case, per Obsidian's style guide.

| Surface | Text |
|---|---|
| Status bar (running) | `Syncing… ↑3/10 ↓1/4` |
| Notice: success | `Sync done — ↑4 ↓2 ⚠1 conflict` |
| Notice: partial failure | `Sync incomplete — 2 files failed. Run Sync again.` |
| Notice: already running | `Sync already running` |
| Notice: missing credentials | `Add your client ID, client secret and refresh token in settings.` |
| Notice: rejected token | `Refresh token is invalid or revoked. Create a new one and update settings.` |
| Notice: duplicate folders | `Found 2 folders named "<name>" in Google Drive. Using the oldest.` |
| Log (`sync.log` in the plugin folder) | `2026-11-21T10:15:02.123Z UPLOAD notes/a.md created` — one line per action: time, `UPLOAD` / `DOWNLOAD` / `SKIP` / `CONFLICT` / `ERROR`, path, reason |

## 9. Acceptance criteria

| ID | Req | Given | When | Then |
|---|---|---|---|---|
| AT-01 | FR-4, FR-6 | No `obsidian` folder in Drive; vault has files | Sync | `obsidian/<vault>` created; all files uploaded; *Last successful sync* set |
| AT-02 | FR-4 | My Drive already has `Obsidian/` | First Sync | Existing folder reused; no new folder |
| AT-03 | FR-9 | Synced vault, no changes | Sync | 0 up, 0 down; *Last successful sync* updated |
| AT-04 | FR-6 | One note edited | Sync | Exactly 1 upload |
| AT-05 | FR-7 | Note edited and synced on device B | Sync on A | A downloads exactly that note |
| AT-06 | FR-7 | B edits offline Mon; A syncs Tue; B syncs Wed | A syncs Thu | A receives B's edit |
| AT-07 | FR-4 | New `a/b/c.md` and `a/b/d.md` | Sync | `a/` and `a/b/` each created once; both files uploaded |
| AT-08 | FR-8 | Same note edited on A and B; B synced | Sync on A, then B | Both devices have A's version as main plus a conflict copy of B's |
| AT-09 | FR-9 | Network drops mid-run | Run ends, then Sync again | First: "incomplete", *Last successful sync* unchanged. Second: completes, no duplicates, no conflict copies |
| AT-10 | NFR-1 | A run is in progress | User edits a note during the upload pass, or just before it would be downloaded | Edit kept (conflict copy if the remote also changed); uploaded on the next sync |
| AT-11 | NFR-4 | Device clock off by ±10 min, then corrected between runs | Repeat AT-04, AT-05, AT-06 | All pass |
| AT-12 | FR-7 | A downloaded B's edit; B edits the same note again and syncs | Sync on A | A downloads it; no upload, no conflict |
| AT-13 | FR-3 | Refresh token revoked | Sync | Rejected-token notice; no file changed; *Last successful sync* unchanged |
| AT-14 | FR-2 | A run is in progress | Sync again | "Sync already running"; no second run |
| AT-15 | FR-4 | Vault folder trashed in Drive | Sync | New folder created; whole vault uploaded |
| AT-16 | FR-5 | Vault folder in Drive contains a Google Doc and a file named `a:b.md` | Sync | Both skipped and logged; run reports done |
| PT-01 | NFR-2 | 2,000 notes, no changes | Sync on desktop | Finishes in < 10 s |
| CT-01 | NFR-3 | iOS and Android devices | Run AT-01 … AT-16 | All pass |

## 10. Known limitations

| ID | Limitation |
|---|---|
| L1 | **Deletions don't sync.** A deleted note stays in Drive and on other devices, and returns to the deleting device if the Drive copy changes. |
| L2 | **Renames and moves** behave like a new file; the old path stays. |
| L3 | **Conflicts always keep both.** No "local wins / remote wins" option. |
| L4 | **Case-only name differences** (`Note.md` vs `note.md`) can clash on case-insensitive file systems; they are logged, not resolved. |
| L5 | **Empty folders** are not synced. |
| L6 | **Vault identity is its name.** Renaming a vault starts a new remote folder; two different vaults with the same name share one (see OQ-3). |
| L7 | **Local change detection uses modified time and size.** A tool that changes content but preserves both is not detected. |
| L8 | **Obsidian closed mid-run** may cause one unnecessary conflict copy on the next run. No data is lost. |

## 11. Dependencies and assumptions

- The user has a Google account and a Google Cloud project with the Drive API enabled (Appendix A).
- While the OAuth consent screen is in "Testing", Google expires refresh tokens after 7 days.
- Google Drive search results reflect writes within a few minutes (validated by the M2 spike in [PLAN.md](PLAN.md)).

## 12. Open questions

| ID | Question | Recommendation | Blocks |
|---|---|---|---|
| OQ-1 | Distribution: Obsidian community directory, or BRAT/manual install only? | BRAT for 1.0; apply to the directory after dogfooding | M5 |
| OQ-2 | Final plugin ID and display name. The ID can't change after release (it names the data folder). | Keep ID `gdrive-sync`; pick a name that doesn't start with "Google" (trademark), e.g. "Drive Sync"; check uniqueness in the directory | M0 |
| OQ-3 | Should users be able to set the remote folder name (default = vault name)? It would address L6. | Yes: one optional setting, *Remote folder name* | M1 |
| OQ-4 | Large files: skip files above a size limit? | Skip and log files over 100 MB; confirm after mobile tests | M3 |
| OQ-5 | OAuth scope: full `drive` (current) or `drive.file`? `drive.file` is least-privilege but can't see folders/files the user adds through the Drive web UI or other apps, which breaks AT-02. | Keep `drive` for v1; document the risk | M1 |
| OQ-6 | Are the known limitations L1–L8 acceptable for 1.0? | Accept | M5 |
| OQ-7 | License | MIT | M5 |
| OQ-8 | Document owner and reviewers | — | Approval |

Technical open questions are in [DESIGN.md §10](DESIGN.md#10-open-questions).

## 13. Revision history

| Version | Date | Summary |
|---|---|---|
| 1.0 | — | Initial draft. |
| 1.1 | 2026-11-21 | Review: no back-dating of remote times, separate local/remote watermarks, checksum before conflict check, folder map, duplicate-folder rule, sync log. |
| 1.2 | 2026-11-21 | Engineering review: per-file sync index with three-way conflict rule (fixes a data-loss path and repeated false conflicts), download never overwrites unsynced edits, single server-clock watermark, full resync when the vault folder is replaced, corrected token guide. Rationale in [DESIGN.md §9](DESIGN.md#9-alternatives-considered). |
| 1.3 | 2026-11-21 | Split into PRD / design / plan; requirement and test IDs; Given/When/Then criteria; non-functional requirements, success metrics and open questions added; UI copy in sentence case. |

---

## Appendix A. Getting a refresh token

Source text for the README.

1. In Google Cloud Console, create a project and enable the **Google Drive API**.
2. Configure the OAuth consent screen and add your account as a test user.
3. Create an **OAuth client ID** of type **Web application** with the authorized redirect URI `https://developers.google.com/oauthplayground`. Copy the client ID and client secret.
4. In the OAuth 2.0 Playground, open the gear icon, select "Use your own OAuth credentials", enter them, authorize the scope `https://www.googleapis.com/auth/drive`, and exchange the authorization code for tokens.
5. Paste the client ID, client secret and refresh token into the plugin settings.

While the consent screen is in "Testing", the refresh token expires after 7 days. Publish the app ("In production") for a long-lived token. Google then shows an "unverified app" warning in step 4, which is expected for a personal client.
