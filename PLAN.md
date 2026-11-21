# Implementation Plan — `gdrive-sync`

This plan covers **how** and **when**. **What** the plugin does is defined only in [docs/PRD.md](docs/PRD.md) (v1.2); this file references it by section and doesn't restate its rules.

## 1. Architecture

The sync engine is plain TypeScript with **no `obsidian` import**. It depends on three ports:

- `VaultPort`: list files with stat, read/write binary, create folders, vault name.
- `DriveClient`: the Drive v3 calls the PRD needs, plus the `Date` header of the first response.
- `Clock`: `now()` and `sleep()`, for backoff and conflict-copy names.

`main.ts` wires in the Obsidian/`requestUrl` implementations; tests wire in in-memory fakes. This keeps all of §9's functional tests runnable in CI, including multi-device scenarios. Only P2 (mobile) and a live smoke test need real devices and a Google account.

The §4.3 decision rule is a pure function `decide(L, R, B) → action`. Both passes call it, and it is tested exhaustively.

## 2. Stack

| Concern | Choice |
|---|---|
| Language / build | TypeScript strict, esbuild (layout of the official `obsidian-sample-plugin`) |
| Tests | Vitest |
| MD5 | `spark-md5` (only runtime dependency) |
| Lint / format | ESLint, Prettier |
| CI | GitHub Actions: typecheck, lint, test, build |

## 3. Layout

```
manifest.json  versions.json  package.json  tsconfig.json  esbuild.config.mjs
README.md                      # user docs: setup (PRD §8), what is synced, limitations
docs/PRD.md  PLAN.md
src/
  main.ts                      # command, ribbon, run lock, status bar, notices
  settings.ts                  # defaults + merge, settings tab
  ports/      vault.ts  drive.ts  clock.ts      # interfaces + Obsidian implementations
  drive/      http.ts  auth.ts  client.ts  query.ts  errors.ts
  sync/       engine.ts  decide.ts  folders.ts  remote.ts  local.ts
              upload.ts  download.ts  conflict.ts  exclude.ts  pool.ts  retry.ts
  log.ts  md5.ts
tests/
  fakes/      drive.ts  vault.ts  device.ts     # device = vault + data.json + clock, sharing one fake Drive
  unit/  acceptance/  perf/
```

## 4. Implementation notes

Only things the PRD leaves to engineering:

- **HTTP.** `requestUrl({ throw: false })` so error bodies and headers are readable; header names lower-cased. One wrapper handles auth (401 → refresh once) and retries (PRD §5.5) for every call.
- **Drive queries.** Escape `'` and `\` in names. Match `obsidian` case-insensitively on the client side (list root folders, compare lower-case) rather than relying on Drive's `name =` semantics. Request `id, name, mimeType, parents, createdTime, modifiedTime, md5Checksum, trashed`; page with `nextPageToken`, `pageSize=1000`.
- **Folder creation once per run.** A per-path map of in-flight promises in `folders.ts` (PRD A7).
- **Stat before read.** When hashing, take the stat *before* reading the bytes and store that stat in the index. An edit made during the read then shows up as touched on the next run. After a download, re-stat and store the new `mtime`/`size`.
- **Resumable uploads.** Initiate, read `Location`, send the bytes in one `PUT`. `requestUrl` can't stream, so the whole file is in memory (see §7, item 2).
- **Single write sites.** `lastSync` is assigned in exactly one place (the success branch of the finish step); `folders`/`files` are saved in a `finally`. Unit tests guard both.
- **No `modifiedTime` in requests.** The fake Drive rejects any request body containing `modifiedTime`, so the rule is enforced by every test.
- **Log.** `log(action, path, reason)` is the only API, so contents and tokens can't be passed in. The ring buffer is flushed to `<plugin dir>/sync.log` once per run in the `finally`.
- **Index size.** About 130 bytes per file (≈ 260 KB for 2,000 files). Saved once per run, so this is fine.

## 5. Test strategy

- **Fake Drive:** folders/files with MD5, its own server clock (offset from device clocks), `Date` headers, the query subset we use, paging, fault injection (network error on the Nth call, 401, 429, 5xx), and optional search lag (new items hidden from queries for N seconds).
- **Unit:** one suite per module; exhaustive `decide()` table.
- **Acceptance:** A1–A16 as scenarios with one or two `device`s on one fake Drive. A10 uses a vault hook that edits a file mid-run; A11 shifts and then rewinds a device clock.
- **P1:** 2,000 files, fake Drive with 50 ms latency per call; assert < 10 s **and** a constant number of HTTP calls (no per-file calls when nothing changed).
- **Live smoke test (manual, never in CI):** A1, A3, A4, A5 against a throwaway Google account and a scratch vault, with credentials from environment variables. Checklist in `docs/TESTING.md`.
- **P2:** the same checklist on one iOS and one Android device.

## 6. Milestones

Each task is roughly one PR. A milestone is done when its listed tests pass in CI.

### M0 — Setup (½ day)

Scaffold, strict tsconfig, esbuild, Vitest, ESLint/Prettier, CI workflow, `manifest.json` (`gdrive-sync`, `isDesktopOnly: false`).
**Exit:** CI green on an empty test suite; `npm run build` emits `main.js`.

### M1 — Foundation (2 days)

| Task | PRD |
|---|---|
| Settings defaults/merge and settings tab | §4.1, §5.1 |
| Command, ribbon, run lock, status bar, empty-settings check | §5.2 step 1, §5.6 |
| HTTP wrapper, token refresh, error classification, retry with backoff | §5.2 step 2, §5.5 |
| `syncStart` from `Date` header | §4.4 |
| Vault folder resolve/create, duplicate handling, reset on ID change | §5.2 step 3 |
| Fake Drive v1 (folders, `Date` header, faults) | — |

**Exit:** unit suites; A2, A13, A14.

### M2 — Remote changes (2 days)

| Task | PRD |
|---|---|
| Fake Drive query engine (`modifiedTime >`, `trashed`, parents, name, paging, search lag) | — |
| Full recursive listing | §5.2 step 4 |
| Incremental query with 5-minute overlap; folder resolution until stable; ignore unknown parents | §4.2, §5.2 step 4 |
| Duplicate remote paths, skip rules for remote items | §5.2 step 4, §5.4 |
| **Spike:** measure Drive search lag on a real account (§7, item 1) | §4.2 |

**Exit:** unit suites; A16; spike result recorded in this file.

### M3 — Local index and upload pass (3 days)

| Task | PRD |
|---|---|
| Exclusions, MD5, touched detection against the index | §4.2, §5.4 |
| `decide()` | §4.3 |
| Folder creation once per run | §5.2 step 5 |
| Multipart / resumable create and update | §6 |
| Upload pass | §5.2 step 5 |
| Conflict procedure (deterministic name, suffixes) | §5.3 |
| Concurrency pool (4) | §5.5 |

**Exit:** A1, A4, A7, A8.

### M4 — Download pass and finish (2 days)

| Task | PRD |
|---|---|
| Download pass with re-check before overwrite | §5.2 step 6 |
| Finish step, index/folder save, `lastSync` rule | §4.4, §5.2 step 7 |
| Summary notices and log | §5.6 |

**Exit:** A3, A5, A6, A9, A10, A11, A12, A15.

### M5 — Hardening and release (2–3 days)

P1 perf test, live smoke test, P2 on iOS and Android, README, release script, GitHub release with `main.js` + `manifest.json` (installable with BRAT).
**Exit:** Definition of done (§8).

**Estimate:** about 12 working days for one engineer.

## 7. Open items

1. **Drive search lag (M2 spike).** The PRD uses a 5-minute overlap on the assumption that lag is well below that. If the spike shows longer lag, raise the overlap (it only costs a few re-checked files) or bring the v2 Changes API forward.
2. **Large files on mobile.** Resumable uploads and downloads hold the whole file in memory. Test a 100 MB attachment during P2; if it fails, add a max file size that skips and logs larger files.

## 8. Definition of done (v1)

- A1–A16 and P1 pass in CI; P2 checklist signed off on iOS and Android.
- Live smoke test passes.
- README covers setup (PRD §8), what is synced, limitations and the plain-text token warning.
- Tagged GitHub release.
