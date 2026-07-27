/**
 * App identity + userData migration. MUST be the FIRST local import in main.ts.
 *
 * Why this module exists
 * ─────────────────────────────────────────────────────────────────────────
 * Electron derives `app.getPath("userData")` from `app.name`. The WorkPulse ->
 * AINO rebrand changes `app.name` (and electron-builder's `productName`), which
 * silently MOVES that directory:
 *
 *     %APPDATA%\WorkPulse   ->   %APPDATA%\AINO
 *
 * Everything the desktop app persists lives there:
 *   • biometric-credential.json     (Windows Hello / Touch ID enrolment)
 *   • window-state.json             (window size/position)
 *   • call-pip-window-state.json    (PiP window position)
 *   • last-version.txt              (cache-invalidation marker)
 *   • Network/Cookies               (the auth session cookie)
 *
 * Without a migration, the first AINO build starts against an EMPTY profile:
 * every user is logged out, biometric sign-in is un-enrolled, and window layout
 * is lost. That is a silent, irreversible-feeling regression, so we copy the
 * legacy profile forward exactly once.
 *
 * Ordering is load-bearing: `biometric.ts` and `callPipWindow.ts` compute their
 * file paths from `app.getPath("userData")` at MODULE scope. ES imports are
 * hoisted, so if this ran inline in main.ts's body it would execute AFTER those
 * modules had already resolved the new (empty) directory. Keeping it in its own
 * module, imported first, guarantees the copy happens before any reader.
 */
import { app } from "electron";
import path from "path";
import fs from "fs";

// Windows notification/taskbar identity. NOTE: this is the NSIS `appId` and is
// deliberately NOT rebranded — changing it makes Windows treat the app as a
// different product (side-by-side install, broken auto-update chain, orphaned
// notification history). The user-visible name is `app.name` below.
app.setAppUserModelId("com.workpulse.desktop");
app.name = "AINO";

/** Legacy `app.name` values whose userData directory we may need to adopt. */
const LEGACY_APP_DIR_NAMES = ["WorkPulse", "workpulse-desktop"];

/** Marker written into the new profile so the copy only ever runs once. */
const MIGRATION_MARKER = ".migrated-from-workpulse";

/**
 * Copy the most recently used legacy profile into the AINO profile, once.
 *
 * Fails soft on every error: a broken migration must never prevent the app from
 * launching. Worst case the user re-authenticates, which is the same outcome as
 * having no migration at all.
 */
function migrateLegacyUserData(): void {
  let newDir: string;
  try {
    newDir = app.getPath("userData");
  } catch {
    return;
  }

  // Already migrated, or this is a genuinely fresh install that has since been
  // used — either way, never overwrite a populated AINO profile.
  const marker = path.join(newDir, MIGRATION_MARKER);
  if (fs.existsSync(marker)) return;
  if (fs.existsSync(path.join(newDir, "Network"))) return;

  const parent = path.dirname(newDir);

  // Pick the newest legacy profile in case both names exist (a machine that ran
  // both a dev build and a packaged build).
  let source: string | null = null;
  let newestMtime = -1;
  for (const name of LEGACY_APP_DIR_NAMES) {
    const candidate = path.join(parent, name);
    if (candidate === newDir) continue;
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory() && stat.mtimeMs > newestMtime) {
        newestMtime = stat.mtimeMs;
        source = candidate;
      }
    } catch {
      /* candidate absent — expected on clean installs */
    }
  }

  if (!source) return;

  try {
    fs.mkdirSync(newDir, { recursive: true });
    // `Singleton*` are lock files/sockets belonging to the legacy process; on
    // Windows they are unreadable junctions that make a naive copy throw, and
    // copying them would confuse Chromium's single-instance detection.
    fs.cpSync(source, newDir, {
      recursive: true,
      force: false,
      errorOnExist: false,
      filter: (src) => !path.basename(src).startsWith("Singleton"),
    });
    fs.writeFileSync(marker, `migrated from ${source} at ${new Date().toISOString()}\n`);
    console.log(`[AINO] Migrated desktop profile: ${source} -> ${newDir}`);
  } catch (err) {
    // Leave no half-written marker: without it we retry on the next launch.
    console.warn("[AINO] userData migration failed:", (err as Error)?.message);
  }
}

migrateLegacyUserData();

export {};
