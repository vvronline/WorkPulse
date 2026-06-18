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
 */

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