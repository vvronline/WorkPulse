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
import {
  consumePendingChat,
  peekPendingChat,
  loadPersistedPendingChat,
  clearPersistedPendingChat,
} from "../src/realtime/pendingChat";

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
 *
 * CHAT-AWARE COLD START: likewise, when the app is cold-launched by TAPPING a
 * message notification, the Notifee message-tap handler persisted the target
 * conversation (the deep link it fired is lost before expo-router mounts). We
 * consume it here and redirect STRAIGHT to the 1:1/group thread instead of
 * landing on the chat LIST (the "tapping a message opens the common chat
 * window, not that person's chat" bug). Mirrors Signal-Android's
 * ConversationIntents launcher routing.
 */
export default function Index() {
  const { user, loading } = useAuth();
  const theme = useTheme();

  // Tri-state: undefined = still checking for a cold-start call; null = no
  // pending call (normal launch); route = launch straight into the call.
  const [callRoute, setCallRoute] = useState<
    PendingCallRoute | null | undefined
  >(undefined);

  // Cold-start CHAT route: when the app was launched by TAPPING a message
  // notification (killed app), notifeeService.handleMessageEvent persisted the
  // target conversation. We consume it here and redirect STRAIGHT to the 1:1/
  // group thread instead of landing on the chat LIST. null = none.
  const [chatConversationId, setChatConversationId] = useState<string | null>(
    null,
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
      let chat = peekPendingChat();

      // Bounded retry for the SecureStore-persisted route. On a LOCKED + KILLED
      // device the full-screen-intent AUTO-launches this activity the instant
      // the notification is posted; although displayIncomingCall persists the
      // route BEFORE displayNotification(), the async SecureStore write can land
      // a few milliseconds after this brand-new process starts reading.
      //
      // The SAME race also affects a cold-start MESSAGE tap: captureInitialCall-
      // Route runs from BOTH this screen and PendingCallNavigator, but Notifee's
      // getInitialNotification() yields the launching notification only ONCE. The
      // loser of that native race sees null and must instead wait for the winner
      // to finish its async setPendingChat / persistPendingChat write. Without a
      // retry the chat route was frequently missed and the app fell through to
      // the dashboard (the "tapping a message just opens the dashboard" bug).
      // Poll for EITHER a call or a chat route so both are reliably picked up.
      // A genuinely absent route returns null immediately each attempt, so a
      // normal launch only pays the cost of the first miss.
      if (!route && !chat) {
        for (let attempt = 0; attempt < 6 && !route && !chat; attempt++) {
          route = (await loadPersistedPendingCall()) ?? peekPendingCall();
          if (route || cancelled) break;
          chat = peekPendingChat() ?? (await loadPersistedPendingChat());
          if (chat || cancelled) break;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      if (cancelled) return;

      // A pending CALL always wins over a chat route. Otherwise open the exact
      // conversation the message notification pointed at (in-memory route from a
      // warm Notifee tap takes precedence over the SecureStore-persisted one).
      if (!route && chat?.conversationId) {
        consumePendingChat();
        void clearPersistedPendingChat();
        setChatConversationId(String(chat.conversationId));
      }

      if (cancelled) return;
      setCallRoute(route ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // While we are still determining whether this was a cold-start CALL launch
  // (callRoute === undefined), render a DARK, call-styled placeholder that
  // matches the call screen background (#0a0a0a) instead of a white spinner on
  // the themed background. This removes the visible "loading animation /
  // dashboard flash" before the incoming-call UI appears: the screen is already
  // black like the call UI, so the transition into /call is seamless. Once we
  // know it is NOT a call (callRoute === null) we fall through to the normal
  // redirect; the neutral spinner is only used for the plain auth-loading case.
  if (callRoute === undefined) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#0a0a0a",
        }}
      >
        <ActivityIndicator size="large" color="#ffffff" />
      </View>
    );
  }

  // Auth still resolving for a NON-call launch → neutral themed spinner.
  if (loading) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: callRoute ? "#0a0a0a" : theme.bg,
        }}
      >
        <ActivityIndicator
          size="large"
          color={callRoute ? "#ffffff" : theme.primary}
        />
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

  // Cold-start message-notification tap for an authenticated user → restore the
  // tab shell FIRST, then let the Chat tab push the exact thread. This keeps the
  // (tabs) route under `/chat/[id]`, so Android back/gesture returns to the chat
  // list instead of treating the thread as the app root and exiting.
  if (chatConversationId && user) {
    return (
      <Redirect
        href={{
          pathname: "/(tabs)/chat",
          params: { openConversationId: chatConversationId },
        }}
      />
    );
  }

  return <Redirect href={user ? "/(tabs)" : "/login"} />;
}
