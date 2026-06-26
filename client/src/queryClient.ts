import { QueryClient } from "@tanstack/react-query";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";

/**
 * Shared React Query client for the web/desktop client.
 *
 * Cached data is persisted to localStorage so a cold start — notably the
 * Electron desktop app relaunching from a killed state — can paint last-known
 * server data instantly (stale-while-revalidate) instead of showing a skeleton
 * while every page re-fetches from scratch.
 *
 * MULTI-TENANT SAFETY: the persisted snapshot holds tenant-scoped server data,
 * so it MUST be wiped on logout / account switch. `PERSISTED_QUERY_CACHE_KEY`
 * is added to AuthContext's tenant-scoped cache wipe, and `queryClient.clear()`
 * (which re-persists the now-empty cache) runs alongside it.
 */
export const PERSISTED_QUERY_CACHE_KEY = "workpulse-rq-cache";

const ONE_DAY = 24 * 60 * 60 * 1000;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      // Serve cached data for a minute before a background refetch, and keep it
      // around for a day so a relaunch can restore it from localStorage.
      staleTime: 60_000,
      gcTime: ONE_DAY,
      refetchOnWindowFocus: false,
    },
  },
});

export const queryPersister = createSyncStoragePersister({
  storage: typeof window !== "undefined" ? window.localStorage : undefined,
  key: PERSISTED_QUERY_CACHE_KEY,
});

export const QUERY_PERSIST_MAX_AGE = ONE_DAY;
