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
import { consumePendingCall, peekPendingCall } from "./pendingCall";
import { beginCallNavigation } from "./callRouting";
import { notifeeService } from "../services/notifeeService";

export default function PendingCallNavigator() {
  const router = useRouter();
  const { user, loading } = useAuth();

  // Capture any cold-start initial notification ONCE on mount, before auth
  // resolves, so the route is available the moment the user is known.
  useEffect(() => {
    notifeeService.captureInitialCallRoute().catch(() => {});
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