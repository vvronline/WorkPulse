# Rebrand: WorkPulse / Loops → AINO

Status: **code changes complete; client backend targets switched to
`https://www.aino.org.in`; remaining infrastructure steps in §4.**

The project shipped under two legacy names — `WorkPulse` (technical identifiers)
and `Loops` (user-facing copy). Both are being replaced by **AINO**, on the new
domain `aino.org.in`.

The guiding rule for this migration:

> **Rename what users see. Freeze what machines bind to.**

A name that appears in a UI string is free to change. A name that some *other*
system has already recorded — a store listing, an installed app's data
directory, a browser's localStorage, a passkey's relying-party ID — is an
address, not a label. Renaming it doesn't move the data; it points at nothing.

---

## 1. Frozen identifiers — do NOT rename

Each of these is load-bearing. The "what breaks" column is the actual observed
failure, not a theoretical one.

| Identifier | Value | What breaks if renamed |
|---|---|---|
| Android `package` | `app.workpulse.mobile` | Publishes a **new app**. Existing installs never update. Play Store package names are permanent. |
| iOS `bundleIdentifier` | `app.workpulse.mobile` | Same — a new App Store listing. |
| EAS `slug` | `workpulse` | Unlinks the EAS project; OTA channels and build history break. |
| Electron `appId` | `com.workpulse.desktop` | NSIS treats AINO as a different product → installs **side-by-side**, old version stranded, auto-update chain broken. |
| MMKV store id | `workpulse-app` | Opens a new empty store → every mobile user logged out, local state wiped. |
| localStorage keys | `workpulse_agile_config_v1`, `workpulse.notificationPrefs`, `workpulse-notes-<uid>` | `workpulse-notes-` holds the **private notebook** — silent data loss. Also breaks `clearTenantScopedCaches()`, leaking tenant data across account switches. |
| React Query cache key | `workpulse-rq-cache` | Cold cache for all users (cosmetic, but pointless churn). |
| Desktop protocol | `workpulse://` | Invalidates the Chromium cookie partition → all desktop users logged out. Invisible to users, so there is no upside. |
| Mobile deep-link scheme | `workpulse` | Hard-coded in 4 Kotlin files; call answer/decline and notification taps become dead links. |
| GitHub repo | `vvronline/WorkPulse` | Both updaters (`desktop/updater.ts`, `mobile/src/updater.ts`) 404. |
| Postgres DB / user | `workpulse` | Requires a dump/restore. |

Every one of these has an explanatory comment at its definition site so the
reasoning survives without this document.

## 2. The dual-accept contracts

Three values are shared between the server and *independently released*
clients. The server was widened to accept **both** brands so clients can migrate
on their own schedule instead of requiring a flag day.

| Contract | Location | Accepts |
|---|---|---|
| CSRF header | `server/index.ts` | `WorkPulse` **and** `AINO` |
| Desktop CORS origin | `server/index.ts`, `server/utils/ws.ts` | `workpulse://` **and** `aino://` |
| Desktop cookie origin | `server/utils/cookie.ts` | `workpulse://` **and** `aino://` |

**Ordering matters.** The dual-accept server must be deployed *before* any
client starts sending the new value. Clients therefore still send
`X-Requested-With: WorkPulse` — a client sending `AINO` to an older or
rolled-back server gets a `403` on **every mutating request**.

Regression tests pin this behaviour:
- `server/__tests__/api.test.ts` — both header values accepted, unrelated values still rejected.
- `server/__tests__/cookie.rebrand.test.ts` — both desktop schemes get `SameSite=None`, web origins stay `strict`.

The cookie case is the subtlest failure in the whole rename: if a desktop origin
falls off the allowlist, the cookie silently downgrades to `SameSite=Strict`,
which a custom-protocol origin cannot send back. Login *appears* to succeed and
the next request is unauthenticated — an infinite login loop with nothing in the
logs.

## 3. Desktop userData migration

`productName` changed to `AINO`, which moves Electron's data directory:

```
%APPDATA%\WorkPulse   →   %APPDATA%\AINO
```

That directory holds the biometric enrolment, window state, and **the auth
session cookie**. Without intervention the first AINO build starts on an empty
profile: everyone logged out, Windows Hello / Touch ID un-enrolled.

`desktop/appIdentity.ts` copies the legacy profile forward exactly once, guarded
by a marker file, and fails soft on any error.

**This module must remain the first local import in `main.ts`.** ES imports are
hoisted, and `biometric.ts` / `callPipWindow.ts` resolve their paths from
`app.getPath("userData")` at *module scope* — if the migration ran later, those
modules would already have bound to the new, empty directory.

## 4. Remaining manual steps (infrastructure)

These are not code and must be done in the respective dashboards.

### 4.1 Railway — custom domain
1. App service → **Settings → Networking → Custom Domain** → add `aino.org.in` (and `www.aino.org.in`).
2. Add the `CNAME` record Railway shows at your DNS provider.
3. Wait for certificate issuance.
4. **Keep `workpulse-prod.up.railway.app` active — permanently.** New builds now
   target `https://www.aino.org.in`, but every *already-installed* desktop and
   mobile build baked the Railway host into its JS bundle. Removing that domain
   bricks them; there is no way to migrate a client that can no longer reach the
   server to tell it about a new address.
5. **Always use the `www.` host.** The apex `aino.org.in` resolves to a registrar
   redirect (`15.197.225.128` / `3.33.251.168`), **not** Railway, and returns
   `404` on `/api/health`. Only `www.aino.org.in` is CNAME'd to the app service.
   Point the apex at Railway too, or leave clients on `www.` as they are now.

### 4.2 Railway — environment variables

| Variable | Value | Note |
|---|---|---|
| `CORS_ORIGIN` | `https://aino.org.in,https://www.aino.org.in` | Comma-separated; parsed in `server/index.ts`. |
| `SMTP_FROM` | `"AINO" <noreply@aino.org.in>` | Overrides the code default; set this or outbound mail keeps the old brand. |
| `WEBAUTHN_RP_ID` | **leave unset** | ⚠️ See below. |
| `DESKTOP_COOKIE_ORIGINS` | leave unset | Default already covers both schemes. |

> ⚠️ **Do not set `WEBAUTHN_RP_ID`.** A passkey is cryptographically bound to
> the rpID it was created under, and that binding cannot be migrated. Setting it
> invalidates **every existing passkey**. Left unset, `server/routes/auth.ts`
> derives the rpID from the request hostname — passkeys on the Railway domain
> keep working there, new ones bind to `aino.org.in`. Both stay valid.

### 4.3 Email / DNS
Add SPF/DKIM records for `aino.org.in` before switching `SMTP_FROM`, otherwise
mail from the new domain will land in spam.

## 5. Deferred (optional, needs migrations)

Only worth doing with an explicit read-old/write-new shim — or never:

- localStorage / MMKV key renames.
- Desktop `workpulse://` → `aino://` (server already accepts it; flip as one isolated change).
- Mobile deep-link scheme + the 4 Kotlin files.
- Dropping `WorkPulse` from the server's dual-accept lists — **only** once client
  adoption is effectively complete.
- Retiring `workpulse-prod.up.railway.app` — see §4.1, this is effectively
  "never" while any old install survives.

Mobile/desktop app *identity* (package, bundle ID, appId) should stay frozen
permanently. Store **listing** names are independent of package IDs, so the
public-facing rebrand is achievable without touching them.

## 6. Rollout order

1. **Deploy the server first** (dual-accept). Backward compatible — old clients unaffected.
2. Point `aino.org.in` at Railway; set env vars.
3. Ship web client (branding only).
4. Ship desktop — first launch migrates the userData profile.
5. Ship mobile — display name + permission strings only.
6. *Much later*, once adoption is high: flip client CSRF values to `AINO`, then
   remove the legacy entries server-side.
