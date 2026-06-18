/**
 * Consumes a "pending call route" captured at app launch and navigates to the
 * call screen once the router + auth are ready.
 *
 * WHY: When the app is launched COLD by a notification tap / Answer action
 * (app cleared from background, possibly over the lock screen), the headless
 * `Linking.openURL(...)` deep link is lost before expo-router mounts, so the
 * app boots its default route (the dashboard) and the call never appears.
 *
 * `notifeeService.captureInitialCallRoute()` (called at startup) and the
 * Notifee answer/decline handlers stash a `PendingCallRoute`. This component
 * waits for `user` to be loaded, then pushes `/call/[conversationId]` with the
 * correct params (including autoAnswer / decline action). Navigation is guarded
 * via `beginCallNavigation` so it never double-mounts the fullScreenModal.
 */

import { useEffect } from "react";
import { useRouter } from "expo-router";
import { useAuth } from "../auth/AuthContext";
import {
  consumePendingCall,
  peekPendingCall,
  setPendingCall,
  loadPersistedPendingCall,
  clearPersistedPendingCall,
} from "./pendingCall";
import { beginCallNavigation } from "./callRouting";
import { notifeeService } from "../services/notifeeService";

export default function PendingCallNavigator() {
  const router = useRouter();
  const { user, loading } = useAuth();

  // Capture any cold-start routing source ONCE on mount, before auth resolves,
  // so a pending call route is available the moment the user is known:
  //   1. Notifee's initial notification — set when the user TAPPED the call
  //      notification / its Answer-Decline action to cold-launch the app.
  //   2. The SecureStore-persisted route — the ONLY signal that survives the
  //      LOCKED + KILLED case, where the full-screen-intent AUTO-launches the
  //      activity (no tap → getInitialNotification() is null). Only honoured if
  //      still fresh (TTL-guarded in loadPersistedPendingCall) so a stale ring
  //      never reopens a dead call screen. The in-memory route (set by the
  //      Notifee tap handlers) takes precedence when present.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await notifeeService.captureInitialCallRoute().catch(() => {});
      if (cancelled) return;
      if (peekPendingCall()) return; // a tap-sourced route already exists
      const persisted = await loadPersistedPendingCall();
      if (cancelled || !persisted) return;
      if (peekPendingCall()) return; // re-check: tap route may have arrived
      setPendingCall(persisted);
      // Consume the durable copy now that it's promoted to the in-memory route;
      // the navigation effect below will pick it up and route to the call.
      await clearPersistedPendingCall();
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (loading) return;
    if (!user) return; // not signed in → nothing to route to
    if (!peekPendingCall()) return;

    const route = consumePendingCall();
    if (!route) return;

    // Claim navigation so the websocket / push paths don't also push the
    // fullScreenModal for this same call (double-mount crashes Fabric).
    beginCallNavigation(route.callId, route.conversationId);

    // Defer one tick so the navigation tree is fully mounted before pushing.
    const t = setTimeout(() => {
      router.push({
        pathname: "/call/[conversationId]",
        params: {
          conversationId: route.conversationId,
          mode: "incoming",
          callType: route.callType,
          callId: route.callId,
          peerId: route.peerId,
          peerName: route.peerName,
          peerAvatar: route.peerAvatar,
          autoAnswer: route.autoAnswer,
          ...(route.action ? { action: route.action } : {}),
        },
      });
    }, 0);

    return () => clearTimeout(t);
  }, [user, loading, router]);

  return null;
}