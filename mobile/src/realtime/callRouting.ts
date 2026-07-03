/**
 * LEGACY ADAPTER over the scoped call-claims registry.
 *
 * Single-source guard for navigating to the incoming/active call screen.
 * A call can be surfaced from multiple places simultaneously (websocket
 * IncomingCallListener, push notifications, Notifee taps, cold-start
 * redirects). If two paths push the SAME call's fullScreenModal, expo-router
 * mounts it TWICE and React Native Fabric throws a fatal native crash
 * ("The specified child already has a parent") — the JS thread dies while
 * native WebRTC audio keeps flowing.
 *
 * The actual claim state now lives in `src/calls/shared/claims.ts`, which is
 * SCOPED PER SURFACE (p2p | groupRing | meeting) with owner tokens, so a
 * group-call surface can never clobber a live 1:1 call's claim (the root of
 * the "Return to call banner over a live call" / double-mount regressions).
 *
 * This module keeps the historical single-slot API for existing call-sites,
 * mapped onto the "p2p" surface slot (which is what the legacy global key
 * effectively was). New code should import from `src/calls/shared/claims`
 * and hold tokens instead.
 */

import {
  claim,
  forceRelease,
  isClaimed,
  onClaimReleased,
} from "../calls/shared/claims";

/**
 * Subscribe to local call-end events (legacy endCallNavigation fired). The
 * OngoingCallBanner uses this to clear itself immediately on hang-up — the
 * server does NOT echo `call_ended` back to the party that ended the call.
 * Returns an unsubscribe function.
 */
export function onCallNavigationEnd(listener: () => void): () => void {
  return onClaimReleased(listener);
}

/**
 * Attempt to claim navigation for a given call. Returns true if the caller
 * should proceed to navigate, or false if the call screen is already
 * showing/being shown for this call (caller must NOT navigate again).
 */
export function beginCallNavigation(
  callId: number | string | undefined | null,
  conversationId: number | string | undefined | null,
): boolean {
  return claim("p2p", callId, conversationId) != null;
}

/** True if a call screen is currently active for the given call (or any call). */
export function isCallActive(
  callId?: number | string,
  conversationId?: number | string,
): boolean {
  return isClaimed("p2p", callId, conversationId);
}

/** Clear the active-call guard (call screen unmounted / call ended). */
export function endCallNavigation(): void {
  forceRelease("p2p");
}