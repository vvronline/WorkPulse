# WorkPulse Validation Baseline

**Task:** T002 — Capture the current validation baseline
**Status:** Recorded
**Captured:** 2026-07-22
**Purpose:** Provide a reproducible pre-restructuring validation baseline so that any
failure introduced by a later restructuring task cannot be incorrectly attributed to
pre-existing behavior.

> This document records measurements only. It intentionally contains no application or
> runtime changes. Re-run the commands in section 3 on any branch and compare against
> section 4 to detect regressions introduced by restructuring work.

---

## 1. Commit and environment

| Item | Value |
|---|---|
| Branch | `master` |
| Commit | `adb57128` (T008 — stop tracking generated server output) |
| OS | Windows (win32), PowerShell shell |
| Host Node.js | v24.18.0 |
| Host npm | 9.6.4 |
| Docker | 27.3.1 (build ce12230), BuildKit v0.16.0 |
| Container Node.js | v20.20.2 (`node:20-alpine`) |

Timings were measured with PowerShell `Measure-Command` and are wall-clock seconds on
this host with a warm dependency cache. They are indicative, not contractual, and will
vary by machine. The signal that matters for the baseline is **pass/fail and item
counts**, not absolute duration.

---

## 2. Summary

| Workspace | Validation | Result | Duration | Notes |
|---|---|---|---|---|
| server | `npm --prefix server run typecheck` | PASS | ~6.9s | 0 TypeScript errors |
| server | `npm --prefix server run build` | PASS | ~8.7s | `tsc` emits `server/dist` |
| server | `npm --prefix server test` | PASS | ~24.3s | 50 suites, 629 tests, 0 failures |
| client | `npm --prefix client run typecheck` | PASS | ~15.1s | 0 TypeScript errors |
| client | `npm --prefix client test` | PASS | ~12.9s | 19 files, 154 tests, 0 failures |
| client | `npm --prefix client run build` | PASS | ~18.9s | Vite build; chunk-size warnings |
| desktop | `npm --prefix desktop run typecheck` | PASS | ~3.0s | Main-process `tsc --noEmit`, 0 errors |
| mobile | `npx tsc --noEmit` (in `mobile/`) | PASS | ~13.7s | 0 errors; no `typecheck` script yet (see T006) |
| docker | `docker build -t workpulse:baseline .` | PASS | first run ~4–5 min; cached ~36s | Image ~328 MB |
| docker | container startup smoke | PASS (partial) | n/a | See section 5 |

**Overall: no known failures at commit `adb57128`.** All typecheck, unit-test, build,
and image-build validations pass.

---

## 3. Reproduction commands

Run from the repository root in PowerShell (matches the plan's T002 command block):

```powershell
npm --prefix server run typecheck
npm --prefix server run build
npm --prefix server test

npm --prefix client run typecheck
npm --prefix client test
npm --prefix client run build

npm --prefix desktop run typecheck

Set-Location mobile
npx tsc --noEmit
Set-Location ..

docker build -t workpulse:baseline .
```

Notes:
- `mobile` has **no** `npm run typecheck` script at this commit; the plan adds it in
  T006. Until then, use `npx tsc --noEmit` from inside `mobile/` for the mobile baseline.
- `docker build` exceeds a typical single-command tool timeout on a cold cache. It
  completes normally when run directly in a terminal (measured wall-clock ~36s on a warm
  BuildKit layer cache here; the first cold build takes several minutes).


---

## 4. Detailed results

### 4.1 Server (`server/`)

- **typecheck** — `tsc -p tsconfig.json --noEmit` — exit 0, no errors. ~6.9s.
- **build** — `tsc -p tsconfig.json` — exit 0, regenerates `server/dist`
  (336 files on disk). ~8.7s. Confirms the T008 assumption that `dist` is a build
  artifact and never needs to be tracked in Git.
- **test** — Jest (`ts-jest`) — exit 0.
  - Test Suites: **50 passed, 50 total**
  - Tests: **629 passed, 629 total**
  - Snapshots: 0 total
  - ~24.3s. No open-handle or teardown failures reported (`--forceExit --detectOpenHandles`).

### 4.2 Web client (`client/`)

- **typecheck** — `tsc --noEmit` — exit 0, no errors. ~15.1s.
- **test** — Vitest (`vitest run`) — exit 0.
  - Test Files: **19 passed (19)**
  - Tests: **154 passed (154)**
  - ~12.9s.
- **build** — `vite build` (with mediapipe/face-model copy prebuild) — exit 0,
  "built in ~16.58s". ~18.9s total.
  - **Warning (pre-existing, expected):** several output chunks exceed Vite's 500 kB
    warning limit after minification, the largest being
    `face-api.esm` (~1.33 MB), `NotesPage` (~1.30 MB), `Chat` (~865 kB),
    `index` (~668 kB), and `Admin` (~349 kB). This is a code-splitting/bundle-size
    warning only, not a build failure. Recorded here so it is **not** attributed to a
    later restructuring task. (Web static hosting/CDN and any chunking work are covered
    by Phase 2, not this baseline.)

### 4.3 Desktop (`desktop/`)

- **typecheck** — `tsc --noEmit` (Electron main process) — exit 0, no errors. ~3.0s.
- Installer packaging (`electron-builder`) is intentionally **not** part of this
  baseline; it belongs in the desktop release workflow, not ordinary validation.

### 4.4 Mobile (`mobile/`)

- **typecheck** — `npx tsc --noEmit` from `mobile/` — exit 0, **0** `error TS`
  lines. ~13.7s.
- Expo prebuild / native project generation is **not** part of this baseline.

### 4.5 Docker image (root `Dockerfile`)

- **build** — `docker build -t workpulse:baseline .` — succeeded. All 25 build steps
  reported `DONE`. Final image `workpulse:baseline`, size ~328 MB.
- The multi-stage build compiles both the client (`vite build`) and server (`tsc`)
  **from source inside the image** (`COPY --from=backend-builder /app/server/dist ./`),
  independently confirming that Docker does not depend on any committed `server/dist`
  files (relevant to T008).
- Duration: first cold build takes several minutes; a rebuild with a warm BuildKit
  layer cache measured ~36s wall-clock here.

---

## 5. Docker startup result

A full container boot requires a reachable PostgreSQL master + tenant databases, Redis,
JWT/encryption secrets, and runs schema migrations on start (`node migrate.js && node
index.js`). Running that against the local development database could mutate dev data, so
the baseline uses a **non-destructive** startup check instead of a full boot:

| Check | Result |
|---|---|
| Container runs / Node available | PASS — `node v20.20.2` inside image |
| Compiled entrypoint present | PASS — `/app/server/index.js` exists |
| Migration entrypoint present | PASS — `/app/server/migrate.js` exists |
| Privilege-drop entrypoint present | PASS — `/entrypoint.sh` exists |
| Built web assets present | PASS — `/app/client/dist/index.html` exists |
| Entrypoint parses | PASS — `node --check /app/server/index.js` exit 0 |

A full runtime boot smoke test (liveness/readiness against real dependencies) is defined
as part of the release smoke-test runbook (T003) and the staging restore drill (T005),
where an isolated, non-production dataset is available.

---

## 6. Known failures / flakiness at this commit

**None.** Every validation above passed. The only non-fatal signals are:

- Vite chunk-size warnings in the client build (section 4.2) — expected, pre-existing.
- `mobile` lacks a dedicated `typecheck` npm script (added later by T006) — the
  baseline used `npx tsc --noEmit` as the plan's T002 command block specifies.

Any new failure observed after a restructuring task that is not listed here should be
treated as introduced by that task.
