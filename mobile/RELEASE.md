# AINO Mobile - Release Guide (EAS Build / EAS Update / Play Store)

Primary distribution moved from sideloaded, debug-signed APKs to **EAS Build +
Google Play**. The in-app APK self-updater has been removed; the old
`mobile-vX.Y.Z` GitHub Actions workflow remains only as an optional signed-APK
mirror for testers and manual recovery. See `docs/AINO_EAS_MIGRATION_PLAN.md`
for the full migration, including the identifier rename to `app.aino.mobile`.

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

## Release decision and checklist

1. Classify the change before publishing:
   - JS/TypeScript, styling, or compatible bundled assets: use **EAS Update**.
   - Native dependency/config/plugin/permission changes: create a **new binary**.
2. For an OTA update, run the production command near the top of this guide,
   then verify it with:

   ```sh
   eas channel:view production
   eas update:list --branch production --json --non-interactive
   ```

   If the channel points to a differently named branch, use that branch name.
3. For a native release, bump `mobile/package.json`, build the preview APK, and
   complete the device smoke-test matrix before building/submitting the
   production AAB.
4. Confirm Profile → **Check for Updates** uses `expo-updates`: it checks,
   downloads, and restarts the app for a compatible EAS Update. It does not
   download or self-install APKs.
5. Monitor the production rollout and keep the last known-good update/build
   identifiable for rollback.

## Optional direct-download APK mirror

`.github/workflows/mobile-release.yml` can still publish the production-signed
`AINO-<version>.apk` to GitHub Releases and
`https://cdn.aino.org.in/mobile/...` for testers or manual recovery. A
`mobile-v<version>` tag must match `mobile/package.json` for that legacy mirror
workflow. This APK path is **not** EAS Update, is not used by the in-app update
button, and must not replace Play Store delivery for production users.

R2 setup and verification for this optional mirror are documented in
`docs/OTA_R2_MIGRATION_PLAN.md`.
