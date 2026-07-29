# AINO Mobile Release Guide (GitHub Actions + Cloudflare R2)

AINO mobile currently uses the same release model as desktop: GitHub Actions
builds a signed binary, immutable artifacts are stored in Cloudflare R2, and a
stable `latest.json` pointer drives the in-app update check. EAS Build and EAS
Update are not part of this release path.

## Release a new Android version

1. Bump `mobile/package.json#version` to numeric `X.Y.Z`.
2. Commit and push the change.
3. Create and push the matching tag:

   ```sh
   git tag mobile-vX.Y.Z
   git push origin mobile-vX.Y.Z
   ```

`.github/workflows/mobile-release.yml` validates the tag, runs Expo prebuild,
builds a production-signed arm64 APK and AAB, verifies the signing certificate
and version metadata, creates the GitHub release, then publishes:

- `mobile/releases/mobile-vX.Y.Z/AINO-X.Y.Z.apk` (immutable)
- `mobile/latest.json` (no-cache stable pointer)

The workflow must have `R2_PUBLIC_BASE_URL` configured as a repository variable.
That value is baked into the APK as `EXPO_PUBLIC_OTA_BASE_URL`.

## Version codes

`app.config.ts` derives Android's monotonically increasing native version code:

```text
X.Y.Z -> X * 1,000,000 + Y * 1,000 + Z
2.0.74 -> 2,000,074
```

Each component must be between 0 and 999. Android uses this integer—not the
displayed version name—to decide whether an APK can replace the installed app.

## In-app updater

On launch and from Profile → **Check for Updates**, Android reads
`${R2_PUBLIC_BASE_URL}/mobile/latest.json`. When a newer version exists, AINO
downloads the signed APK with progress and opens Android's package installer.
The user may need to enable **Install unknown apps** for AINO.

If R2 cannot be reached, the app tries the matching GitHub mobile release as a
fallback. This fallback only works when the GitHub release is publicly readable.

Verify a release before announcing it:

```sh
curl -fsS https://cdn.aino.org.in/mobile/latest.json
curl -I https://cdn.aino.org.in/mobile/releases/mobile-vX.Y.Z/AINO-X.Y.Z.apk
```

Then update from the previous signed APK on a physical arm64 Android device and
test login, FCM, incoming calls, notification taps, PiP, and `aino://` links.

## Firebase and signing

The package is `app.aino.mobile` and Firebase project is `aino-86bb6`. GitHub
Actions materializes ignored `google-services.json` and the release keystore
from repository secrets. Never commit either file or signing passwords.

## Future Google Play distribution

The direct APK updater is intended for sideload distribution. Before shipping an
AAB through Google Play, review Play policy and remove/disable APK self-install:

- remove `android.permission.REQUEST_INSTALL_PACKAGES`;
- remove the in-app binary installer;
- use Play-managed updates for Play-installed builds.

The workflow already creates an AAB, but uploading it to Play is a separate,
future release step.
