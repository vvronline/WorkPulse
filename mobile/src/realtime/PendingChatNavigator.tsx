/**
 * Consumer of a "pending chat route" captured when a message notification is
 * tapped while the app is WARM or BACKGROUND-BUT-ALIVE (the JS context survives).
 *
 * WHY THIS EXISTS (mirrors PendingCallNavigator):
 * The KILLED/cold-start path is handled by `app/index.tsx` (it consumes the
 * persisted pending-chat route before the first redirect). But when the app is
 * already running (foreground) or merely backgrounded-but-alive, index.tsx does
 * NOT re-run, so a tap captured by `notifeeService.handleMessageEvent` (which now
 * writes the pendingChat store instead of firing a flaky `Linking.openURL` deep
 * link) needs a mounted listener to perform the navigation.
 *
 * This component:
 *   1. Subscribes to pendingChat SET events so a warm tap routes IMMEDIATELY.
 *   2. Also checks once on mount / when auth resolves (covers a route stashed
 *      just before this mounted, or one that arrived while unauthenticated).
 *
 * It routes through `/(tabs)/chat?openConversationId=…` (NOT directly to
 * `/chat/[id]`) so the tab shell stays under the thread — Android back/gesture
 * returns to the chat list instead of exiting the app — exactly mirroring the
 * cold-start redirect in app/index.tsx. The chat tab then pushes the exact
 * 1:1/group thread. This is the SINGLE, reliable mechanism for all warm states.
 */

import { useEffect } from "react";
import { useRouter } from "expo-router";
import { useAuth } from "../auth/AuthContext";
import {
  consumePendingChat,
  peekPendingChat,
  subscribePendingChat,
  clearPersistedPendingChat,
} from "./pendingChat";
import { notificationLogger, NotificationState } from "../utils/notificationLogger";

export default function PendingChatNavigator() {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    // Guard so we never double-navigate for the same pending route (the mount
    // check and the subscription could otherwise both fire).
    let navigating = false;

    const routeToChat = (route: { conversationId: string; dedupeKey?: string; openChatList?: boolean }): boolean => {
      if (navigating) {
        if (route.dedupeKey) {
          notificationLogger.info("pending_chat_navigation_deferred", {
            source: "PendingChatNavigator",
            dedupeKey: route.dedupeKey,
            conversationId: route.conversationId,
            metadata: { reason: "navigation_in_progress" },
          });
        }
        return false;
      }
      navigating = true;
      // Defer one tick so the navigation tree is fully mounted before pushing.
      setTimeout(() => {
        try {
          if (route.dedupeKey) {
            notificationLogger.logStateTransition(route.dedupeKey, route.conversationId, NotificationState.NAVIGATION_STARTED, { target: "chat", source: "PendingChatNavigator" });
          }
          // A 2+ unread GROUP-SUMMARY tap (openChatList, no single target thread)
          // opens the chat LIST — never the dashboard. A concrete conversationId
          // still opens the exact thread via `openConversationId`.
          router.push({
            pathname: "/(tabs)/chat",
            params:
              route.openChatList || !route.conversationId
                ? {}
                : { openConversationId: route.conversationId },
          });
        } finally {
          // Allow a subsequent (genuinely new) tap to navigate again.
          navigating = false;
          // If another tap arrived while navigation was in-flight, it remained
          // pending instead of being consumed. Retry once the router is free.
          setTimeout(() => {
            tryConsume();
          }, 0);
        }
      }, 0);
      return true;
    };

    const tryConsume = () => {
      // Only route when signed in; otherwise leave the route stashed so it is
      // consumed once auth resolves (the effect re-runs on `user` change).
      if (loading || !user) return;
      const route = peekPendingChat();
      // Accept a concrete conversationId OR an `openChatList` marker (2+ unread
      // summary tap — routes to the chat LIST, never the dashboard).
      if (!route || (!route.conversationId && !route.openChatList)) return;
      const normalizedRoute = { ...route, conversationId: String(route.conversationId || "") };
      if (!routeToChat(normalizedRoute)) return;
      consumePendingChat();
      void clearPersistedPendingChat();
      if (route.dedupeKey) {
        notificationLogger.logStateTransition(route.dedupeKey, String(route.conversationId), NotificationState.ROUTE_CONSUMED, { source: "PendingChatNavigator" });
      }
    };

    // 1) React immediately to a warm/background-but-alive tap.
    const unsubscribe = subscribePendingChat(() => {
      tryConsume();
    });

    // 2) Also check once now (a route may have been stashed just before mount,
    //    or this effect re-ran because auth just resolved).
    tryConsume();

    return unsubscribe;
  }, [user, loading, router]);

  return null;
}