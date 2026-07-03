/**
 * Last-known user profile cache (MMKV, synchronous).
 *
 * WHY (cold-start speed, Signal-style): the launch path used to block routing
 * behind an ASYNC SecureStore token read + a NETWORK `GET /profile` round-trip
 * before `loading` flipped false — on a slow connection the user stared at a
 * spinner for seconds. Signal renders local data instantly and syncs in the
 * background. We do the same: the profile fetched on the previous session is
 * mirrored here so AuthProvider can hydrate `user` SYNCHRONOUSLY at mount
 * (stale-while-revalidate) and refresh from the network in the background.
 *
 * SECURITY: the JWT itself stays in SecureStore — only the (non-secret)
 * profile payload is cached in MMKV. The cache is cleared on logout and on a
 * 401 (same lifecycle as the chat/query caches, so no cross-tenant leak on
 * shared devices).
 */

import { storage } from "../storage/mmkv";
import type { User } from "./AuthContext";

const PROFILE_CACHE_KEY = "wp_cached_profile_v1";

/** Synchronously read the cached profile (null when absent/corrupt). */
export function readCachedProfile(): User | null {
  try {
    const raw = storage.getString(PROFILE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as User;
    // Minimal shape check — a valid profile always has an id and username.
    if (!parsed || typeof parsed.id !== "number" || !parsed.username) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Persist the latest profile for instant hydration on the next launch. */
export function writeCachedProfile(user: User): void {
  try {
    storage.set(PROFILE_CACHE_KEY, JSON.stringify(user));
  } catch {
    // best-effort
  }
}

/** Drop the cached profile (logout / 401). */
export function clearCachedProfile(): void {
  try {
    storage.remove(PROFILE_CACHE_KEY);
  } catch {
    // best-effort
  }
}