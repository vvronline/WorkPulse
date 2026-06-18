/**
 * Holds a "pending call route" captured at app launch.
 *
 * WHY THIS EXISTS:
 * When the app is KILLED and the user taps the incoming-call notification
 * (or its "Answer" action), Android relaunches the process cold. Any
 * `Linking.openURL(...)` deep link fired from the Notifee headless background
 * task is lost because expo-router has not mounted yet — the app simply boots
 * its default route (the dashboard). The call is accepted on the server but the
 * call UI never appears.
 *
 * To fix that, the Notifee/initial-notification capture records the call route
 * here, and `app/_layout.tsx` consumes it once the router + auth are ready,
 * pushing the `/call/[conversationId]` screen with the correct params.
 *
 * IN-MEMORY vs PERSISTED:
 * The in-memory `pending` variable below covers warm/background-but-alive
 * launches where the JS context survives. It does NOT survive full process
 * death — e.g. when the device is LOCKED and the app is KILLED, the headless
 * FCM task displays the full-screen-intent notification (which auto-launches
 * MainActivity over the lock screen) in one process, then Android relaunches a
 * BRAND-NEW process for the activity. The in-memory variable is gone, so the
 * app boots to the dashboard with no way to reach the call screen. To bridge
 * that gap we ALSO persist the route to SecureStore (works from the headless
 * task) with a timestamp + TTL so a fresh ring routes to the call screen on the
 * cold-started activity, while a stale/old ring is ignored.
 */

import * as SecureStore from "expo-secure-store";

export type PendingCallRoute = {
  conversationId: string;
  callId: string;
  callType: string;
  peerId: string;
  peerName: string;
  peerAvatar: string;
  /** "1" when the user tapped Answer (auto-accept on mount). */
  autoAnswer: string;
  /** "decline" when the user tapped Decline. */
  action?: string;
};

let pending: PendingCallRoute | null = null;

/** Record a call route to be navigated to once the app UI is ready. */
export function setPendingCall(route: PendingCallRoute): void {
  pending = route;
}

/** Peek at the pending call route without clearing it. */
export function peekPendingCall(): PendingCallRoute | null {
  return pending;
}

/** Consume (read + clear) the pending call route. */
export function consumePendingCall(): PendingCallRoute | null {
  const r = pending;
  pending = null;
  return r;
}

/** Clear any pending call route. */
export function clearPendingCall(): void {
  pending = null;
}

/**
 * Build a PendingCallRoute from a raw notification data payload.
 * Returns null if the payload is not a call (missing callId/conversationId).
 */
export function pendingCallFromData(
  data: Record<string, string | undefined> | undefined | null,
): PendingCallRoute | null {
  if (!data?.callId || !data?.conversationId) return null;
  const action = data.notificationAction;
  return {
    conversationId: String(data.conversationId),
    callId: String(data.callId),
    callType: data.callType === "video" ? "video" : "voice",
    peerId: String(data.callerId || data.senderId || ""),
    peerName: data.callerName || "Incoming call",
    peerAvatar: data.callerAvatar || "",
    autoAnswer: action === "accept_call" || action === "answer" ? "1" : "0",
    action: action === "decline_call" || action === "decline" ? "decline" : undefined,
  };
}

// ---------------------------------------------------------------------------
// Persisted pending call (survives full process death — see file header).
// ---------------------------------------------------------------------------

const PERSISTED_CALL_KEY = "wp_pending_call_route";

/**
 * Max age of a persisted incoming-call route that we will still honour on a
 * cold start. A ring that is older than this is treated as stale (missed /
 * already-ended) and ignored so the app never opens the call screen for a dead
 * call after, e.g., a reboot hours later.
 */
const PERSISTED_CALL_TTL_MS = 60_000;

type PersistedPendingCall = PendingCallRoute & { timestamp: number };

/**
 * Persist a pending call route to durable storage so it survives the process
 * death between the headless FCM task (which displays the full-screen-intent
 * notification) and the freshly-relaunched activity. Safe to call from the
 * background/headless task. Never throws.
 */
export async function persistPendingCall(route: PendingCallRoute): Promise<void> {
  try {
    const payload: PersistedPendingCall = { ...route, timestamp: Date.now() };
    await SecureStore.setItemAsync(PERSISTED_CALL_KEY, JSON.stringify(payload));
  } catch {
    // Best-effort only; in-memory pending still covers warm launches.
  }
}

/**
 * Load a persisted pending call route IF it is still fresh (within the TTL).
 * Returns null when absent, malformed, or stale. Stale/invalid entries are
 * cleared as a side effect so they never linger. Never throws.
 */
export async function loadPersistedPendingCall(): Promise<PendingCallRoute | null> {
  try {
    const raw = await SecureStore.getItemAsync(PERSISTED_CALL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedPendingCall;
    const fresh =
      typeof parsed?.timestamp === "number" &&
      Date.now() - parsed.timestamp <= PERSISTED_CALL_TTL_MS;
    if (!fresh || !parsed.callId || !parsed.conversationId) {
      await clearPersistedPendingCall();
      return null;
    }
    const { timestamp: _ignored, ...route } = parsed;
    return route;
  } catch {
    await clearPersistedPendingCall();
    return null;
  }
}

/** Remove any persisted pending call route. Safe from any context; never throws. */
export async function clearPersistedPendingCall(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(PERSISTED_CALL_KEY);
  } catch {
    // ignore
  }
}
