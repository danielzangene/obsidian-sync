# Execution Plan: Google Drive Sync for Obsidian

|                  |                                                           |
| ---------------- | --------------------------------------------------------- |
| **Status**       | M0–M4 complete; M5 (verification and release) in progress |
| **Version**      | 1.1                                                       |
| **Last updated** | 2026-11-21                                                |
| **Owner**        | TBD                                                       |
| **Related**      | [PRD v1.4](PRD.md) · [Technical design v1.1](DESIGN.md)   |

This document covers **when** and **in what order**. Requirements (FR-, NFR-, AT-) are in the [PRD](PRD.md); design sections (D§) are in the [design doc](DESIGN.md).

---

## 1. Milestones

| Milestone                       | Deliverable                                    | Exit criteria                                    | Status      |
| ------------------------------- | ---------------------------------------------- | ------------------------------------------------ | ----------- |
| **M0 Setup**                    | Buildable, linted, tested plugin skeleton      | CI green; `npm run build` emits `main.js`        | ✅ Done     |
| **M1 Foundation**               | Settings, command, auth, vault folder          | AT-02, AT-13, AT-14; unit tests                  | ✅ Done     |
| **M2 Remote change set**        | Full and incremental remote listing            | AT-16; unit tests                                | ✅ Done     |
| **M3 Upload pass**              | Local index, decision rule, uploads, conflicts | AT-01, AT-04, AT-07, AT-08                       | ✅ Done     |
| **M4 Download pass**            | Downloads, commit rules, feedback              | AT-03, AT-05, AT-06, AT-09 … AT-12, AT-15; PT-01 | ✅ Done     |
| **M5 Verification and release** | 1.0.0                                          | Definition of done (§6)                          | In progress |

The search-lag spike (OQ-T2) and the device check (OQ-T3) were planned for M2 and M3. They need a real Google account and phones, so they moved to M5. The mechanisms they validate are covered by fake-Drive tests (simulated search lag, stat after write).

**Remaining effort:** about 3 engineering days for M5, plus 2 weeks of dogfooding before 1.0.0 (PRD §5).

## 2. M5 work breakdown

| #   | Task                                                                                                                                                         | Ref                | Needs               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ | ------------------- |
| 5.1 | Manual smoke test in desktop Obsidian: install the build, configure settings (secret controls, OQ-T4), run AT-01, AT-03, AT-04, AT-05 against a test account | D§8                | Test Google account |
| 5.2 | Search-lag spike: write files with one client, poll the change query with another, record the observed lag here; adjust `REMOTE_QUERY_OVERLAP_MS` if needed  | OQ-T2              | Test Google account |
| 5.3 | CT-01 on iOS and Android, including a 100 MB attachment and stat after write                                                                                 | NFR-3, OQ-T3, OQ-4 | Devices             |
| 5.4 | README: user setup and network disclosure (done); add screenshots after 5.1                                                                                  | NFR-5              | —                   |
| 5.5 | Close PRD OQ-8: owner, reviewers, manifest `author`                                                                                                          | —                  | Decision            |
| 5.6 | Dogfood 2 weeks on ≥ 2 devices; then `npm version 1.0.0`, push the tag, publish the draft release                                                            | PRD §5             | —                   |

## 3. Dependencies

| Dependency                                                                      | Needed by |
| ------------------------------------------------------------------------------- | --------- |
| Test Google account + Cloud project with the Drive API (not a personal account) | 5.1, 5.2  |
| One iOS and one Android device with Obsidian ≥ 1.13.2                           | 5.3       |
| Owner decision (PRD OQ-8)                                                       | 5.5       |

## 4. Risks

| ID  | Risk                                                                          | Likelihood | Impact | Mitigation                                              |
| --- | ----------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------- |
| R-1 | Real Drive search lag exceeds the 5-minute overlap; remote changes are missed | Low        | High   | Spike 5.2; raise overlap or adopt the Changes API (D§9) |
| R-2 | Large files exhaust memory on mobile (`requestUrl` can't stream)              | Medium     | Medium | 100 MB limit; verify in 5.3                             |
| R-3 | Mobile file APIs behave differently (stat after write)                        | Medium     | High   | Verify in 5.3 before dogfooding                         |
| R-4 | Users hit the 7-day refresh-token expiry in "Testing" mode                    | High       | Medium | README guidance; clear rejected-token notice            |
| R-5 | Rate limits on the first sync of a large vault                                | Low        | Medium | Backoff with `Retry-After`; 4 concurrent transfers      |
| R-6 | Declarative settings or secret controls behave differently from their types   | Low        | Medium | Smoke test 5.1 (OQ-T4)                                  |
| R-7 | `minAppVersion` 1.13.2 excludes users on older Obsidian                       | Low        | Low    | Documented in README                                    |

## 5. Engineering conventions

| Area           | Convention                                                                                                                                                                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code style     | TypeScript `strict` (+ `noUncheckedIndexedAccess`); Prettier; ESLint with Obsidian's recommended config (includes typescript-eslint type-checked rules)                                                                                                                            |
| Naming         | Files `kebab-case.ts`; classes/types `PascalCase`; functions/variables `camelCase`; constants `UPPER_SNAKE_CASE`; no `I` prefix on interfaces; ports named by role (`RemoteFiles`), adapters by technology + role (`GoogleDriveRemoteFiles`); units in names (`mtimeMs`, `…Bytes`) |
| Architecture   | Layer rules in D§3.1, enforced by lint                                                                                                                                                                                                                                             |
| Quality gate   | `npm run check` (typecheck, lint, format, tests) and `npm run build` in CI on every push and pull request                                                                                                                                                                          |
| Branches       | `feat/…`, `fix/…`, `chore/…` off `main`                                                                                                                                                                                                                                            |
| Commits        | [Conventional Commits](https://www.conventionalcommits.org/)                                                                                                                                                                                                                       |
| Pull requests  | One task each; CI green; one approving review; squash merge                                                                                                                                                                                                                        |
| Versioning     | [SemVer](https://semver.org/). `npm version <x.y.z>` updates `manifest.json` and `versions.json`. Tags equal the version exactly (`1.0.0`, no `v`), as Obsidian requires; the release workflow publishes `0.x` tags as pre-releases and creates drafts for `1.0.0`+                |
| Release assets | `main.js`, `manifest.json`                                                                                                                                                                                                                                                         |

## 6. Definition of done

**Per task:** code and tests merged; `npm run check` green; referenced requirements covered by tests; docs updated if behavior changed.

**Release 1.0.0:**

- AT-01 … AT-16 and PT-01 pass in CI. ✅
- Smoke test against real Drive passes (5.1); search-lag result recorded (5.2).
- CT-01 signed off on iOS and Android (5.3).
- All PRD and design open questions closed.
- README complete, including the network-use disclosure.
- 2 weeks of dogfooding on ≥ 2 devices with no data-loss incident.
- GitHub release `1.0.0` published.
