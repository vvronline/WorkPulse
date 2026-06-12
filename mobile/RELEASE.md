# WorkPulse Mobile — Release (APK) Guide

The Android release APK is built **automatically by GitHub Actions** on every
`mobile-vX.Y.Z` tag push (`.github/workflows/mobile-release.yml`). No local
Android SDK / EAS account is required.

## App icon

The launcher icon is the **same artwork as the desktop `.exe`**
(`desktop/icons/icon.svg`). The mobile launcher / splash / favicon PNGs in
`mobile/assets/` are generated from that SVG by:

```bash
cd mobile
npm run generate-icons   # writes assets/icon.png, splash-icon.png, favicon.png,
                         # android-icon-foreground/background/monochrome.png
```

These generated PNGs are committed and consumed by `expo prebuild` during the
CI build, so the APK ships with the desktop logo. Re-run the script and commit
whenever `desktop/icons/icon.svg` changes.

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