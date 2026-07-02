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
 * It routes a concrete conversation STRAIGHT to `/chat/[id]` (the exact 1:1/group
 * thread) rather than hopping through `/(tabs)/chat?openConversationId=…` and
 * relying on the chat tab's effect to then push the thread — that second hop was
 * unreliable on a cold/killed launch (the chat tab isn't mounted yet), landing
 * the user on the chat LIST instead of the tapped conversation. The thread's own
 * back handler (useChatThread.goBackToChatList) falls back to `/(tabs)/chat`, so
 * back/gesture still returns to the chat list instead of exiting the app. A 2+
 * unread GROUP-SUMMARY tap (no single target) still opens the chat LIST.
 */

import { useEffect } from "react";
import { useRouter } from "expo-router";
import { useAuth } from "../auth/AuthContext";
import {
  consumePendingChat,
  peekPendingChat,
  setPendingChat,
  subscribePendingChat,
  loadPersistedPendingChat,
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
          // opens the chat LIST — never the dashboard.
          if (route.openChatList || !route.conversationId) {
            router.push({ pathname: "/(tabs)/chat", params: {} });
          } else {
            // A concrete conversation → open the EXACT thread DIRECTLY instead of
            // hopping through `/(tabs)/chat?openConversationId=…` and relying on the
            // chat tab's effect to then push it. That second hop was unreliable on a
            // cold/killed launch (the chat tab isn't mounted yet), landing the user
            // on the chat LIST instead of the tapped conversation. The thread's own
            // back handler (useChatThread.goBackToChatList) falls back to
            // `/(tabs)/chat`, so back-navigation still returns to the chat list.
            router.push({
              pathname: "/chat/[id]",
              params: { id: String(route.conversationId) },
            });
          }
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

    // 3) SAFETY NET for the killed-state race: if the dashboard mounted before
    //    the pending route was staged in MEMORY (the SecureStore write / the
    //    dispatcher's getInitialNotification() read finished a beat after the
    //    root redirect), the in-memory peek above finds nothing. Rehydrate the
    //    PERSISTED route once and re-run — this guarantees a notification tap
    //    always lands in the exact conversation, regardless of app state.
    if (!loading && user && !peekPendingChat()) {
      void loadPersistedPendingChat().then((persisted) => {
        if (!persisted) return;
        if (!persisted.conversationId && !persisted.openChatList) return;
        // Only act on FRESH persisted routes (staged within the last minute)
        // so a stale, never-cleared entry can't hijack a normal app open.
        setPendingChat(persisted);
        tryConsume();
      });
    }

    return unsubscribe;
  }, [user, loading, router]);

  return null;
}