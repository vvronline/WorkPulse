import { createMMKV } from "react-native-mmkv";

/**
 * Shared MMKV instance for fast, synchronous on-device persistence.
 *
 * MMKV is a memory-mapped key/value store (orders of magnitude faster than
 * AsyncStorage) used here for two things:
 *   1. The chat message + conversation-list cache (so chats open INSTANTLY from
 *      disk while the network sync happens in the background — Signal's model).
 *   2. Backing the React Query persister (see src/storage/queryPersister.ts).
 *
 * Reads/writes are synchronous, so cached chat data is available on the very
 * first render with no spinner.
 *
 * NOTE: react-native-mmkv v3 (Nitro) exposes a `createMMKV(config)` factory
 * rather than the old `new MMKV(config)` constructor, and the delete method is
 * named `remove` (not `delete`).
 */
export const storage = createMMKV({ id: "workpulse-cache" });

/** Typed JSON helpers over the raw string store. */
export const mmkvJson = {
  get<T>(key: string): T | null {
    const raw = storage.getString(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  },
  set(key: string, value: unknown): void {
    try {
      storage.set(key, JSON.stringify(value));
    } catch {
      /* ignore quota / serialization errors — cache is best-effort */
    }
  },
  remove(key: string): void {
    storage.remove(key);
  },
};