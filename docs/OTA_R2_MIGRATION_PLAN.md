# AINO OTA and Cloudflare R2 Migration Runbook

> **Domain:** `www.aino.org.in`
>
> **R2 delivery host:** `https://cdn.aino.org.in`
>
> **Last repository and DNS review:** 2026-07-29
>
> **Rollout status:** Desktop OTA and R2 publication are working. The mobile
> signed APK/AAB build is currently in progress; mobile publication and device
> verification are still pending.

This runbook replaces the original WorkPulse-era plan. The mobile architecture
has changed since that plan was written: mobile JavaScript OTA updates now use
**EAS Update**, not an in-app APK installer. Cloudflare R2 remains the delivery
origin for desktop installers and can optionally host directly downloadable
Android APKs.

## 1. Final architecture

| Product | Update type | Production delivery service | Public endpoint |
| --- | --- | --- | --- |
| Desktop | Native Electron installers and `latest*.yml` | Cloudflare R2 | `https://cdn.aino.org.in/desktop/...` |
| Mobile | Compatible JS, styling, and bundled assets | EAS Update | `https://u.expo.dev/dcccf532-ce8b-431c-bb2d-bc99866d14fd` |
| Mobile | Native Android changes | Google Play / signed AAB | Play Store |
| Mobile (optional) | Signed APK for testers/sideloading | Cloudflare R2 | `https://cdn.aino.org.in/mobile/...` |
| Web/API/WebSocket | Application traffic | Existing Railway deployment | `https://www.aino.org.in` |

`www.aino.org.in` must remain the application host. Do **not** connect the R2
bucket to `www.aino.org.in`, because that would replace the current Railway
CNAME and break the website, `/api`, and WebSocket traffic. Use the unused
`cdn.aino.org.in` subdomain for R2.

### R2 object layout

```text
aino-releases/                         # suggested bucket name
  desktop/
    latest.json                       # no-store; points to the latest vX.Y.Z
    releases/v1.7.62/
      latest.yml
      latest-mac.yml
      latest-linux.yml
      *.exe, *.blockmap, *.dmg, *.zip, *.AppImage, *.deb
  mobile/                              # optional direct-download channel
    latest.json
    releases/mobile-v2.0.73/
      AINO-2.0.73.apk
```

Versioned objects are immutable and may be cached for one year. Stable pointer
files such as `latest.json` must use `Cache-Control: no-cache, no-store,
must-revalidate`.

## 2. Current repository state

### Already implemented

- [x] `mobile/app.config.ts` installs/configures `expo-updates`, uses the EAS
      project `@aino/aino`, and uses the fingerprint runtime policy.
- [x] `mobile/eas.json` defines `development`, `preview`, and `production`
      channels.
- [x] `mobile/app/profile.tsx` checks, downloads, and reloads EAS updates with
      `expo-updates`.
- [x] The old mobile APK self-updater and `UpdateChecker` component are gone.
- [x] Desktop and mobile release workflows contain R2 upload and five-release
      pruning jobs.
- [x] Desktop updater code can read `desktop/latest.json` and then configure an
      `electron-updater` generic feed.
- [x] Mobile release artifacts have been renamed to `AINO-<version>.apk`.
- [x] A desktop release has uploaded successfully to R2 and an installed desktop
      client has completed an OTA update from the R2 channel.
- [x] The public desktop pointer is live: on 2026-07-29 it returned HTTP 200,
      `{ "version": "1.7.63", "tag": "v1.7.63" }`, with `Cache-Control:
      no-cache, no-store, must-revalidate`.

### Remaining work and known blockers

- [x] `aino.org.in` uses Cloudflare authoritative nameservers
      (`aiden.ns.cloudflare.com` and `braelyn.ns.cloudflare.com`).
- [x] `cdn.aino.org.in` resolves through Cloudflare and serves the connected R2
      bucket over TLS. An unknown object returns Cloudflare's R2 404 page.
- [x] The bucket, cache configuration, scoped credentials, and GitHub Actions
      values are configured (account configuration confirmed by the owner).
- [x] Desktop ships `https://cdn.aino.org.in` as its default update origin while
      retaining a temporary GitHub discovery fallback for transition.
- [x] Desktop no longer fetches release notes from GitHub; it uses updater
      manifest metadata and accepts empty notes.
- [x] Stale mobile `EXPO_PUBLIC_OTA_BASE_URL` configuration and APK self-updater
      documentation have been removed.

### Execution status (follow in this order)

| Order | Action | Owner/status |
| --- | --- | --- |
| 1 | Move the `aino.org.in` DNS zone to Cloudflare without changing `www` behavior | **Complete and publicly verified** |
| 2 | Create `aino-releases` and connect `cdn.aino.org.in` | **Complete and publicly verified** |
| 3 | Configure cache, scoped R2 credentials, and GitHub Actions values | **Complete — owner confirmed** |
| 4 | Ship the desktop R2 default and remove private-GitHub note lookup | **Complete** |
| 5 | Clean stale mobile OTA configuration/docs | **Complete** |
| 6 | Publish and verify desktop OTA through R2 | **Complete — owner tested; public pointer independently verified at v1.7.63** |
| 7 | Build signed mobile APK/AAB and optionally mirror the APK to R2 | **In progress — do not mark complete until CI, pointer, signature, and device checks pass** |
| 8 | Verify EAS Update against the resulting compatible mobile runtime | Pending after the native build is installed |
| 9 | Make GitHub optional/private and finish hardening | Follow-up after recovery-path verification |

Initial public verification on 2026-07-29 found:

- the Cloudflare nameservers above are authoritative;
- `https://www.aino.org.in/` returns HTTP 200 with Railway response headers;
- `https://cdn.aino.org.in/does-not-exist` returns the Cloudflare R2 object 404;
- both update pointer paths returned 404 before the first publication.

After the desktop release, a second public check on 2026-07-29 found:

- `https://cdn.aino.org.in/desktop/latest.json` returns HTTP 200 and identifies
  `v1.7.63`;
- the desktop pointer has `no-cache, no-store, must-revalidate`;
- `https://cdn.aino.org.in/mobile/latest.json` still returns HTTP 404 while the
  mobile build is in progress. This is expected until `publish-r2` completes.

GitHub configuration values cannot be read back publicly, and the local GitHub
CLI was not authenticated during verification. Their presence and values are
therefore recorded as owner-confirmed; the fail-closed `r2-config` job performs
the authoritative check during the first release.

Do not make the GitHub repository private until the CDN setup is complete and
the transitional release in Step 8 has been verified on real installations.

## 3. Step 1 — Move authoritative DNS to Cloudflare

Cloudflare R2's production custom-domain integration only accepts a domain in an
active Cloudflare zone. A CNAME at GoDaddy pointing to an `r2.dev` URL is not a
supported substitute; `r2.dev` is rate-limited and intended only for testing.

1. In Cloudflare, select **Add a domain** and enter `aino.org.in`.
2. Let Cloudflare import the existing DNS records.
3. Before changing nameservers, compare every imported record with GoDaddy.
   At minimum, preserve:
   - `www` CNAME → `isyoncpi.up.railway.app`
   - apex/root forwarding or records used for `aino.org.in`
   - all MX, SPF, DKIM, DMARC, verification, and other TXT records
   - any server, mail, TURN, or other application subdomains
4. For the Railway `www` CNAME, start with **DNS only** while validating. Proxying
   can be enabled later only after HTTP and WebSocket behavior is confirmed.
5. At the registrar, replace the GoDaddy nameservers with the two nameservers
   assigned by Cloudflare.
6. Wait until Cloudflare reports the zone as **Active**.
7. Verify the existing app before touching R2:

   ```bash
   nslookup -type=ns aino.org.in
   nslookup www.aino.org.in
   curl -I https://www.aino.org.in/
   curl -I https://www.aino.org.in/api/health
   ```

   Use the real health endpoint if `/api/health` is not defined. Also open the
   web app and test login plus one WebSocket-driven feature.

Do not manually create `cdn` at GoDaddy before this move. After the zone is
active, connecting the R2 custom domain in Step 2 lets Cloudflare create and
manage the correct record and certificate. As verified on 2026-07-29, the live
baseline is `www` CNAME → `isyoncpi.up.railway.app`; preserve that exact record.

**Exit criterion:** Cloudflare is authoritative and `www.aino.org.in` still
serves the existing application without an API or WebSocket regression.

## 4. Step 2 — Create and expose the R2 bucket

1. Cloudflare Dashboard → **R2 Object Storage** → **Create bucket**.
2. Use `aino-releases` as the bucket name. Keeping an existing bucket name is
   also valid; the exact value must match the GitHub `R2_BUCKET` variable.
3. Leave location as Automatic unless there is a specific residency need.
4. Bucket → **Settings** → **Custom Domains** → **Connect Domain**.
5. Enter `cdn.aino.org.in` and complete the connection. Cloudflare creates and
   manages the necessary DNS record and TLS certificate.
6. Do not enable the public `r2.dev` URL for production. It may be temporarily
   enabled for a smoke test, then disabled after the custom domain works.
7. Verify TLS and the host (a missing object should return an R2/Cloudflare 404,
   not Railway content):

   ```bash
   curl -I https://cdn.aino.org.in/does-not-exist
   ```

**Exit criterion:** `cdn.aino.org.in` resolves over HTTPS to the R2 bucket while
`www.aino.org.in` remains unchanged.

## 5. Step 3 — Configure cache and CORS

### Cache

The workflows already upload versioned assets with:

```text
Cache-Control: public, max-age=31536000, immutable
```

and stable pointer manifests with:

```text
Cache-Control: no-cache, no-store, must-revalidate
```

Add a Cloudflare Cache Rule for host `cdn.aino.org.in`:

- If URI path ends with `/latest.json`: **Bypass cache**.
- Optionally cache all other eligible R2 object types, respecting origin cache
  control. Cloudflare does not cache every file type by default.

Do not purge immutable version folders during a normal release. If a released
binary is wrong, publish a new version instead of overwriting the old folder.

### CORS

Electron and React Native native networking are not browser CORS clients, so
CORS is not required for the current desktop updater or EAS Update. Configure
read-only CORS only if browser pages will fetch files from the CDN:

```json
[
  {
    "AllowedOrigins": ["https://www.aino.org.in"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3600
  }
]
```

Prefer the explicit website origin over `*`.

## 6. Step 4 — Create least-privilege R2 credentials

1. Cloudflare Dashboard → **R2** → **Manage R2 API Tokens**.
2. Create a token with **Object Read & Write** scoped only to `aino-releases`.
3. Record the Access Key ID and Secret Access Key once.
4. Record the Cloudflare Account ID.
5. Do not expose these values in source, logs, Expo public variables, or GitHub
   repository variables.

The S3 endpoint used by CI is:

```text
https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com
```

Rotate the token immediately if a credential is printed or committed.

## 7. Step 5 — Configure GitHub Actions

Repository → **Settings** → **Secrets and variables** → **Actions**.

### Secrets

| Name | Value |
| --- | --- |
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | Scoped R2 token access key |
| `R2_SECRET_ACCESS_KEY` | Scoped R2 token secret |

### Variables

| Name | Value |
| --- | --- |
| `R2_BUCKET` | `aino-releases` (or the actual bucket name) |
| `R2_PUBLIC_BASE_URL` | `https://cdn.aino.org.in` (no trailing slash) |

The desktop workflow now fails its `r2-config` job when any required secret or
variable is absent, or when `R2_PUBLIC_BASE_URL` is not exactly
`https://cdn.aino.org.in`. Mobile R2 publishing remains an optional APK mirror
and may still skip when R2 configuration is unavailable.

**Exit criterion:** all five names exist, secrets are masked, and
`R2_PUBLIC_BASE_URL` contains exactly `https://cdn.aino.org.in`.

## 8. Step 6 — Finish the desktop implementation

These code changes were completed locally on 2026-07-29; retain this checklist
for review before the first transitional release:

1. [x] In `desktop/updater.ts`, give production builds a shipped default:

   ```ts
   const OTA_BASE_URL = (
     process.env.OTA_BASE_URL || "https://cdn.aino.org.in"
   ).replace(/\/+$/, "");
   ```

   A generated build-time config is also acceptable. Merely setting an
   environment variable in GitHub Actions is not sufficient unless the build
   process explicitly substitutes it into the packaged JavaScript.
2. [x] Keep GitHub resolution as a temporary fallback for the transitional build.
3. [x] Stop fetching release notes directly from GitHub, or accept empty release
   notes when `latest*.yml` has none. A private repository will return 404/403 to
   installed apps without a token.
4. [x] Never embed a GitHub or R2 write token in the desktop app.
5. Run:

   ```powershell
   cd D:\Learnings\WorkPulse\desktop
   npm run typecheck
   npm run build:main
   ```

6. Inspect compiled `desktop/updater.js` and confirm the CDN production default
   is present.

**Exit criterion:** an installed desktop app uses R2 without requiring a user to
define `OTA_BASE_URL` on their machine.

## 9. Step 7 — Clean up the mobile release path

Mobile has two intentionally separate delivery paths:

### EAS Update: JS and compatible assets

Publish from the mobile directory:

```bash
cd mobile
eas project:info
eas update --channel production --message "Describe the change" --environment production
```

EAS Update can deliver only changes compatible with the installed build's
runtime. The current fingerprint runtime policy prevents native-incompatible
updates from reaching the wrong binary. Changes to native modules, config
plugins, permissions, Android/iOS configuration, or native dependencies require
a new store build.

After publishing, verify the update group and monitor it:

```bash
eas update:list --branch production --json --non-interactive
eas channel:insights --channel production --runtime-version <runtime> --json --non-interactive
```

If the production channel maps to a differently named branch, use the branch
shown by `eas channel:view production`.

### Native mobile builds

- Production store delivery should be an EAS/Play Store AAB.
- `.github/workflows/mobile-release.yml`, triggered by a matching
  `mobile-vX.Y.Z` tag, builds a production-signed arm64 APK and AAB with Expo
  prebuild + Gradle. It publishes GitHub release assets and may mirror the APK to
  `cdn.aino.org.in/mobile/...` for testers and manual recovery.
- The app must not download and self-install that APK. The current profile
  update button correctly uses EAS Update.
- [x] Remove stale `EXPO_PUBLIC_OTA_BASE_URL` from the mobile workflow because no
  mobile source consumes it.
- [x] Update `mobile/RELEASE.md` to remove references to `mobile/src/updater.ts`,
  `UpdateChecker`, debug signing, and `WorkPulse-<version>.apk`.

The optional `mobile/latest.json` is a download-page manifest, not an EAS Update
manifest and not the source used by `expo-updates`.

**Current status (2026-07-29):** the mobile workflow build is in progress. A
missing public `mobile/latest.json` is therefore not yet a failure. After CI
finishes, require all of the following before recording success:

1. the build and release jobs complete and signature verification reports the
   expected AINO production certificate;
2. the APK and AAB are attached to the GitHub Release;
3. if R2 is enabled, `publish-r2` completes and `mobile/latest.json` returns the
   built version and a reachable immutable APK URL;
4. install the APK on a physical arm64 Android device and smoke-test login, FCM,
   incoming calls, notification taps, PiP, and `aino://` deep links;
5. publish a compatible EAS Update and confirm the installed build downloads and
   reloads it from the production channel.

## 10. Step 8 — Publish a transitional desktop release

This order is mandatory if the GitHub repository will become private.

1. Finish Steps 1–7 on the default branch.
2. Bump `desktop/package.json` and create the matching `vX.Y.Z` tag.
3. Push the tag. The current workflow should publish the same installers to both
   R2 and GitHub Releases. R2 upload and public-pointer verification must succeed
   before the GitHub Release job is allowed to publish.
4. In the workflow log, confirm:
   - `r2-config` reports `enabled=true`;
   - `publish-r2` uploads installers and all `latest*.yml` files;
   - `desktop/latest.json` is written last;
   - the public-pointer verification step matches the uploaded JSON through
     `https://cdn.aino.org.in`;
   - pruning retains the newest five version directories.
5. Test an older desktop installation that still discovers the transitional
   release through GitHub. Install it.
6. From the transitional build, trigger another update check and confirm logs
   reference `https://cdn.aino.org.in/desktop/...`.
7. Publish one more desktop version and verify the transitional build discovers,
   downloads, and installs it from R2.

Only after both releases work may GitHub delivery be considered optional.

## 11. Step 9 — Verification commands

Replace placeholders with a release produced by the workflows.

```bash
# DNS and TLS
nslookup cdn.aino.org.in
curl -I https://cdn.aino.org.in/desktop/latest.json

# Desktop pointer and feed
curl -fsS https://cdn.aino.org.in/desktop/latest.json
curl -I https://cdn.aino.org.in/desktop/releases/v<version>/latest.yml

# Optional sideload APK
curl -fsS https://cdn.aino.org.in/mobile/latest.json
curl -I https://cdn.aino.org.in/mobile/releases/mobile-v<version>/AINO-<version>.apk
```

Expected results:

- [x] `desktop/latest.json` is HTTP 200, valid JSON, and identifies the release
      folder that actually exists.
- [x] The desktop pointer response is not stored by the CDN/browser cache.
- [ ] Versioned installer responses are HTTP 200 and immutable-cacheable.
- [ ] `latest*.yml` paths and SHA-512 metadata match uploaded installers.
- [ ] Windows, macOS, and Linux checks use the correct platform manifest.
- [x] An installed desktop build updates completely from R2 (owner-verified).
- [ ] `www.aino.org.in`, `/api`, and WebSockets still work.
- [ ] A production mobile build receives a compatible EAS Update.
- [ ] A native mobile change is delivered through a new binary, not EAS Update.
- [ ] The in-progress mobile workflow finishes, verifies its production
      signature, and (when configured) publishes `mobile/latest.json` plus the
      immutable APK to R2.
- [ ] After a sixth release, each R2 channel retains only five version folders.

## 12. Step 10 — Cut over and harden

After the transitional and R2-only desktop releases pass:

1. Make the GitHub repository private if desired.
2. Verify a fresh desktop install and an existing install can update while logged
   out of GitHub.
3. Remove desktop GitHub release discovery and HTML scraping. Retaining GitHub
   Releases for internal changelog/history is optional.
4. Change desktop release CI so missing R2 configuration is a hard failure.
5. Keep GitHub Actions artifacts long enough for recovery even if public GitHub
   Releases are removed.
6. Add a scheduled monitor for:
   - `https://cdn.aino.org.in/desktop/latest.json` availability and JSON shape;
   - the referenced `latest*.yml` and installer objects;
   - certificate expiry/TLS failures;
   - accidental cache storage of `latest.json`.
7. Rotate the R2 token on an operational schedule and whenever maintainers with
   access leave the project.

Old desktop installations that never receive the transitional build still point
to GitHub and may be stranded after privatization. Keep a public recovery link
to the latest signed installer on `cdn.aino.org.in` and document the one-time
manual upgrade.

## 13. Rollback procedures

### Bad EAS Update

1. Stop further publishing.
2. In the EAS dashboard, republish the last known-good update to the production
   branch, or use the current EAS CLI republish/rollback command shown by
   `eas update --help` for that branch.
3. Monitor update insights for launch failures/crashes and adoption.
4. If the issue needs native code, publish a new binary; an OTA rollback cannot
   change the installed native runtime.

### Bad desktop release

Do not overwrite an immutable release folder.

1. Restore `desktop/latest.json` to the previous known-good `{version, tag}` or
   publish a new patch release.
2. Purge only `desktop/latest.json` from Cloudflare cache if necessary.
3. Confirm the referenced folder and `latest*.yml` are still present before
   announcing rollback completion.

### R2/custom-domain outage

1. Keep the GitHub fallback during the transition period.
2. Check Cloudflare DNS, certificate status, bucket custom-domain status, and R2
   service health.
3. Do not point `cdn.aino.org.in` at `r2.dev`; Cloudflare documents that CNAME
   path as unsupported.
4. If necessary, distribute the signed desktop installer manually while the
   stable R2 endpoint is restored.

## 14. Security and cost notes

- Public read access is intentional: updater artifacts cannot require a secret
  embedded in client applications.
- R2 API credentials are CI-only and bucket-scoped.
- `electron-updater` verifies installer integrity using SHA-512 data in the YAML
  manifest. Keep platform signing/notarization in addition to checksum checks.
- A public APK must be production-signed, but Android signing alone does not make
  self-installation an appropriate Play Store update mechanism.
- Five desktop releases across three platforms can consume several GB. Review
  current Cloudflare R2 pricing and actual object sizes rather than relying on
  historical free-tier figures.
- EAS Update is a separate paid service with plan limits; R2 storage does not
  replace or proxy EAS Update traffic.

## 15. Completion checklist

- [x] Cloudflare is authoritative for `aino.org.in`; the owner confirmed the DNS
      migration preserved the required records.
- [x] `www.aino.org.in` serves the Railway application over Cloudflare.
- [x] R2 bucket exists and `https://cdn.aino.org.in` is connected with valid TLS.
- [x] Cache rules protect stable pointers and cache immutable release assets
      (owner-confirmed; response headers will be checked after first publish).
- [x] Scoped R2 credentials and GitHub variables are configured (owner-confirmed;
      the first `r2-config` job is the CI verification).
- [x] Desktop ships `https://cdn.aino.org.in` as its production update origin.
- [x] Desktop OTA updates from R2 and the public pointer is live at v1.7.63.
- [ ] Desktop updater no longer depends on unauthenticated GitHub APIs before the
      repository becomes private.
- [x] Mobile JS OTA uses EAS Update; native updates use a new store binary.
- [x] Stale mobile self-updater configuration/documentation is removed.
- [ ] Current mobile APK/AAB build and optional R2 mirror complete successfully.
- [ ] Resulting APK passes the physical-device smoke-test matrix and receives a
      compatible production EAS Update.
- [ ] Rollback and recovery procedures have been tested once.

## References

- Cloudflare R2 public buckets and custom domains:
  <https://developers.cloudflare.com/r2/buckets/public-buckets/>
- Expo EAS Update introduction:
  <https://docs.expo.dev/eas-update/introduction/>