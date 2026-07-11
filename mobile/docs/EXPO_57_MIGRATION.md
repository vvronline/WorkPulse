# Expo SDK 57 Migration — Feasibility, Risks & Plan

> Scope: the `mobile/` React Native app only. Assessed against the previous
> **Expo SDK 56** baseline (`expo ~56.0.9`, `react-native 0.85.3`, `react 19.2.3`).

## ✅ Migration Status: EXECUTED (SDK 56 → 57)

The upgrade has been applied to `mobile/`. Results:

| Step | Result |
| --- | --- |
| `expo@^57.0.4` + `expo install --fix` | ✅ All `expo-*` re-pinned to `~57.x`; `react-native 0.85.3 → 0.86.0`; `react` stays `19.2.3` |
| `react-native-reanimated 4.3.1 → 4.5.0`, `react-native-gesture-handler ~2.32.0`, `react-native-view-shot 4.0.3 → 5.1.0`, `@shopify/flash-list 2.1.0 → 2.0.2`, `@expo/ui ~57.0.4` | ✅ Installed |
| `babel-preset-expo → ~57.0.0` | ✅ Updated |
| `@config-plugins/react-native-webrtc@^15.0.1` peer conflict (pins `expo@^56`) | ⚠️ Resolved with `npm install --legacy-peer-deps` (build-time plugin only; peer range lags SDK) |
| `react-native-webrtc` patch (`124.0.7`) | ✅ Version unchanged → patch applied cleanly, no refresh needed |
| `npx tsc --noEmit` | ✅ Passes (1 fix: `react-native-view-shot@5` — `useRef<ViewShot>` → `useRef<React.ComponentRef<typeof ViewShot>>` in `MediaEditor.tsx`) |
| `expo prebuild --clean` (Android) | ✅ Completed; all asset/manifest config plugins ran |
| Config-plugin injections into `MainActivity.kt` | ✅ `withAndroidPip` (imports + PiP overrides) and `withAndroidNewIntent` (`onNewIntent`) injected correctly against the SDK 57 template; `withAndroidCallActivityFlags` is an intentional no-op |
| `AndroidManifest.xml` | ✅ `supportsPictureInPicture="true"`, merged `configChanges`, `singleTask`, all call/foreground-service permissions, single Firebase notification meta-data (`tools:replace`, no merge conflict) |
| Local native modules autolinking | ✅ `pip`, `call-ringer`, `lock-screen` all discovered by SDK 57 autolinking |

### Remaining to do (requires Android SDK + device/CI)
- [ ] `eas build --profile development --platform android` (or `npx expo run:android`) and run the on-device smoke-test checklist below.
- [ ] `@types/jest` was left at `^30.0.0` (test-only types); `--fix` suggested `29.5.14`. Change only if Jest type errors appear.

### Note: `--legacy-peer-deps`
The single peer conflict is `@config-plugins/react-native-webrtc@15.0.1` declaring
`peer expo@^56`. It is a **build-time config plugin** (injects WebRTC
permissions/native bridging during prebuild; ships no runtime native code), so
the lagging peer range is cosmetic. Until the plugin publishes an `expo@^57`
peer, install with `npm install --legacy-peer-deps` (or add an `overrides`/
`.npmrc legacy-peer-deps=true` entry for CI/EAS).

---

## TL;DR

Migrating to **Expo SDK 57 is feasible and low-to-medium risk**. SDK 57 is a
stability-focused release that bumps the runtime **React Native 0.85 → 0.86**,
keeps **React at 19.2**, and ships **no user-facing breaking changes**. All of
our community native dependencies carry forward (see compatibility matrix).

The remaining risk is concentrated **entirely in this app's own native
customizations** — not in Expo or the third-party libraries. Those custom
pieces must be re-verified against the regenerated SDK 57 prebuild output.

---

## Current Baseline (SDK 56)

| Area | Detail |
| --- | --- |
| Core | `expo ~56.0.9`, `react-native 0.85.3`, `react 19.2.3`, `react-dom 19.2.3` |
| Animation | `react-native-reanimated 4.3.1` + `react-native-worklets/plugin` (babel) |
| UI | `@expo/ui ~56.0.21`, `@shopify/flash-list 2.1.0` |
| Build model | **CNG / prebuild** — no committed `android/` folder |
| Local native modules | `modules/pip`, `modules/call-ringer`, `modules/lock-screen` |
| Config plugins | 10 custom plugins under `scripts/` |
| Patches | `patches/react-native-webrtc+124.0.7.patch` (via `patch-package`) |
| Experiments | `experiments.reactCompiler: true` (React Compiler) |

### ~30 `expo-*` packages
All pinned to `~56.x` (audio, build-properties, camera, clipboard, constants,
document-picker, file-system, font, image-manipulator, image-picker,
intent-launcher, keep-awake, linear-gradient, linking, local-authentication,
location, media-library, notifications, router, secure-store, sharing,
splash-screen, status-bar, video, video-thumbnails).

---

## Compatibility Matrix (SDK 57)

| Package | Compatible | Notes |
| --- | --- | --- |
| `@expo/ui` | ✅ | First-party, native support out of the box. |
| `react-native-mmkv` | ✅ | JSI/C++ — requires a Development Build (already our model). |
| `@react-native-firebase/*` | ✅ | Official config plugins; `expo install` auto-aligns versions. |
| `@notifee/react-native` | ✅ | Works via CNG dev clients. |
| `react-native-webrtc` | ✅ | Works with `@config-plugins/react-native-webrtc` (already configured). |
| `react-native-callkeep` | ✅ | Works with its companion config plugin. |
| Standard `expo-*` | ✅ | Straightforward re-pin via `expo install`. |

> All native-code libs above **cannot run in Expo Go** — they require Expo
> Development Builds via `expo prebuild`. This is already how we build.

---

## Risk Register

### 🟡 Medium — our custom native surface (the real focus)

1. **Config plugins that regex-inject Kotlin into `MainActivity`**
   - `scripts/withAndroidPip.js`
   - `scripts/withAndroidNewIntent.js`
   - `scripts/withAndroidCallActivityFlags.js`
   - These match `class MainActivity : ReactActivity()` and inject overrides /
     imports. A minor prebuild-template change in SDK 57 could change the
     `MainActivity.kt` shape and cause a silent skip or a broken injection.
   - **Mitigation:** run `expo prebuild --clean` and **diff the generated
     `MainActivity.kt` and `AndroidManifest.xml`** to confirm each plugin still
     hits its target.

2. **Three local Expo native modules** (`pip`, `call-ringer`, `lock-screen`)
   - Kotlin written against the Expo Modules API must compile against SDK 57's
     `expo-modules-core`.
   - **Mitigation:** rebuild and fix any API drift.

3. **`react-native-webrtc` patch pinned to `124.0.7`**
   - `patches/react-native-webrtc+124.0.7.patch` only applies to that exact
     version. If `expo install` / the webrtc plugin pulls a different version,
     `patch-package` will warn/fail.
   - **Mitigation:** re-pin the version or regenerate the patch.

4. **Reanimated v4 + worklets plugin + React Compiler + `babel-preset-expo`**
   - These are tightly coupled. Bump together to SDK 57-matched versions.
   - The worklets plugin **must remain the last** babel plugin.

### 🟢 Low

5. **Firebase / notification manifest-merge plugins** — historically fragile:
   - `scripts/withRemoveExpoFirebaseMessagingService.js`
   - `scripts/withFirebaseNotificationChannelOverride.js`
   - `scripts/withAndroidNotificationIcon.js`
   - `scripts/withAndroidRingtoneAssets.js`
   - **Mitigation:** verify manifest merge succeeds after prebuild (no
     duplicate `default_notification_icon`/`_color` meta-data).

6. **Gradle / AGP / JDK** — a minor RN bump may still nudge tooling versions.
   - `scripts/withAndroidGradleMemory.js` re-applies the JVM heap settings that
     keep the release build from OOMing — keep it intact.
   - Confirm the EAS build image is current.

7. **Metro custom config** (`metro.config.js`) — `inlineRequires`,
   `sourceExts` (`mjs`/`cjs`). Metro API is stable; validate after bump.

### ℹ️ Note (unchanged by this migration)
- `react-native-callkeep` native call UI is **feature-flagged OFF**
  (`ANDROID_NATIVE_CALL_UI` defaults `false` in `app.config.ts` due to prior
  startup crashes). SDK 57 alone does not change that; keep it off unless a
  stable callkeep build is separately verified.

---

## Migration Steps

Run all commands from `mobile/`.

1. **Bump Expo core**
   ```bash
   npm install expo@^57
   npx expo install --fix
   ```
   `--fix` re-pins all `expo-*`, `react-native`, `react`, `reanimated`,
   `screens`, `safe-area-context`, `@react-native-firebase/*`, etc. to the
   SDK 57-matched versions.

2. **Update dev dependencies**
   ```bash
   npx expo install babel-preset-expo @types/react
   ```
   Bump `react-native-worklets` (worklets plugin) to the reanimated-matched
   version if `--fix` doesn't.

3. **Regenerate native project & verify plugins**
   ```bash
   npx expo prebuild --clean
   ```
   Then **diff the generated files** and confirm the injecting plugins applied:
   - `android/app/src/main/java/.../MainActivity.kt` — PiP overrides,
     `onNewIntent`, call-activity flags present.
   - `android/app/src/main/AndroidManifest.xml` — `supportsPictureInPicture`,
     merged `configChanges`, permissions, no duplicate Firebase meta-data.

4. **Recompile local native modules**
   - Ensure `modules/pip`, `modules/call-ringer`, `modules/lock-screen` compile
     against SDK 57 `expo-modules-core`; fix any API changes.

5. **Refresh the webrtc patch (if version changed)**
   ```bash
   # if react-native-webrtc version moved off 124.0.7:
   npx patch-package react-native-webrtc
   # (re-apply/verify our diff, rename the patch file to the new version)
   ```

6. **Type check**
   ```bash
   npx tsc --noEmit
   ```
   (We already track output in `tsc-out.txt`.)

7. **Build & smoke test (development profile first)**
   ```bash
   eas build --profile development --platform android
   ```
   Then verify on device:
   - [ ] WebRTC audio + video calls connect
   - [ ] Picture-in-Picture shrinks a live call on leave (Android)
   - [ ] Incoming-call ring / full-screen intent over lock screen
   - [ ] Push notifications (Firebase + Notifee) in foreground / background / killed
   - [ ] Notification tap opens the correct chat (onNewIntent)
   - [ ] Biometric login (local-authentication + secure-store)
   - [ ] Camera / image picker / media library share flows
   - [ ] MMKV-backed persistence survives restart
   - [ ] Reanimated worklets (Kanban drag-and-drop)

8. **Promote builds** — once the dev build is verified, run `preview` then
   `production` EAS builds.

---

## Rollback

Because native is regenerated (CNG), rollback is a git revert of `mobile/`
`package.json` + `package-lock.json` (and any plugin edits) followed by a clean
`npx expo prebuild --clean`. No committed `android/` state to unwind.