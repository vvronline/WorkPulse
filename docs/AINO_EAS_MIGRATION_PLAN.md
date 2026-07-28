# AINO migration: rename → EAS Build → EAS Update (OTA) → Play Store

Status: **Phase A in progress.** Phases B–E require interactive EAS/Google
auth and are run by a human — the exact commands are listed here.

This plan supersedes the "frozen identifiers" table in `REBRAND_AINO.md` §1 for
the **mobile app only**. See §0 for why that freeze no longer applies.

---

## 0. Why the frozen identifiers are being unfrozen

`REBRAND_AINO.md` §1 froze `app.workpulse.mobile`, the `workpulse` slug and the
MMKV store id. Its guiding rule was:

> Rename what users see. Freeze what machines bind to.

That rule is right, but two of its three premises expired:

| Premise in §1 | Status today | Evidence |
|---|---|---|
| "Play Store package names are permanent" | Permanent only **after publishing**. The app has never been published. | `RELEASE.md` + `mobile-release.yml` ship debug-keystore APKs via GitHub Releases / R2 only. |
| "Renaming the slug unlinks the EAS project; OTA channels and build history break" | An EAS project **does** exist (`dcccf532-…`), but renaming a slug does not unlink it — the project id is the binding, not the slug. It is already `@aino/aino` with its history intact. | `eas project:info` → `fullName @aino/aino` |
| "MMKV rename logs every user out / wipes local state" | **Still true in isolation** — but a new package id gets a fresh data directory anyway, so the cost is already being paid. | See §1 risk 1. |

The first `eas submit` (Phase E) is the moment the package name becomes
permanent. **This is the last window to rename.** After Phase E the §1 freeze
becomes real and permanent.

## 1. Risks accepted

1. **Legacy installs are a hard fork.** `app.aino.mobile` is a different app to
   Android: no update path from `app.workpulse.mobile`, no data carryover, users
   must install fresh. This is unavoidable regardless of the rename, because
   Play App Signing uses a different key than the current debug keystore.
   *Mitigation:* ship one final `app.workpulse.mobile` build announcing the
   migration **before** deleting `mobile-release.yml`.
2. **Push is dark until the Railway key is swapped.** See §2.
3. First EAS cloud build may need plugin / `resourceClass` tuning — that is what
   the Phase C.5 preview build is for.

## 2. Firebase: the two halves must match

FCM has a client half and a server half, and both are scoped to one Firebase
project:

| Half | Location | Purpose |
|---|---|---|
| Client | `mobile/google-services.json` | Lets the app receive; yields a device token |
| Server | Railway env `FIREBASE_SERVICE_ACCOUNT_KEY` | Lets the backend send to those tokens |

`server/services/pushNotifications.ts:136-160` parses that env var into
`firebase-admin` and warns at its definition site: a project mismatch means
every send fails with `mismatched-credential` and **no push is delivered**.

- Old project: `workpulse26` (see `server/.env.example:123`)
- New project: `aino-86bb6`, package `app.aino.mobile`

So the Railway variable **must** be regenerated from `aino-86bb6`:
Firebase Console → project `aino-86bb6` → ⚙️ Project settings → Service accounts
→ *Generate new private key* → paste the whole JSON as
`FIREBASE_SERVICE_ACCOUNT_KEY`.

**Status: ✅ swapped on Railway.** The server now sends via `aino-86bb6`, matching
the app. Consequences, both expected:

- Legacy `app.workpulse.mobile` installs no longer receive push. Their stale
  rows self-clean via the `registration-token-not-registered` handling in
  `pushNotifications.ts`.
- Push is testable in the Phase C.5 preview build.

Confirm at deploy time by grepping the Railway logs for the startup line
`Firebase Cloud Messaging initialized` — it logs the resolved `projectId`, which
must read `aino-86bb6`.

No SHA-1 fingerprint is needed: `oauth_client` is empty and the app uses no
Google Sign-In / Phone Auth. Add the EAS keystore SHA-1 later only if that
changes.

---

## Phase A — AINO identity (code; must precede any `eas submit`)

- **A.1** `mobile/app.config.ts`: `slug` → `aino`; `android.package` and
  `ios.bundleIdentifier` → `app.aino.mobile`; `scheme` → `aino`; add
  `owner: "aino"`. Replace the FROZEN comments with a pre-publication note.
- **A.2** Deep-link scheme flip. `REBRAND_AINO.md` §1 called this "hard-coded in
  4 Kotlin files"; in fact the Kotlin reads `intent.getStringExtra(EXTRA_SCHEME)`
  and only *falls back* to a literal, and JS passes the scheme explicitly. Both
  sides change together so there is no split-brain window:
  - `mobile/modules/call-ringer/index.ts` (2 fallbacks)
  - `ActiveCallService.kt`, `CallActionActivity.kt`, `CallRingService.kt`
    (1 fallback each + comments)
  - `ConversationNotificationsModule.kt` — the only genuinely hard-coded
    `workpulse://chat/` pair
  - `mobile/app/call/[conversationId].tsx` (explicit `scheme:`)
  - `nativeCallService.ts` / `notifeeService.ts` use `Linking.createURL()` and
    derive the scheme from app config — **no change needed**.
- **A.3** Write `mobile/google-services.json` for `aino-86bb6`. Gitignored, so it
  reaches EAS via the env var in C.1.
- **A.4** Notification / person ids: `workpulse-user-*`,
  `workpulse-conversation-*`, `workpulse-self`, Tenor `workpulse-chat`.
- **A.5** Storage ids: `workpulse-app` → `aino-app`,
  `workpulse-rq-cache` → `aino-rq-cache`. Safe **only because** A.1 changes the
  package in the same change (fresh data dir). Not safe on its own.
- **A.6** Explicitly NOT touched: `X-Requested-With: "WorkPulse"`
  (`REBRAND_AINO.md` §2 dual-accept — the server must lead), desktop `appId` and
  `workpulse://` protocol, Postgres db/user, and
  `workpulse-prod.up.railway.app` (§4.1 — keep alive permanently).
- **A.7** Update `REBRAND_AINO.md` §1/§5 to record the unfreeze.
- **A.8** `server/.env.example`: L123 comment `workpulse26` → `aino-86bb6`;
  L127 `PUSH_CALL_APNS_TOPIC` → `app.aino.mobile.voip`. Rename the
  `firebase-admin` app-instance label `"workpulse"` → `"aino"`
  (`pushNotifications.ts` + the 3 `pushNotifications.*.test.ts` mocks).

## Phase B — Link the EAS project ✅ DONE

The project id lives in `app.config.ts` as `EAS_PROJECT_ID`
(`dcccf532-ce8b-431c-bb2d-bc99866d14fd`), feeding both `updates.url` and
`extra.eas.projectId`. `eas init` was **not** needed — the project already
existed and is already named `@aino/aino`.

The root `app.json` that previously carried this id was deleted: it was a
stray partial Expo config at the repo root (the app lives in `mobile/`), and
`mobile/app.config.ts` never read it. The id itself was correct and has been
preserved in source.

```sh
cd mobile
eas project:info          # → fullName @aino/aino
```

## Phase C — EAS Build (interactive)

1. ✅ **DONE.** `google-services.json` is gitignored, so EAS will not upload it.
   It is delivered as a secret file env var (read by `app.config.ts` via
   `GOOGLE_SERVICES_JSON`), now present in all three environments:
   ```sh
   eas env:set --scope project --name GOOGLE_SERVICES_JSON --type file \
     --value ./google-services.json --visibility secret \
     --environment development --environment preview --environment production
   ```
   (`eas env:create` still works but prints a deprecation notice.) Re-run this
   whenever the Firebase config changes — EAS holds its own copy.
2. `eas.json`: production → AAB (no `buildType`, Play requires it);
   preview/development → `apk`.

   **Do not set `resourceClass: "large"`.** It is restricted to Production /
   Enterprise / On-Demand plans, and this account is on the free tier — the
   build is rejected before it starts. If the Android build OOMs (the
   `withAndroidGradleMemory` plugin hints it might), tune the Gradle JVM heap
   in that plugin rather than paying for a bigger worker.

3. **`.easignore`.** The upload is a `git clone` of committed state, then
   filtered. `.easignore` **takes priority over `.gitignore`** — where it
   exists, `.gitignore` is not consulted — so it inlines the whole `.gitignore`
   and adds `/android`, `/ios` and build caches. Without the inlined copy,
   `node_modules/` (698 MB) would be uploaded.
4. ⚠️ **Commit before every build.** EAS uploads a
   `git clone --depth 1 file://<repo>` of **committed** state, not the working
   directory. Uncommitted changes are silently absent — a build started before
   the rename commit was already compiling `app.workpulse.mobile` and had to be
   killed. Verify with:
   ```sh
   git status --porcelain     # must be empty
   ```
5. `versionCode` comes from EAS (`appVersionSource: "remote"` + `autoIncrement`)
   and started at 1 automatically for the new package — no `build:version:set`
   was needed.
6. Credentials: the first non-interactive build **auto-generated** a keystore
   (`Build Credentials ti5C-_V8AL`). Inspect with `eas credentials -p android`.
   Back it up before the first Play submission.
7. **Smoke test before spending a production build:**
   ```sh
   eas build -p android --profile preview
   ```
   Verify: FCM push (needs the §2 swap done), incoming calls, PiP, notification
   taps, and the new `aino://` deep links.

### Installing a preview APK on a device

`preview` is `distribution: internal`, so EAS hosts an install page — no Play
Store, no cable, no `adb`.

1. `eas build:list --platform android --limit 1` (or the build URL) → open the
   **install page** on the phone and tap *Install*, or scan the QR code the CLI
   prints when run without `--no-wait`.
2. Android will warn about installing from an unknown source; allow it for the
   browser. This is expected for internal distribution.
3. Alternatively download the `.apk` and `adb install -r <file>.apk`.

`app.aino.mobile` installs **alongside** any existing `app.workpulse.mobile`
build — different package, so they coexist and do not share data.

## Phase D.5 — Building from a GitHub push

Two mechanisms, both requiring **one successful CLI build first**:

| | Expo GitHub App | EAS Workflows |
|---|---|---|
| Setup | Dashboard → project → GitHub → install app, link repo, add a build trigger | commit `.eas/workflows/*.yml` |
| Config | UI | YAML in the repo |
| Best for | "build on push to `master`" | multi-step build → submit → update pipelines |

Requirements for the GitHub App: set `"image": "latest"` on the profiles used,
link the GitHub account under *Account settings → Connections*, and — since the
app lives in `mobile/` — **set the Base directory to `mobile`**, or the trigger
will not find `eas.json`. Triggers support branch/tag wildcards, PR labels, and
an optional *Submit to store after build*.

Because both build committed state, they sidestep the "forgot to commit" trap
entirely — which is a good reason to prefer them once the flow is stable.

## Phase D — EAS Update (OTA)

```sh
npx expo install expo-updates
eas update:configure
```

Set `runtimeVersion: { "policy": "fingerprint" }`. Rationale: `appVersion`
silently breaks if native changes without a version bump, and this app has 9
config plugins, 4 local native modules and `patch-package`. `nativeVersion` is
documented as incompatible with `appVersionSource: "remote"`.

Remove the legacy APK self-updater (replaced by EAS Update):

| File | Action |
|---|---|
| `mobile/src/updater.ts` | delete |
| `mobile/src/components/UpdateChecker.tsx` | delete |
| `mobile/app/_layout.tsx` | drop import + `<UpdateChecker />` |
| `mobile/app/profile.tsx` | "Check for Updates" → `Updates.checkForUpdateAsync()`; version from `expo-constants` |
| `mobile/app.config.ts` | drop `REQUEST_INSTALL_PACKAGES` (Play *Device & Network Abuse* risk) |

No test references either module. Note that `updater` in `app/admin/agile.tsx`
and `useMobileCallControls.ts` are unrelated setState updaters — do not touch.

Publish (`--environment` is required on SDK 55+):

```sh
eas update --channel production --message "..." --environment production
```

Then retire `.github/workflows/mobile-release.yml` and rewrite `RELEASE.md`.
The R2 `mobile/latest.json` path and `EXPO_PUBLIC_OTA_BASE_URL` / `R2_*` secrets
become dead. **Desktop's `desktop/latest.json` is separate — leave it alone.**

## Phase E — Google Play (interactive; freezes the package name)

1. Play Console → create app under `app.aino.mobile`; complete listing, content
   rating, Data safety (camera/mic/location/media), privacy policy.
2. Play Console → Setup → API access → create a Google Service Account key, then
   `eas credentials -p android` → *Google Service Account → Upload*. Preferred
   over `serviceAccountKeyPath` so the JSON never enters the repo.
3. `eas build -p android --profile production`
4. `eas submit -p android --profile production` → internal track, draft.
5. Promote internal → closed → open → production.
6. Steady state: `eas build -p android --profile production --auto-submit`.

## Phase F — CI (optional)

`.eas/workflows/submit-android.yml` with a `build` job and a `submit` job wired
via `needs.build_android.outputs.build_id`, triggered on `mobile-v*` tags to
preserve the existing release ritual. Requires an `EXPO_TOKEN` repo secret.
