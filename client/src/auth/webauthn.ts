import { startRegistration, startAuthentication } from "@simplewebauthn/browser";
import API from "../api";

/**
 * WebAuthn / passkey client wrapper (Phase 3 — web biometric login).
 *
 * Talks to the 4 server endpoints under /auth/webauthn. The browser's platform
 * authenticator (Touch ID / Windows Hello / Face ID / a security key) performs
 * the biometric match locally; no biometric data ever reaches our server.
 */

/** True when this browser supports the WebAuthn platform authenticator API. */
export function isPasskeySupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator?.credentials?.create === "function"
  );
}

/**
 * True when the browser supports *conditional mediation* (a.k.a. passkey
 * autofill): the username field can surface saved passkeys inline so the user
 * signs in without first clicking a button. We use this to auto-arm a
 * background `loginWithPasskey({ conditional: true })` on the Login page.
 */
export async function isConditionalMediationAvailable(): Promise<boolean> {
  try {
    const PKC = (window as any).PublicKeyCredential;
    if (!PKC || typeof PKC.isConditionalMediationAvailable !== "function") return false;
    return await PKC.isConditionalMediationAvailable();
  } catch {
    return false;
  }
}

/**
 * Register a passkey for the currently-authenticated user. Triggers the OS
 * "create a passkey" prompt. Throws on failure / user cancellation.
 */
export async function registerPasskey(deviceLabel?: string): Promise<void> {
  const { data } = await API.post("/auth/webauthn/register/options", {});
  const attResp = await startRegistration({ optionsJSON: data.options });
  await API.post("/auth/webauthn/register/verify", {
    response: attResp,
    deviceLabel: deviceLabel || navigatorLabel(),
  });
}

/**
 * Sign in with a passkey. Triggers the OS biometric prompt and, on success,
 * the server sets the auth cookie (same as password login). Returns the user
 * payload so the caller can `saveAuth(user)`.
 */
export async function loginWithPasskey(
  opts: { conditional?: boolean; signal?: AbortSignal } = {},
): Promise<{ user: unknown }> {
  const { data } = await API.post("/auth/webauthn/login/options", {});
  // When `conditional` is set, the browser shows passkeys via autofill UI
  // instead of a modal — used for the silent auto-offer on page load.
  const asseResp = await startAuthentication({
    optionsJSON: data.options,
    useBrowserAutofill: opts.conditional === true,
  });
  const verifyRes = await API.post("/auth/webauthn/login/verify", {
    response: asseResp,
    flowId: data.flowId,
  });
  return verifyRes.data;
}

export interface PasskeyDevice {
  id: number;
  device_label: string | null;
  transports: string | null;
  created_at: string;
  last_used_at: string | null;
}

/** List the current user's registered passkeys. */
export async function listPasskeys(): Promise<PasskeyDevice[]> {
  const { data } = await API.get("/auth/webauthn");
  return data.passkeys || [];
}

/** Revoke a passkey by its server id. */
export async function removePasskey(id: number): Promise<void> {
  await API.delete(`/auth/webauthn/${id}`);
}

/** Best-effort friendly device label derived from the UA. */
function navigatorLabel(): string {
  const ua = navigator.userAgent || "";
  if (/Windows/.test(ua)) return "Windows device";
  if (/Macintosh|Mac OS X/.test(ua)) return "Mac";
  if (/iPhone|iPad/.test(ua)) return "iOS device";
  if (/Android/.test(ua)) return "Android device";
  return "This browser";
}