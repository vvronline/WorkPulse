import { useAuth } from '../store/auth';
import { storage } from '../storage/mmkv';

/**
 * Reads the auth token. In a normal (foreground) context this comes from the
 * in-memory zustand store. However, in headless/background JS contexts (e.g.
 * Notifee's `onBackgroundEvent` when replying from a notification while the app
 * is killed), the zustand store is NOT hydrated, so `useAuth.getState().token`
 * is null. To make background actions reliable we fall back to reading the
 * persisted value directly from MMKV (the same store the zustand `persist`
 * middleware writes to under the `auth-storage` key).
 *
 * This mirrors how Signal-Android reads persisted credentials in its background
 * reply path instead of relying on transient in-memory app state.
 */
export function getAuthToken(): string | null {
  const inMemory = useAuth.getState().token;
  if (inMemory) return inMemory;

  try {
    const raw = storage.getString('auth-storage');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // zustand persist shape: { state: { token, user }, version }
    const token = parsed?.state?.token ?? parsed?.token ?? null;
    return typeof token === 'string' ? token : null;
  } catch {
    return null;
  }
}

export async function fetchWithAuth(input: string, init?: RequestInit): Promise<Response> {
  const token = getAuthToken();
  const headers = new Headers(init?.headers || {});
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (!headers.has('Content-Type') && init?.body) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(input, { ...init, headers });
  return res;
}