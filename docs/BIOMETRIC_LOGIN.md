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
| **Desktop** (Electron) | *(Phase 4 — planned)* Windows Hello / Touch ID gates a secret in `safeStorage` | Encrypted secret | `device_credentials` row |
| **Web** | *(Phase 3 — planned)* WebAuthn / passkeys | Private key in platform authenticator | `webauthn_credentials` table |

Mobile/desktop use a **biometric-unlocked refresh-secret** model that reuses
the normal JWT login. Web will use **WebAuthn/passkeys** (the web-native
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

Tests: `server/__tests__/biometric.routes.test.ts` (12 cases, all passing).

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

## Remaining phases

### Phase 3 — Web (WebAuthn / passkeys) — planned
- Add `webauthn_credentials` table + a Redis-backed challenge store.
- Server: `@simplewebauthn/server` endpoints
  (`/auth/webauthn/register/options|verify`, `/auth/webauthn/login/options|verify`).
- Client: `@simplewebauthn/browser` wrapper + "Sign in with a passkey" on
  `client/src/pages/Login.tsx`, manage in profile settings.
- On verify, call the existing `saveAuth(user)` (cookie set server-side by
  `finishLogin`).

### Phase 4 — Desktop (Electron) — planned
- Main process: store the device secret in Electron `safeStorage`, gate reads
  behind Windows Hello (native module) / Touch ID (`systemPreferences`).
- Expose `biometric:*` IPC via `contextBridge` in `desktop/preload.ts`.
- Renderer reuses the web `AuthContext`, calling `window.electron.biometric.*`
  when running under Electron, else falling back to WebAuthn.

### Phase 5 — Polish — partially done
- [x] Public-login rate limiter.
- [x] Audit logging.
- [x] This document.
- [ ] Tenant feature flag (`biometric_login_enabled`) + admin toggle.
- [ ] "Manage devices" UI listing `device_credentials` / `webauthn_credentials`.