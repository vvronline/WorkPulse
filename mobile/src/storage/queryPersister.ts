import type { Persister } from "@tanstack/react-query-persist-client";
import { storage } from "./mmkv";

/**
 * Persists the React Query cache to the on-device MMKV store so a killed-state
 * relaunch can paint last-known server data instantly (stale-while-revalidate)
 * instead of showing a spinner while every screen re-fetches from scratch.
 *
 * The cache is wiped on logout / 401 via `queryClient.clear()` (see
 * AuthContext); clearing the in-memory client also re-persists the empty state,
 * so no stale tenant data survives an account switch on a shared device.
 */
const CACHE_KEY = "workpulse-rq-cache";

export const mmkvQueryPersister: Persister = {
  persistClient: (client) => {
    try {
      storage.set(CACHE_KEY, JSON.stringify(client));
    } catch {
      /* quota / serialization — best-effort, must not block the app */
    }
  },
  restoreClient: () => {
    try {
      const serialized = storage.getString(CACHE_KEY);
      return serialized ? JSON.parse(serialized) : undefined;
    } catch {
      return undefined;
    }
  },
  removeClient: () => {
    try {
      storage.remove(CACHE_KEY);
    } catch {
      /* best-effort */
    }
  },
};
