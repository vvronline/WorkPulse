import {
    biometricEnroll,
    biometricLogin as biometricLoginApi,
} from "../api";

/**
 * Desktop (Electron) biometric login wrapper (Phase 4 — Windows Hello / Touch ID).
 *
 * Bridges the renderer to the main-process `window.electronAPI.biometric.*`
 * IPC (see desktop/biometric.ts) and the server's /auth/biometric endpoints.
 *
 * Model (mirrors mobile):
 *   - Enroll: the server mints a device secret; the main process stores it
 *     encrypted behind the OS biometric (safeStorage + Windows Hello/Touch ID).
 *   - Login: the OS biometric unlocks the secret, which we exchange at
 *     /auth/biometric/login for a session — exactly like a password login.
 */

interface ElectronBiometric {
    available: () => Promise<{ available: boolean; enrolled: boolean; platform: string }>;
    enroll: (p: { credentialId: string; deviceSecret: string }) => Promise<{ ok: boolean; error?: string }>;
    login: () => Promise<{ ok: boolean; credentialId?: string; deviceSecret?: string; error?: string }>;
    disable: () => Promise<{ ok: boolean }>;
}

function getBridge(): ElectronBiometric | null {
    const api = (window as any).electronAPI;
    if (api && api.biometric && typeof api.biometric.available === "function") {
        return api.biometric as ElectronBiometric;
    }
    return null;
}

/** True only when running under Electron with the biometric bridge present. */
export function isDesktopBiometricBridge(): boolean {
    return getBridge() !== null;
}

/** Hardware availability + whether a credential is already enrolled on this device. */
export async function desktopBiometricStatus(): Promise<{ available: boolean; enrolled: boolean; platform: string }> {
    const bridge = getBridge();
    if (!bridge) return { available: false, enrolled: false, platform: "unknown" };
    try {
        return await bridge.available();
    } catch {
        return { available: false, enrolled: false, platform: "unknown" };
    }
}

/**
 * Enable desktop biometric login: enroll a device credential on the server,
 * then hand the raw secret to the main process to store behind the OS biometric.
 * Must be called while authenticated (the enroll endpoint is auth-gated).
 * Throws on failure.
 */
export async function enableDesktopBiometric(): Promise<void> {
    const bridge = getBridge();
    if (!bridge) throw new Error("Biometric is only available in the desktop app.");

    const { data } = await biometricEnroll({ platform: "desktop", deviceLabel: desktopLabel() });
    const credentialId = (data as any)?.credentialId;
    const deviceSecret = (data as any)?.deviceSecret;
    if (!credentialId || !deviceSecret) throw new Error("Enrollment failed: malformed server response.");

    const res = await bridge.enroll({ credentialId, deviceSecret });
    if (!res.ok) {
        throw new Error(biometricErrorMessage(res.error));
    }
}

/**
 * Sign in with the desktop OS biometric. Prompts Windows Hello / Touch ID,
 * unlocks the stored secret, and exchanges it for a session. Returns the user
 * payload so the caller can `saveAuth(user)`. Throws on cancel/failure.
 */
export async function desktopBiometricLogin(): Promise<{ user: unknown }> {
    const bridge = getBridge();
    if (!bridge) throw new Error("Biometric is only available in the desktop app.");

    const unlock = await bridge.login();
    if (!unlock.ok || !unlock.credentialId || !unlock.deviceSecret) {
        throw new Error(biometricErrorMessage(unlock.error));
    }

    const { data } = await biometricLoginApi({
        credentialId: unlock.credentialId,
        deviceSecret: unlock.deviceSecret,
    });
    return data as { user: unknown };
}

/** Forget the stored credential on this device. */
export async function disableDesktopBiometric(): Promise<void> {
    const bridge = getBridge();
    if (!bridge) return;
    try {
        await bridge.disable();
    } catch {
        /* best-effort */
    }
}

/** Map a main-process error code to a user-facing message. */
function biometricErrorMessage(code?: string): string {
    switch (code) {
        case "not_enrolled":
            return "No biometric credential is set up on this device.";
        case "verification_failed":
            return "Biometric verification was cancelled or failed.";
        case "encryption_unavailable":
            return "Secure storage is not available on this device.";
        case "decrypt_failed":
            return "Your saved credential could not be read. Please set it up again.";
        case "missing_fields":
        case "persist_failed":
            return "Failed to save the biometric credential.";
        default:
            return "Biometric sign-in failed. Use your password instead.";
    }
}

/** Best-effort friendly device label from the UA. */
function desktopLabel(): string {
    const ua = navigator.userAgent || "";
    if (/Windows/.test(ua)) return "Windows desktop";
    if (/Macintosh|Mac OS X/.test(ua)) return "Mac desktop";
    if (/Linux/.test(ua)) return "Linux desktop";
    return "Desktop app";
}