/**
 * Holds a "pending chat route" captured when a message notification is tapped.
 *
 * WHY THIS EXISTS (mirrors pendingCall.ts):
 * When the app is KILLED and the user taps a chat-message notification, Android
 * relaunches the process cold. Any `Linking.openURL(...)` deep link fired from
 * the Notifee headless background task is lost because expo-router has not
 * mounted yet — the app simply boots its default route (the chat LIST / tabs).
 * That is the "tapping a message opens the common chat window, not the 1:1
 * thread" bug.
 *
 * To fix it, the Notifee message-tap handler records the target conversation
 * here, and `app/index.tsx` consumes it once the router + auth are ready,
 * redirecting STRAIGHT to `/chat/[id]` — opening the exact conversation.
 *
 * IN-MEMORY vs PERSISTED:
 * The in-memory `pending` variable covers warm/background-but-alive launches
 * where the JS context survives. It does NOT survive full process death (killed
 * app cold start), so we ALSO persist the route to SecureStore (works from the
 * headless task) with a timestamp + TTL so a fresh tap routes correctly on the
 * cold-started activity, while a stale/old tap is ignored.
 */

import * as SecureStore from "expo-secure-store";

export type PendingChatRoute = {
  conversationId: string;
};

let pending: PendingChatRoute | null = null;

// Listeners notified whenever a pending chat route is SET. This lets a mounted
// navigator (PendingChatNavigator) react IMMEDIATELY to a warm/background-alive
// notification tap, instead of only checking once on mount. Mirrors the way the
// call flow reacts, but via an explicit subscription so we never rely on a
// flaky `Linking.openURL` deep link for chat taps (the root cause of "tapping a
// message opens the dashboard / the common chat list instead of the thread").
type PendingChatListener = (route: PendingChatRoute) => void;
const listeners = new Set<PendingChatListener>();

/**
 * Subscribe to pending-chat SET events. Returns an unsubscribe function. The
 * listener fires every time setPendingChat is called with a route (warm taps).
 */
export function subscribePendingChat(listener: PendingChatListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Record a chat route to be navigated to once the app UI is ready. */
export function setPendingChat(route: PendingChatRoute): void {
  pending = route;
  // Notify any mounted navigator so it can route immediately (warm/background-
  // alive). Best-effort: a throwing listener must never break the caller (which
  // may be the headless Notifee task).
  for (const l of listeners) {
    try {
      l(route);
    } catch {
      /* ignore */
    }
  }
}

/** Peek at the pending chat route without clearing it. */
export function peekPendingChat(): PendingChatRoute | null {
  return pending;
}

/** Consume (read + clear) the pending chat route. */
export function consumePendingChat(): PendingChatRoute | null {
  const r = pending;
  pending = null;
  return r;
}

/** Clear any pending chat route. */
export function clearPendingChat(): void {
  pending = null;
}

// ---------------------------------------------------------------------------
// Persisted pending chat (survives full process death — see file header).
// ---------------------------------------------------------------------------

const PERSISTED_CHAT_KEY = "wp_pending_chat_route";

/**
 * Max age of a persisted chat-tap route that we will still honour on a cold
 * start. A tap older than this is treated as stale and ignored so the app never
 * force-opens a conversation long after the user actually tapped it (e.g. after
 * a reboot hours later).
 */
const PERSISTED_CHAT_TTL_MS = 60_000;

type PersistedPendingChat = PendingChatRoute & { timestamp: number };

/**
 * Persist a pending chat route to durable storage so it survives the process
 * death between the headless Notifee task (which handles the notification tap)
 * and the freshly-relaunched activity. Safe to call from the background/headless
 * task. Never throws.
 */
export async function persistPendingChat(route: PendingChatRoute): Promise<void> {
  try {
    const payload: PersistedPendingChat = { ...route, timestamp: Date.now() };
    await SecureStore.setItemAsync(PERSISTED_CHAT_KEY, JSON.stringify(payload));
  } catch {
    // Best-effort only; in-memory pending still covers warm launches.
  }
}

/**
 * Load a persisted pending chat route IF it is still fresh (within the TTL).
 * Returns null when absent, malformed, or stale. Stale/invalid entries are
 * cleared as a side effect so they never linger. Never throws.
 */
export async function loadPersistedPendingChat(): Promise<PendingChatRoute | null> {
  try {
    const raw = await SecureStore.getItemAsync(PERSISTED_CHAT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedPendingChat;
    const fresh =
      typeof parsed?.timestamp === "number" &&
      Date.now() - parsed.timestamp <= PERSISTED_CHAT_TTL_MS;
    if (!fresh || !parsed.conversationId) {
      await clearPersistedPendingChat();
      return null;
    }
    const { timestamp: _ignored, ...route } = parsed;
    return route;
  } catch {
    await clearPersistedPendingChat();
    return null;
  }
}

/** Remove any persisted pending chat route. Safe from any context; never throws. */
export async function clearPersistedPendingChat(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(PERSISTED_CHAT_KEY);
  } catch {
    // ignore
  }
}