import * as SecureStore from "expo-secure-store";

const TOKEN_KEY = "wp_auth_token";

/** Read the persisted JWT, or null if not signed in. */
export async function getToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Persist the JWT in the device's secure keystore. */
export async function setToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

/** Remove the persisted JWT (sign out). */
export async function clearToken(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

/* ── Impersonation support ──
 * While a platform admin inspects a tenant, the impersonation JWT replaces
 * the main token. The original platform token is parked here so we can
 * restore it on exit (mirrors the web's `_wp_orig_token` cookie). */

const ORIG_TOKEN_KEY = "wp_orig_auth_token";

export async function getOrigToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(ORIG_TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function setOrigToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(ORIG_TOKEN_KEY, token);
}

export async function clearOrigToken(): Promise<void> {
  await SecureStore.deleteItemAsync(ORIG_TOKEN_KEY);
}
