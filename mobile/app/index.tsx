import { useEffect, useState } from "react";
import { Redirect } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { useAuth } from "../src/auth/AuthContext";
import { useTheme } from "../src/theme/ThemeProvider";
import {
  consumePendingCall,
  peekPendingCall,
  setPendingCall,
  loadPersistedPendingCall,
  clearPersistedPendingCall,
  type PendingCallRoute,
} from "../src/realtime/pendingCall";
import { beginCallNavigation } from "../src/realtime/callRouting";
import { notifeeService } from "../src/services/notifeeService";

/**
 * Entry route: route to tabs when authenticated, otherwise to login.
 *
 * CALL-AWARE COLD START: when the app is cold-launched by an incoming call
 * (locked device / killed app, or the user tapped "Answer" on the status-bar
 * notification), we must NOT render the dashboard first and then stack the
 * /call modal on top — that causes a very visible "dashboard → call screen"
 * flash. Instead we detect the pending/persisted call route HERE, before the
 * redirect, and send the user STRAIGHT to /call. The dashboard never mounts, so
 * there is nothing to flash. Routing for warm/alive cases is still handled by
 * IncomingCallListener (websocket) and the Notifee tap handlers.
 */
export default function Index() {
  const { user, loading } = useAuth();
  const theme = useTheme();

  // Tri-state: undefined = still checking for a cold-start call; null = no
  // pending call (normal launch); route = launch straight into the call.
  const [callRoute, setCallRoute] = useState<PendingCallRoute | null | undefined>(
    undefined,
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 1. Notifee initial notification (user TAPPED the call notification /
      //    Answer-Decline action to cold-launch). 2. SecureStore-persisted
      //    route (the only signal that survives the LOCKED+KILLED full-screen-
      //    intent auto-launch, which is not a tap so getInitialNotification()
      //    is null). The persisted route is TTL-guarded so a stale ring is
      //    ignored. The in-memory route (tap) takes precedence.
      await notifeeService.captureInitialCallRoute().catch(() => {});
      if (cancelled) return;
      let route = peekPendingCall();
      if (!route) {
        route = await loadPersistedPendingCall();
      }
      if (cancelled) return;
      setCallRoute(route ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Show a neutral spinner (NOT the dashboard) while auth resolves or while we
  // are still determining whether this was a call launch.
  if (loading || callRoute === undefined) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.bg,
        }}
      >
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  // Cold-start incoming call for an authenticated user → go straight to the
  // call screen as the ROOT route (no dashboard underneath → no flash).
  if (callRoute && user) {
    // Consume both copies so PendingCallNavigator / other paths don't re-route
    // this same call, and claim navigation to prevent a double-mount.
    consumePendingCall();
    void clearPersistedPendingCall();
    beginCallNavigation(callRoute.callId, callRoute.conversationId);
    return (
      <Redirect
        href={{
          pathname: "/call/[conversationId]",
          params: {
            conversationId: callRoute.conversationId,
            mode: "incoming",
            callType: callRoute.callType,
            callId: callRoute.callId,
            peerId: callRoute.peerId,
            peerName: callRoute.peerName,
            peerAvatar: callRoute.peerAvatar,
            autoAnswer: callRoute.autoAnswer,
            ...(callRoute.action ? { action: callRoute.action } : {}),
          },
        }}
      />
    );
  }

  // A call route arrived but the user isn't authenticated — keep it stashed so
  // PendingCallNavigator can route once login completes, then fall through.
  if (callRoute && !user) {
    setPendingCall(callRoute);
  }

  return <Redirect href={user ? "/(tabs)" : "/login"} />;
}
