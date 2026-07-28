# AINO Mobile - Release Guide (EAS Build / EAS Update / Play Store)

Distribution moved from sideloaded, debug-signed APKs to **EAS Build + Google
Play**. The old `mobile-vX.Y.Z` GitHub Actions workflow and the in-app APK
self-updater have been removed - see `docs/AINO_EAS_MIGRATION_PLAN.md` for the
full migration, including the identifier rename to `app.aino.mobile`.

## Ship a JS-only change (OTA, seconds)

```sh
cd mobile
eas update --channel production --message "<what changed>" --environment production
```

`--environment` is required on SDK 55+. This swaps the JS bundle only. Anything
that touches native code (a new dependency with native code, a config plugin, a
permission, an app icon) needs a full build instead - the `fingerprint` runtime
policy will bump the runtime version automatically so old binaries correctly
ignore the update.

## Ship a native change (full build + store submit)

```sh
cd mobile
eas build -p android --profile preview      # smoke test first (APK, internal)
eas build -p android --profile production   # AAB for Play
eas submit -p android --profile production  # -> internal track, draft
```

Or in one step once the flow is trusted:
`eas build -p android --profile production --auto-submit`.

`versionCode` is managed remotely (`cli.appVersionSource: "remote"` +
`autoIncrement`), so do not hand-edit it. The user-facing version still comes
from `mobile/package.json`.

## Firebase / push

The app is on Firebase project `aino-86bb6` (package `app.aino.mobile`). The
server must hold a service-account key from the SAME project in
`FIREBASE_SERVICE_ACCOUNT_KEY`, or every send fails with `mismatched-credential`
and no push is delivered. `google-services.json` is gitignored and reaches EAS
through the `GOOGLE_SERVICES_JSON` file env var.

## Native call parity prerequisites (WhatsApp/Teams-style incoming calls)

For lock-screen/background incoming-call UI and "answer without manually opening
the app", this project now requires a **custom native build path** (Expo
prebuild + native modules). Before cutting a release:

1. Ensure native dependencies are installed in `mobile/package.json`:
   - `react-native-callkeep`
   - `@react-native-firebase/app`
   - `@react-native-firebase/messaging`
2. Run `expo prebuild` and commit any required native config/plugin outputs.
3. Verify Android permissions in `mobile/app.config.ts` include:
   - `POST_NOTIFICATIONS`
   - `USE_FULL_SCREEN_INTENT`
   - `FOREGROUND_SERVICE_PHONE_CALL`
   - `WAKE_LOCK`
4. Verify Firebase service-account config is present in server env
   (`FIREBASE_SERVICE_ACCOUNT_KEY`).

### Native parity release checklist

- [ ] `mobile/src/services/pushNotificationService.ts` contains `calls` and `messages` channels.
- [ ] `mobile/src/realtime/PushNotificationListener.tsx` includes permission recovery UX (settings deep-link).
- [ ] `mobile/src/realtime/socket.ts` includes bounded backoff send helper for call signaling.
- [ ] `mobile/app/call/[conversationId].tsx` uses reconnect-safe call action sends (`accept/reject/end`).
- [ ] `server/utils/ws.ts` enforces idempotent call actions + terminal state guards.
- [ ] `server/services/pushNotifications.ts` includes structured push dispatch attempt/result logs.
- [ ] `specs/20260617-024245-call-notification-parity/quickstart.md` device matrix is executed and signed off.

## App icon

The launcher icon is the **same artwork as the desktop `.exe`**
(`desktop/icons/icon-source.png`). The mobile launcher / splash / favicon PNGs in
`mobile/assets/` are generated from that source by:

```bash
cd mobile
npm run generate-icons   # writes assets/icon.png, splash-icon.png, favicon.png,
                         # android-icon-foreground/background/monochrome.png
```

These generated PNGs are committed and consumed by `expo prebuild` during the
CI build, so the APK ships with the desktop logo. Re-run the script and commit
whenever `desktop/icons/icon-source.png` changes.

## Cutting a release

1. Bump the version in `mobile/package.json` (e.g. `1.0.12`). The CI **validates
   that the tag matches this version** and fails otherwise.
2. Commit the bump (and any icon regen) to the default branch.
3. Tag and push:

   ```bash
   git tag mobile-v1.0.12
   git push origin mobile-v1.0.12
   ```

4. The `Mobile Release` workflow runs:
   - `expo prebuild` → generates the native Android project (using the committed
     icons).
   - Gradle `assembleRelease` → builds `WorkPulse-<version>.apk` (arm64-v8a).
   - Publishes a GitHub Release `mobile-v<version>` with the APK + SHA-256
     checksums attached.

5. Download `WorkPulse-<version>.apk` from the published release and sideload it
   (allow "install from unknown sources" on the device).

> Note: the APK is signed with the Expo-generated debug keystore (fine for
> internal/sideload distribution, same as the desktop builds). For a
> Play-Store-signed build, wire a release `signingConfig` via an Expo config
> plugin so it survives `expo prebuild`.

## In-app updater

The app checks GitHub for a newer **mobile** release on launch and from
**Profile → Check for Updates**. This is fully independent of the desktop
auto-updater:

- **Mobile** looks only at `mobile-vX.Y.Z` tags and downloads the
  `WorkPulse-<version>.apk` asset (`mobile/src/updater.ts`).
- **Desktop** looks only at `vX.Y.Z` tags + `latest.yml` (electron-updater).

When a newer version is found, a themed modal (`UpdateChecker`) shows the
release notes and a **Download & Install** button that downloads the APK
in-app (with a progress bar) and hands it to the Android package installer.

The current version is read from `mobile/package.json` via `app.config.ts`
(`extra.APP_VERSION`) — keep `package.json` as the single source of truth so
the updater compares versions correctly.

> ⚠️ **Signature must stay stable across updates.** Android refuses to install
> an update whose signing key differs from the installed app
> ("signatures do not match"). Since the CI signs the `release` build with the
> Expo debug keystore regenerated by `expo prebuild`, ensure that key stays
> consistent (or commit a fixed keystore and wire it via a config plugin). If
> users hit a signature-mismatch error, they must uninstall the old app first.
