import * as SecureStore from "expo-secure-store";

// Secure JWT storage backed by the OS keychain/keystore (expo-secure-store).
const TOKEN_KEY = "wp_auth_token";

/**
 * In-memory mirror of the persisted JWT.
 *
 * WHY: `api.ts` reads the token in its axios REQUEST INTERCEPTOR, so every
 * single HTTP call used to perform a native keychain round-trip. A screen that
 * fires six parallel queries paid six keystore reads before any bytes left the
 * device, and the WebSocket `open()` path awaited one too (which is what made
 * its stale-guard race window wide enough to leak sockets).
 *
 * The keystore remains the source of truth — this is a write-through cache
 * seeded by the first read and invalidated by setToken/clearToken. `undefined`
 * means "not yet loaded"; `null` means "loaded, and there is no token".
 */
let cachedToken: string | null | undefined = undefined;
// Dedupes concurrent cold reads so N simultaneous requests trigger ONE
// keychain hit instead of N.
let inFlightRead: Promise<string | null> | null = null;

/** Read the persisted JWT, or null if not signed in. */
export async function getToken(): Promise<string | null> {
  if (cachedToken !== undefined) return cachedToken;
  if (inFlightRead) return inFlightRead;
  inFlightRead = (async () => {
    try {
      const value = await SecureStore.getItemAsync(TOKEN_KEY);
      cachedToken = value;
      return value;
    } catch {
      // Do NOT cache a transient keystore failure as "no token" — that would
      // silently sign the user out for the rest of the session. Leave the
      // cache unset so the next call retries.
      return null;
    } finally {
      inFlightRead = null;
    }
  })();
  return inFlightRead;
}

/**
 * Synchronous best-effort read for hot paths that cannot await (and must
 * tolerate a miss). Returns null when the cache has not been warmed yet.
 */
export function getCachedToken(): string | null {
  return cachedToken ?? null;
}

/** Persist the JWT in the device's secure keystore. */
export async function setToken(token: string): Promise<void> {
  cachedToken = token;
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

/** Remove the persisted JWT (sign out). */
export async function clearToken(): Promise<void> {
  cachedToken = null;
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
