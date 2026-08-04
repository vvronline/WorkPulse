# Graph Report - desktop  (2026-08-04)

## Corpus Check
- 11 files · ~40,556 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 145 nodes · 169 edges · 12 communities (11 shown, 1 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `769fd5bd`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- compilerOptions
- main.ts
- updater.ts
- devDependencies
- package.json
- biometric.ts
- scripts
- callPipWindow.ts
- exclude
- generate-icons.ts
- types.d.ts
- preload.ts

## God Nodes (most connected - your core abstractions)
1. `compilerOptions` - 20 edges
2. `scripts` - 11 edges
3. `setupBiometric()` - 7 edges
4. `setupUpdater()` - 6 edges
5. `setupCallPipWindow()` - 5 edges
6. `exclude` - 5 edges
7. `resolveDesktopFeed()` - 5 edges
8. `BrowserWindow` - 4 edges
9. `execFileP` - 3 edges
10. `isHardwareAvailable()` - 3 edges

## Surprising Connections (you probably didn't know these)
- `setupCallPipWindow()` --references--> `BrowserWindow`  [EXTRACTED]
  desktop/callPipWindow.ts → desktop/types.d.ts
- `setupUpdater()` --references--> `BrowserWindow`  [EXTRACTED]
  desktop/updater.ts → desktop/types.d.ts
- `setupTray()` --references--> `BrowserWindow`  [EXTRACTED]
  desktop/tray.ts → desktop/types.d.ts

## Import Cycles
- None detected.

## Communities (12 total, 1 thin omitted)

### Community 0 - "compilerOptions"
Cohesion: 0.09
Nodes (23): DOM, ES2022, node, compilerOptions, allowJs, allowSyntheticDefaultImports, checkJs, esModuleInterop (+15 more)

### Community 1 - "main.ts"
Cohesion: 0.11
Nodes (11): LEGACY_APP_DIR_NAMES, execFileP, gotTheLock, MIME_TYPES, NOTE: `frame-src` must allow https://embed.diagrams.net so the, shouldClearCache, VERSION_FILE, WINDOW_STATE_FILE (+3 more)

### Community 2 - "updater.ts"
Cohesion: 0.17
Nodes (16): buildBadgeDataUrl(), cleanReleaseNotes(), compareSemver(), DesktopFeed, DesktopLatestManifest, GitHubRelease, httpGetText(), OTA_BASE_URL (+8 more)

### Community 3 - "devDependencies"
Cohesion: 0.13
Nodes (15): cross-env, electron, electron-builder, devDependencies, cross-env, electron, electron-builder, png-to-ico (+7 more)

### Community 4 - "package.json"
Cohesion: 0.13
Nodes (14): electron-updater, author, email, name, dependencies, electron-updater, description, license (+6 more)

### Community 5 - "biometric.ts"
Cohesion: 0.27
Nodes (12): clearStore(), execFileP, isHardwareAvailable(), promptBiometric(), readStore(), setupBiometric(), STORE_FILE, StoredCredential (+4 more)

### Community 6 - "scripts"
Cohesion: 0.18
Nodes (11): scripts, build:all, build:client, build:client:local, build:linux, build:mac, build:main, build:win (+3 more)

### Community 7 - "callPipWindow.ts"
Cohesion: 0.39
Nodes (7): CallPipController, loadPipState(), PipBounds, PipState, savePipState(), setupCallPipWindow(), STATE_FILE()

### Community 8 - "exclude"
Cohesion: 0.25
Nodes (7): build, dist, icons, node_modules, *.ts, exclude, include

### Community 9 - "generate-icons.ts"
Cohesion: 0.50
Nodes (4): generate(), ICONS_DIR, renderPng(), SOURCE_PATH

### Community 10 - "types.d.ts"
Cohesion: 0.40
Nodes (4): App, Electron, NOTE: This file deliberately has NO top-level import/export so it stays an, Window

## Knowledge Gaps
- **78 isolated node(s):** `LEGACY_APP_DIR_NAMES`, `StoredCredential`, `STORE_FILE`, `WINRT_AWAIT_PREAMBLE`, `PipState` (+73 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `devDependencies` connect `devDependencies` to `package.json`?**
  _High betweenness centrality (0.044) - this node is a cross-community bridge._
- **Why does `compilerOptions` connect `compilerOptions` to `exclude`?**
  _High betweenness centrality (0.039) - this node is a cross-community bridge._
- **Why does `scripts` connect `scripts` to `package.json`?**
  _High betweenness centrality (0.034) - this node is a cross-community bridge._
- **What connects `LEGACY_APP_DIR_NAMES`, `StoredCredential`, `STORE_FILE` to the rest of the system?**
  _78 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `compilerOptions` be split into smaller, more focused modules?**
  _Cohesion score 0.08695652173913043 - nodes in this community are weakly interconnected._
- **Should `main.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.10526315789473684 - nodes in this community are weakly interconnected._
- **Should `devDependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.13333333333333333 - nodes in this community are weakly interconnected._