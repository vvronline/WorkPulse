/**
 * FALLBACK consumer of a "pending call route" captured at app launch.
 *
 * PRIMARY cold-start routing now lives in `app/index.tsx`, which detects a
 * pending/persisted call BEFORE rendering and redirects STRAIGHT to /call so
 * the dashboard never flashes underneath. This component remains as a safety
 * net for cases where index.tsx did NOT route — most importantly:
 *   • the call route arrived while the user was unauthenticated (index stashes
 *     it back via setPendingCall; once login completes this routes to it), and
 *   • a route stashed by the Notifee tap handlers while the app was already
 *     past the index route.
 *
 * It is guarded by `beginCallNavigation`: if index.tsx (or any other path)
 * already claimed navigation for this call, we DO NOT push again — that avoids
 * double-mounting the /call fullScreenModal (which crashes Fabric).
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

    // Group CALL (huddle): a `meetingCode` means the callee joins the n-way
    // meeting mesh, not the 1:1 p2p call screen. Route straight to the meeting
    // room. The cross-path nav claim still guards against a double push.
    if (route.meetingCode) {
      if (!beginCallNavigation(route.callId, route.conversationId)) return;
      const code = route.meetingCode;
      const t = setTimeout(() => {
        router.push(`/meeting/${code}` as never);
      }, 0);
      return () => clearTimeout(t);
    }

    // Claim navigation so the websocket / push paths don't also push the
    // fullScreenModal for this same call (double-mount crashes Fabric). If the
    // claim FAILS, index.tsx (or another path) already routed this call as the
    // root screen — pushing again would double-mount, so bail out.
    if (!beginCallNavigation(route.callId, route.conversationId)) return;

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
          ...(route.isGroup ? { isGroup: route.isGroup } : {}),
          autoAnswer: route.autoAnswer,
          ...(route.action ? { action: route.action } : {}),
        },
      });
    }, 0);

    return () => clearTimeout(t);
  }, [user, loading, router]);

  return null;
}