# Execution Plan: Google Drive Sync for Obsidian

| | |
|---|---|
| **Status** | In review |
| **Version** | 1.0 |
| **Last updated** | 2026-11-21 |
| **Owner** | TBD |
| **Related** | [PRD v1.3](PRD.md) · [Technical design v1.0](DESIGN.md) |

This document covers **when** and **in what order**. Requirements (FR-, NFR-, AT-) are in the [PRD](PRD.md); design sections (D§) are in the [design doc](DESIGN.md).

---

## 1. Milestones

| Milestone | Deliverable | Exit criteria | Estimate |
|---|---|---|---|
| **M0 Setup** | Buildable, linted, tested empty plugin | CI green; `npm run build` emits `main.js` | 0.5 d |
| **M1 Foundation** | Settings, command, auth, vault folder | AT-02, AT-13, AT-14; unit tests | 2 d |
| **M2 Remote change set** | Full and incremental remote listing | AT-16; unit tests; search-lag spike recorded (OQ-T2) | 2 d |
| **M3 Upload pass** | Local index, decision rule, uploads, conflicts | AT-01, AT-04, AT-07, AT-08; device check (OQ-T3) | 3 d |
| **M4 Download pass** | Downloads, commit rules, feedback | AT-03, AT-05, AT-06, AT-09 … AT-12, AT-15 | 2 d |
| **M5 Release** | 1.0.0 | Definition of done (§6) | 2.5 d |

**Total:** 12 engineering days + 20 % contingency ≈ **3 weeks** for one engineer, plus 2 weeks of dogfooding before 1.0.0 (PRD §5).

## 2. Work breakdown

Each task is one pull request.

### M0 Setup

- Scaffold from the official `obsidian-sample-plugin` layout: TypeScript strict, esbuild, `manifest.json` (ID per PRD OQ-2, `isDesktopOnly: false`).
- Vitest, ESLint (typescript-eslint and Obsidian's ESLint plugin), Prettier, layer import rules (D§3.1).
- GitHub Actions: typecheck, lint, test, build on every push and pull request.

### M1 Foundation

| Task | Ref |
|---|---|
| State schema v1, defaults, load/merge, `PluginDataStateStore` | D§4 |
| Settings tab | FR-1 |
| Command, ribbon, run lock, status bar, notices | FR-2, FR-10, PRD §8 |
| `HttpClient`, `OAuthTokenProvider`, error classification, `retry` | D§6.4 |
| `connect()`: `syncStartTime`, vault folder resolution, replacement detection | D§5.1, D§6.3 |
| Fake Drive v1: folders, `Date` header, fault injection | D§8 |

### M2 Remote change set

| Task | Ref |
|---|---|
| Fake Drive query engine, paging, search lag | D§8 |
| `listAll()`, `listChangedSince()`, folder resolution until stable | D§6.2 |
| Exclusions, Google-native skip, duplicate paths | FR-5, D§6.2 |
| **Spike:** measure Drive search lag on a real account; record the result here | OQ-T2 |

### M3 Upload pass

| Task | Ref |
|---|---|
| `ObsidianLocalFiles`, MD5, touched detection | D§5.2 |
| `decide()` with full input-combination tests | D§5.3 |
| `ensureFolder()` once per run; create/update (multipart, media, resumable) | D§6.1, D§6.3 |
| Upload pass with concurrency pool | D§5.4 |
| Conflict resolver | D§5.6 |
| **Device check:** stat after write on iOS and Android | OQ-T3 |

### M4 Download pass

| Task | Ref |
|---|---|
| Download pass with re-check before overwrite | D§5.5 |
| Commit rules: checkpoints, `lastSyncTime` | D§4.2 |
| `FileSyncLog`, summary notices | FR-10 |
| Multi-device acceptance scenarios | AT-05, AT-06, AT-09 … AT-12 |

### M5 Release

| Task | Ref |
|---|---|
| PT-01 performance test | NFR-2 |
| Contract suite against real Drive | D§8 |
| CT-01 on iOS and Android | NFR-3 |
| README: install, setup (PRD Appendix A), what is synced, limitations, network-use disclosure | NFR-5 |
| Release workflow; 2-week dogfood; tag 1.0.0 | PRD §5 |

## 3. Dependencies

| Dependency | Needed by |
|---|---|
| PRD OQ-2 (plugin ID) decided | M0 |
| PRD OQ-3, OQ-5 and design OQ-T1 decided | M1 |
| Test Google account + Cloud project with the Drive API (not a personal account) | M2 spike |
| One iOS and one Android device with Obsidian | M3 device check |

## 4. Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R-1 | Drive search lag exceeds the 5-minute overlap; remote changes are missed | Low | High | M2 spike; raise overlap or adopt the Changes API (D§9) |
| R-2 | Large files exhaust memory on mobile (`requestUrl` can't stream) | Medium | Medium | Size limit (PRD OQ-4); test 100 MB in CT-01 |
| R-3 | Mobile file APIs behave differently (stat, binary writes) | Medium | High | Device check in M3 instead of only at release |
| R-4 | Users hit the 7-day refresh-token expiry in "Testing" mode | High | Medium | README guidance; clear rejected-token notice (PRD §8) |
| R-5 | Rate limits on the first sync of a large vault | Low | Medium | Backoff with `Retry-After`; 4 concurrent transfers |
| R-6 | Plugin name or ID rejected in community review | Medium | Low | Settle PRD OQ-1/OQ-2 before M0 |

## 5. Engineering conventions

| Area | Convention |
|---|---|
| Code style | TypeScript `strict`; Prettier; ESLint with typescript-eslint and Obsidian's plugin rules |
| Naming | Files `kebab-case.ts`; classes/types `PascalCase`; functions/variables `camelCase`; constants `UPPER_SNAKE_CASE`; no `I` prefix on interfaces; ports named by role (`RemoteFiles`), adapters by technology + role (`GoogleDriveRemoteFiles`); units in names (`mtimeMs`, `…Bytes`) |
| Architecture | Layer rules in D§3.1, enforced by lint |
| Branches | `feat/…`, `fix/…`, `chore/…` off `main` |
| Commits | [Conventional Commits](https://www.conventionalcommits.org/) |
| Pull requests | One task each; CI green; one approving review; squash merge |
| Versioning | [SemVer](https://semver.org/). `manifest.json` and `versions.json` updated together. Release tags equal the version exactly (`1.0.0`, no `v`), as Obsidian requires |
| Release assets | `main.js`, `manifest.json`, `styles.css` (if any) |

## 6. Definition of done

**Per task:** code and tests merged; CI green; referenced requirements covered by tests; docs updated if behavior changed.

**Release 1.0.0:**

- AT-01 … AT-16 and PT-01 pass in CI; CT-01 signed off on iOS and Android.
- Contract suite passes against real Drive.
- All PRD and design open questions closed.
- README complete, including the network-use disclosure.
- 2 weeks of dogfooding on ≥ 2 devices with no data-loss incident.
- GitHub release `1.0.0` published.
