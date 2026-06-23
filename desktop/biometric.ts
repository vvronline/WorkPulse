import {
    ipcMain,
    safeStorage,
    systemPreferences,
    app,
    type BrowserWindow,
} from "electron";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import util from "util";

const execFileP = util.promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────
// Desktop biometric login (Phase 4 — Electron Windows Hello / Touch ID).
//
// Mirrors the mobile model: the OS biometric (Windows Hello / Touch ID) gates
// access to a high-entropy device secret that the SERVER issued via
// POST /auth/biometric/enroll. We persist that secret encrypted at rest with
// Electron's `safeStorage` (OS keychain / DPAPI), and only hand it back to the
// renderer after a successful OS biometric verification. The renderer then
// exchanges it at POST /auth/biometric/login — exactly like the mobile flow.
//
// No biometric data is ever read by us: Windows Hello / Touch ID perform the
// match locally and return only a yes/no.
//
// IPC channels (invoke/handle):
//   biometric:available  → { available, enrolled, platform }
//   biometric:enroll     ({ credentialId, deviceSecret }) → { ok }
//   biometric:login      → { ok, credentialId?, deviceSecret?, error? }
//   biometric:disable    → { ok }
// ─────────────────────────────────────────────────────────────────────────

interface StoredCredential {
    credentialId: string;
    // base64 of safeStorage-encrypted deviceSecret
    encryptedSecret: string;
}

const STORE_FILE = path.join(app.getPath("userData"), "biometric-credential.json");

function readStore(): StoredCredential | null {
    try {
        if (!fs.existsSync(STORE_FILE)) return null;
        const raw = fs.readFileSync(STORE_FILE, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.credentialId === "string" && typeof parsed.encryptedSecret === "string") {
            return parsed as StoredCredential;
        }
        return null;
    } catch (err) {
        console.warn("[WorkPulse] biometric: readStore failed:", (err as Error)?.message);
        return null;
    }
}

function writeStore(cred: StoredCredential): boolean {
    try {
        fs.writeFileSync(STORE_FILE, JSON.stringify(cred), { mode: 0o600 });
        return true;
    } catch (err) {
        console.warn("[WorkPulse] biometric: writeStore failed:", (err as Error)?.message);
        return false;
    }
}

function clearStore(): void {
    try {
        if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
    } catch (err) {
        console.warn("[WorkPulse] biometric: clearStore failed:", (err as Error)?.message);
    }
}

/**
 * Check whether the OS biometric authenticator is available.
 *  - macOS: Touch ID via `systemPreferences.canPromptTouchID()`.
 *  - Windows: Windows Hello via the WinRT UserConsentVerifier availability API.
 *  - Linux: unsupported.
 */
async function isHardwareAvailable(): Promise<boolean> {
    if (process.platform === "darwin") {
        try {
            return systemPreferences.canPromptTouchID();
        } catch {
            return false;
        }
    }
    if (process.platform === "win32") {
        return windowsHelloAvailable();
    }
    return false;
}

// PowerShell helper that awaits a WinRT IAsyncOperation and returns its result
// as a single token on stdout. The `Await` function is the well-known reflection
// shim required to consume WinRT async APIs from Windows PowerShell.
const WINRT_AWAIT_PREAMBLE = `
Function Await($WinRtTask, $ResultType) {
    $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
    $asTaskGeneric = $asTask.MakeGenericMethod($ResultType)
    $netTask = $asTaskGeneric.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}
`.trim();

async function windowsHelloAvailable(): Promise<boolean> {
    try {
        const script = `
${WINRT_AWAIT_PREAMBLE}
[Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime] | Out-Null
$availability = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])
Write-Output $availability
`.trim();
        const { stdout } = await execFileP(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", script],
            { timeout: 15000 },
        );
        const result = stdout.trim();
        // "Available" (enum value 0) means a Hello credential is enrolled.
        return /^Available$/i.test(result) || result === "0";
    } catch (err) {
        console.warn("[WorkPulse] biometric: windowsHelloAvailable failed:", (err as Error)?.message);
        return false;
    }
}

/**
 * Prompt the OS biometric and resolve true only on a verified match.
 */
async function promptBiometric(reason: string): Promise<boolean> {
    if (process.platform === "darwin") {
        try {
            await systemPreferences.promptTouchID(reason);
            return true;
        } catch {
            return false;
        }
    }
    if (process.platform === "win32") {
        return windowsHelloVerify(reason);
    }
    return false;
}

async function windowsHelloVerify(reason: string): Promise<boolean> {
    try {
        // Escape any double quotes in the message so it can't break the script.
        const safeReason = reason.replace(/"/g, "'");
        const script = `
${WINRT_AWAIT_PREAMBLE}
[Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime] | Out-Null
$result = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync("${safeReason}")) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])
Write-Output $result
`.trim();
        const { stdout } = await execFileP(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", script],
            { timeout: 60000 },
        );
        const result = stdout.trim();
        // "Verified" (enum value 0) means the user passed Windows Hello.
        return /^Verified$/i.test(result) || result === "0";
    } catch (err) {
        console.warn("[WorkPulse] biometric: windowsHelloVerify failed:", (err as Error)?.message);
        return false;
    }
}

/**
 * Register the biometric IPC handlers. Call once from the main process after
 * the app is ready. `getWindow` is unused today but kept for parity with other
 * setup helpers that may need to attach the Hello dialog to a parent window.
 */
export function setupBiometric(_getWindow?: () => BrowserWindow | null): void {
    // Report availability + whether a credential is already enrolled.
    ipcMain.handle("biometric:available", async () => {
        const available = await isHardwareAvailable();
        const enrolled = readStore() !== null;
        return { available, enrolled, platform: process.platform };
    });

    // Persist a server-issued device credential behind safeStorage. The
    // renderer calls this right after a successful POST /auth/biometric/enroll.
    ipcMain.handle("biometric:enroll", async (_e, payload: { credentialId?: string; deviceSecret?: string }) => {
        try {
            const credentialId = payload?.credentialId;
            const deviceSecret = payload?.deviceSecret;
            if (!credentialId || !deviceSecret) {
                return { ok: false, error: "missing_fields" };
            }
            if (!safeStorage.isEncryptionAvailable()) {
                return { ok: false, error: "encryption_unavailable" };
            }
            // Require a fresh biometric confirmation at enrollment time so the
            // secret can only be stored by the person physically present.
            const verified = await promptBiometric("Confirm your identity to enable biometric sign-in for WorkPulse");
            if (!verified) return { ok: false, error: "verification_failed" };

            const encryptedSecret = safeStorage.encryptString(deviceSecret).toString("base64");
            const ok = writeStore({ credentialId, encryptedSecret });
            return ok ? { ok: true } : { ok: false, error: "persist_failed" };
        } catch (err) {
            console.warn("[WorkPulse] biometric:enroll failed:", (err as Error)?.message);
            return { ok: false, error: (err as Error)?.message || "enroll_failed" };
        }
    });

    // Gate the stored secret behind the OS biometric and return it so the
    // renderer can exchange it at POST /auth/biometric/login.
    ipcMain.handle("biometric:login", async () => {
        try {
            const stored = readStore();
            if (!stored) return { ok: false, error: "not_enrolled" };
            if (!safeStorage.isEncryptionAvailable()) {
                return { ok: false, error: "encryption_unavailable" };
            }
            const verified = await promptBiometric("Sign in to WorkPulse");
            if (!verified) return { ok: false, error: "verification_failed" };

            let deviceSecret: string;
            try {
                deviceSecret = safeStorage.decryptString(Buffer.from(stored.encryptedSecret, "base64"));
            } catch {
                // Corrupt / undecryptable (e.g. OS keychain reset) — wipe it so
                // the user re-enrolls cleanly.
                clearStore();
                return { ok: false, error: "decrypt_failed" };
            }
            return { ok: true, credentialId: stored.credentialId, deviceSecret };
        } catch (err) {
            console.warn("[WorkPulse] biometric:login failed:", (err as Error)?.message);
            return { ok: false, error: (err as Error)?.message || "login_failed" };
        }
    });

    // Forget the stored credential on this device.
    ipcMain.handle("biometric:disable", async () => {
        clearStore();
        return { ok: true };
    });
}