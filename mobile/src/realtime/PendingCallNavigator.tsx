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
import { notificationLogger, NotificationState } from "../utils/notificationLogger";
import { notificationDispatcher } from "../services/notificationDispatcher";
import {
  getPendingCallAction,
  clearPendingCallAction,
} from "../../modules/call-ringer";

export default function PendingCallNavigator() {
  const router = useRouter();
  const { user, loading } = useAuth();

  // Wait briefly for the single-reader dispatcher, then load any SecureStore-
  // persisted call route as a fallback. This component must never read Notifee's
  // one-shot getInitialNotification() directly.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await notificationDispatcher.waitForRoute(600).catch(() => null);
      if (cancelled) return;
      if (peekPendingCall()) return; // in-memory route already exists
      const persisted = await loadPersistedPendingCall();
      if (cancelled || !persisted) return;
      if (peekPendingCall()) return; // re-check: tap route may have arrived
      // Merge the native Answer/Decline choice (recorded by CallActionActivity
      // when the user tapped the CallStyle notification action) into the
      // persisted route. The persisted route was written at RING time with
      // autoAnswer="0" — without this merge, routing via this fallback would
      // open the call screen in plain RINGING mode and force the user to
      // answer a SECOND time (the killed-state double-answer bug).
      let promoted = persisted;
      try {
        const nativeAction = getPendingCallAction();
        if (
          nativeAction &&
          String(nativeAction.callId) === String(persisted.callId) &&
          String(nativeAction.conversationId) ===
            String(persisted.conversationId)
        ) {
          promoted = {
            ...persisted,
            autoAnswer: nativeAction.action === "answer" ? "1" : "0",
            ...(nativeAction.action === "decline"
              ? { action: "decline" as const }
              : { action: undefined }),
          };
          clearPendingCallAction();
        }
      } catch {
        // best-effort — fall back to the unmodified persisted route
      }
      setPendingCall(promoted);
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
    if (route.dedupeKey) {
      notificationLogger.logStateTransition(route.dedupeKey, route.conversationId, NotificationState.ROUTE_CONSUMED, { source: "PendingCallNavigator" });
    }

    // Group CALL (huddle): a `meetingCode` means the callee joins the n-way
    // meeting mesh, not the 1:1 p2p call screen. Route straight to the meeting
    // room. The cross-path nav claim still guards against a double push.
    if (route.meetingCode) {
      if (!beginCallNavigation(route.callId, route.conversationId)) return;
      const code = route.meetingCode;
      // Huddle auto-join (no meeting lobby) + audio-only for a voice call.
      const ct = route.callType === "video" ? "video" : "voice";
      const t = setTimeout(() => {
        if (route.dedupeKey) {
          notificationLogger.logStateTransition(route.dedupeKey, route.conversationId, NotificationState.NAVIGATION_STARTED, { target: "meeting", source: "PendingCallNavigator" });
        }
        router.push(`/meeting/${code}?huddle=1&callType=${ct}` as never);
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
      if (route.dedupeKey) {
        notificationLogger.logStateTransition(route.dedupeKey, route.conversationId, NotificationState.NAVIGATION_STARTED, { target: "call", source: "PendingCallNavigator" });
      }
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