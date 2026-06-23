# Biometric Login ("Log in with your face") — Option B

This document describes the **device-biometric login** feature: the
industry-standard "log in with your face / fingerprint" pattern where the
**operating system** performs the biometric match locally and unlocks a
stored credential that the existing JWT/session machinery understands.

> **No face / biometric data ever reaches the server.** Apple/Google/Microsoft
> (Face ID / Touch ID / Windows Hello / Android BiometricPrompt) handle the
> match and liveness. The server only stores a one-way **bcrypt hash** of a
> random device secret — exactly like a password.

This is distinct from the existing **face-recognition attendance** feature
(`server/utils/face.ts`, `face-api.js`), which is a *post-auth* identity check
for clock-in and is unrelated to login.

---

## Architecture

| Platform | Mechanism | On-device store | Server credential |
|---|---|---|---|
| **Mobile** (Expo) | `expo-local-authentication` gates a long-lived device secret in `expo-secure-store` | Secret behind OS biometric | `device_credentials` row |
| **Desktop** (Electron) | Windows Hello / Touch ID gates a secret in `safeStorage` | Encrypted secret | `device_credentials` row |
| **Web** | WebAuthn / passkeys | Private key in platform authenticator | `webauthn_credentials` table |

Mobile/desktop use a **biometric-unlocked refresh-secret** model that reuses
the normal JWT login. Web uses **WebAuthn/passkeys** (the web-native
passwordless standard).

---

## Server (implemented — Phase 1)

### Schema

Migration `2026_06_v14_biometric_device_credentials`
(`server/utils/migrationRunner.ts`) creates the per-tenant table:

```sql
CREATE TABLE device_credentials (
    id            TEXT PRIMARY KEY,            -- "<tenantId>.<uuid>"
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    secret_hash   TEXT NOT NULL,               -- bcrypt(deviceSecret)
    device_label  TEXT,
    platform      TEXT NOT NULL CHECK(platform IN ('ios','android','desktop','web')),
    last_used_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at    TIMESTAMPTZ
);
```

The `id` embeds the tenant id (`<tenantId>.<uuid>`, `0` = platform/master) so
the **public** login endpoint can resolve the right tenant DB without the
client sending a username first.

Fresh tenants pick the table up via `getTenantPool` → `runTenantMigrations`
(called in `createTenant`); existing tenants get it on the startup
`sweepAllTenants()`.

### Endpoints (`server/routes/auth.ts`, mounted at `/api/auth`)

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /auth/biometric/enroll` | required | Mint a random 256-bit device secret, store its bcrypt hash, return the **raw secret once**. Body: `{ platform, deviceLabel? }` → `{ credentialId, deviceSecret }`. |
| `POST /auth/biometric/login` | public | Exchange `{ credentialId, deviceSecret }` for a session. Verifies the hash and calls the shared `finishLogin()`. |
| `GET /auth/biometric` | required | List the caller's enrolled devices. |
| `DELETE /auth/biometric/:id` | required | Revoke one of the caller's device credentials. |

### Security

- **Hashing**: `secret_hash` is bcrypt — never reversible. The raw secret is
  shown to the client exactly once at enrollment.
- **Constant-time-ish**: `/biometric/login` always runs a bcrypt compare (even
  for a missing credential) to avoid a timing oracle, and returns a generic
  `"Invalid biometric credential"` for every failure mode.
- **Revocation**: a **password reset** (`/auth/reset-password`) sets
  `revoked_at` on all of the user's device credentials and bumps
  `token_version` — so "I reset my password" kills biometric login on every
  old device too.
- **Rate limiting**: the public `/auth/biometric/login` route has its own
  limiter bucket in `server/index.ts` (`authLimiter`, 15 / 15 min) so a stolen
  `credentialId` can't be brute-forced.
- **Tenant scoping**: the tenant id is embedded in `credentialId` and the
  revoke query is scoped to `user_id`, so one user can't revoke another's
  device.
- **Audit**: `biometric_enroll`, `biometric_login`, `biometric_revoke` are
  written via `logAction`.

Tests: `server/__tests__/biometric.routes.test.ts` (13 cases, all passing —
includes the Phase 5 feature-flag 403 case). The suite mocks `express-rate-limit`
with a pass-through so the shared process-wide `authLimiter` bucket can't leak
429s into a combined test run (`webauthn.routes` + `biometric.routes` +
`auth.routes` → 46/46 deterministic).

---

## Mobile (implemented — Phase 2)

- **Dependency**: `expo-local-authentication` (+ Face ID usage string in
  `app.config.ts`).
- **`mobile/src/auth/biometricStore.ts`**: wraps `expo-secure-store`. The
  device secret is stored with `requireAuthentication: true` so the OS
  biometric prompt fires on every read; the `credentialId` is stored normally.
  Exposes `isBiometricAvailable`, `hasBiometricCredential`,
  `saveBiometricCredential`, `getBiometricCredentialId`,
  `unlockBiometricCredential`, `clearBiometricCredential`, `biometricPlatform`.
- **`mobile/src/auth/AuthContext.tsx`**: adds
  `biometricAvailable`, `biometricEnrolled`, `enableBiometric()`,
  `disableBiometric()`, `biometricLogin()`. Password and biometric login share
  a `completeSession()` helper so both hydrate the profile identically. A `401`
  from biometric login (revoked credential) auto-clears the local secret.
- **`mobile/app/login.tsx`**: shows a **"Sign in with Face ID"** button when
  hardware is present and a credential is enrolled.
- **`mobile/app/profile.tsx`**: a **"Sign in with Face ID"** toggle to
  enroll / disable on the current device.

### User flow

1. User logs in with username + password as usual.
2. Profile → toggle **Sign in with Face ID** → app calls
   `/auth/biometric/enroll`, OS prompts to confirm, secret is stored behind
   the biometric.
3. Next launch → **Sign in with Face ID** on the login screen → OS biometric
   prompt → app reads the secret → `/auth/biometric/login` → session.

---

## Web (implemented — Phase 3)

Web uses **WebAuthn / passkeys** — the browser-native passwordless standard.
The platform authenticator (Touch ID / Windows Hello / Face ID / a security
key) holds the **private key**; the server stores only the **public key** and
a signature counter. No shared secret, no biometric data ever leaves the
device.

### Schema

Migration `2026_06_v15_webauthn_credentials`
(`server/utils/migrationRunner.ts`) creates the per-tenant table:

```sql
CREATE TABLE webauthn_credentials (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id TEXT NOT NULL UNIQUE,       -- base64url credential id
    public_key    TEXT NOT NULL,              -- base64 COSE public key
    counter       BIGINT NOT NULL DEFAULT 0,  -- clone-detection signature counter
    transports    TEXT,                       -- comma-joined transports hint
    device_label  TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at  TIMESTAMPTZ,
    revoked_at    TIMESTAMPTZ
);
```

**Multi-tenant trick**: at registration the WebAuthn `userHandle` is set to
`"<tenantId>.<userId>"`. A usernameless (discoverable) login returns that
handle in the assertion, so the **public** verify endpoint resolves the right
tenant DB + user directly — no username needed up front.

### Endpoints (`server/routes/auth.ts`, mounted at `/api/auth`)

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /auth/webauthn/register/options` | required | Return a registration challenge (excludes already-registered passkeys). Challenge is stashed server-side keyed by the user. |
| `POST /auth/webauthn/register/verify` | required | Verify the attestation and store the public key. Body: `{ response, deviceLabel? }`. |
| `POST /auth/webauthn/login/options` | public | Return an auth challenge + a random `flowId` the client must echo on verify. |
| `POST /auth/webauthn/login/verify` | public | Verify the assertion, bump the counter, resolve the user from the `userHandle`, and call the shared `finishLogin()`. |
| `GET /auth/webauthn` | required | List the caller's registered passkeys. |
| `DELETE /auth/webauthn/:id` | required | Revoke one of the caller's passkeys. |

### Client

- **Dependency**: `@simplewebauthn/browser`.
- **`client/src/auth/webauthn.ts`**: wraps the endpoints — `registerPasskey`,
  `loginWithPasskey`, `listPasskeys`, `removePasskey`, `isPasskeySupported`,
  and `isConditionalMediationAvailable`.
- **`client/src/pages/Login.tsx`**: a **"Sign in with a passkey"** button plus
  **conditional mediation** (passkey autofill) — when the browser supports it,
  saved passkeys surface inline in the username field and a successful pick
  signs the user in with no button click. On verify, the existing
  `saveAuth(user)` runs (cookie set server-side by `finishLogin`).
- **`client/src/components/profile/EditProfileModal.tsx`**: register a passkey
  and manage / revoke existing ones.

### Security

- **Challenge store**: short-lived (5 min) challenges in Redis (multi-instance
  safe) with an in-memory fallback for single-instance / no-Redis dev.
  Registration challenges are keyed per user; login challenges per random
  `flowId` and are single-use.
- **Counter**: the signature counter is verified and bumped on every login to
  detect cloned authenticators.
- **rpID / origin pinning**: `webauthnConfig()` pins the relying-party id and
  origin; both are overridable via `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN`
  (falls back to `CORS_ORIGIN`) for multi-domain / custom-domain deployments.
- **Revocation**: a **password reset** sets `revoked_at` on all of the user's
  passkeys (alongside `device_credentials` + `token_version` bump).
- **Rate limiting**: the public `/auth/webauthn/login/*` routes ride the
  `authLimiter` bucket (15 / 15 min).
- **Audit**: `webauthn_register`, `webauthn_login`, `webauthn_revoke` via
  `logAction`.

Tests: `server/__tests__/webauthn.routes.test.ts` (18 cases, all passing).

---

## Desktop (implemented — Phase 4)

The desktop app reuses the **device-secret model** (same `device_credentials`
table and `/auth/biometric/*` endpoints as mobile), gated by **Windows Hello**
or **Touch ID** instead of a mobile biometric.

### Main process (`desktop/biometric.ts`)
- Stores the server-issued device secret encrypted at rest with Electron's
  `safeStorage` (DPAPI on Windows / Keychain on macOS) in
  `biometric-credential.json` under the app's `userData` dir.
- Gates every read behind the OS biometric:
  - **macOS**: `systemPreferences.canPromptTouchID()` / `promptTouchID()`.
  - **Windows**: the WinRT `UserConsentVerifier` API
    (`CheckAvailabilityAsync` / `RequestVerificationAsync`) driven via a
    PowerShell shim — Windows Hello shows its native dialog.
  - **Linux**: unsupported (falls back to password).
- Registers four `ipcMain.handle` channels: `biometric:available`,
  `biometric:enroll`, `biometric:login`, `biometric:disable`.
- Wired up once from `desktop/main.ts` via `setupBiometric(() => mainWindow)`.

### Preload bridge (`desktop/preload.ts`)
- Exposes `window.electronAPI.biometric.{available,enroll,login,disable}` to the
  renderer via `contextBridge`.

### Renderer (`client/src/auth/desktopBiometric.ts`)
- Bridges the IPC to the server endpoints:
  - `enableDesktopBiometric()` → `/auth/biometric/enroll` then stores the secret
    behind the OS biometric.
  - `desktopBiometricLogin()` → unlocks the secret via the OS biometric then
    calls `/auth/biometric/login`, returning the user for `saveAuth(user)`.
  - `desktopBiometricStatus()` / `disableDesktopBiometric()` for the settings UI.
- `client/src/pages/Login.tsx` shows **"Sign in with biometrics"** when running
  under Electron with a credential enrolled (the WebAuthn passkey button is
  hidden in the desktop app — Electron uses Hello/Touch ID instead).
- `client/src/components/profile/EditProfileModal.tsx` shows a
  **"Biometric Login (this device)"** enable/disable section in the desktop app.

### User flow
1. Sign in with username + password in the desktop app.
2. Profile → **Enable biometric sign-in** → Windows Hello / Touch ID confirms →
   the device secret is stored encrypted on this device.
3. Next launch → **Sign in with biometrics** on the login screen → OS biometric
   prompt → session.

---

## Tenant feature flag (Phase 5)

Biometric / passkey login can be switched off per-tenant by an admin.

- **Schema**: migration `2026_06_v16_biometric_login_enabled_flag` adds
  `organizations.biometric_login_enabled BOOLEAN NOT NULL DEFAULT TRUE` — so the
  feature stays on for every existing tenant through the deploy.
- **Server gate** (`isBiometricLoginEnabled()` in `routes/auth.ts`): when the
  flag is off, the server returns **403** for `POST /auth/biometric/enroll`,
  `POST /auth/biometric/login`, `POST /auth/webauthn/register/options`, and
  `POST /auth/webauthn/login/verify`. Password login is unaffected. The gate
  fails **open** (treats the feature as enabled) if the column/row is missing,
  e.g. a tenant DB that hasn't picked up the migration yet. Platform users are
  never gated.
- **Admin toggle**: `PUT /api/org/settings` accepts `biometric_login_enabled`
  (any `hr_admin+`). The UI lives in `OrgSettings.tsx` as an "Allow biometric &
  passkey sign-in" checkbox.
- Tests: `biometric.routes.test.ts` includes a "returns 403 when biometric
  login is disabled for the org" case (combined suite → 46/46 deterministic).

## Manage devices (Phase 5)

`EditProfileModal.tsx` shows a **"Devices with biometric sign-in"** section that
lists every `device_credentials` row for the user (mobile Face ID, desktop
Windows Hello / Touch ID — each tagged by platform + last-used date) with a
per-device **Remove** button (`DELETE /auth/biometric/:id`). WebAuthn passkeys
keep their own list/add/revoke section above it, so between the two the user has
a single screen to see and revoke every credential that can biometric-login to
their account.

## Remaining phases

### Phase 5 — Polish
- [x] Public-login rate limiter.
- [x] Audit logging.
- [x] This document.
- [x] Tenant feature flag (`biometric_login_enabled`) + admin toggle.
- [x] "Manage devices" UI listing `device_credentials` / `webauthn_credentials`.
- [ ] Cross-browser / real-device QA sign-off (manual).
