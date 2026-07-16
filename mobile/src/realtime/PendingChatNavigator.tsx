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
 * ROOT-CAUSE HARDENING ("tap works when minimized, but not after back-button
 * exit / from the killed state"): the previous implementation CONSUMED the
 * pending route and WIPED the persisted copy the moment it *scheduled* the
 * `router.push` — before the push actually executed. But a notification tap
 * fires the Notifee background event (and therefore `setPendingChat`) BEFORE
 * the Android activity has resumed; a `router.push` dispatched while the app
 * is not active is silently dropped by React Navigation. With the route
 * already consumed, the tap was permanently lost and the app just restored
 * whatever screen it was on (dashboard after a back-button exit; the
 * dashboard redirect after a killed cold start whose staging landed late).
 *
 * The fix follows Signal-Android's "process the intent on resume" model:
 *   1. NAVIGATE-THEN-CONSUME: the route stays staged until we VERIFY (via the
 *      live pathname) that the target thread actually mounted. Only then is it
 *      consumed + the persisted copy cleared. A dropped push leaves the route
 *      intact for a retry.
 *   2. APPSTATE RESUME RETRY: every transition to `active` re-runs the consume
 *      logic (rehydrating from SecureStore when the in-memory copy is empty),
 *      so a push that was dropped while the activity was still resuming is
 *      retried the moment the app is genuinely in the foreground.
 *   3. BOUNDED RETRIES: each staged route gets a few verification/retry
 *      cycles; a route that can never land (e.g. auth lost) is abandoned after
 *      the cap so it can't hijack a later app open (the persisted TTL also
 *      bounds this to 60s).
 *
 * It routes a concrete conversation STRAIGHT to `/chat/[id]` (the exact 1:1/group
 * thread). A 2+ unread GROUP-SUMMARY tap (no single target) opens the chat LIST.
 */

import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { useAuth } from "../auth/AuthContext";
import {
  consumePendingChat,
  peekPendingChat,
  subscribePendingChat,
  loadPersistedPendingChat,
  clearPersistedPendingChat,
  type PendingChatRoute,
} from "./pendingChat";
import { notificationLogger, NotificationState } from "../utils/notificationLogger";
import { notificationDispatcher } from "../services/notificationDispatcher";

/** How long to wait after a push before verifying the pathname landed. */
const VERIFY_DELAY_MS = 700;
/** Max push attempts per staged route before giving up. */
const MAX_ATTEMPTS = 4;

export default function PendingChatNavigator() {
  const router = useRouter();
  const pathname = usePathname();
  const { user, loading } = useAuth();

  // Live pathname readable from timers (avoids stale-closure reads during the
  // post-push verification).
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  // Attempt bookkeeping for the CURRENTLY staged route. Keyed by a stable
  // route signature so a genuinely NEW tap resets the counter.
  const attemptRef = useRef<{ key: string; count: number }>({ key: "", count: 0 });
  // Re-entrancy guard so overlapping triggers (subscription + AppState +
  // verification retry) never schedule duplicate pushes.
  const navigatingRef = useRef(false);

  useEffect(() => {
    let disposed = false;

    const routeKey = (route: PendingChatRoute): string =>
      route.openChatList && !route.conversationId
        ? "chat:list"
        : `chat:${route.conversationId}`;

    const isAtTarget = (route: PendingChatRoute): boolean => {
      const p = pathnameRef.current || "";
      if (route.openChatList || !route.conversationId) {
        // Chat list target: the tabs chat screen.
        return p === "/chat" || p.endsWith("/chat");
      }
      return p === `/chat/${route.conversationId}`;
    };

    const finalizeSuccess = (route: PendingChatRoute) => {
      consumePendingChat();
      void clearPersistedPendingChat();
      attemptRef.current = { key: "", count: 0 };
      if (route.dedupeKey) {
        notificationLogger.logStateTransition(
          route.dedupeKey,
          String(route.conversationId || ""),
          NotificationState.ROUTE_CONSUMED,
          { source: "PendingChatNavigator" },
        );
      }
    };

    const tryConsume = async (trigger: string) => {
      if (disposed || navigatingRef.current) {
        console.log(
          `[WP-WARM] PCN tryConsume(${trigger}) SKIP disposed=${disposed} ` +
            `navigating=${navigatingRef.current}`,
        );
        return;
      }
      // Only route when signed in; otherwise leave the route stashed so it is
      // consumed once auth resolves (the effect re-runs on `user` change).
      if (loading || !user) return;

      // In-memory first; rehydrate the SecureStore copy when empty. This is
      // what recovers a killed-state tap whose staging landed AFTER
      // app/index.tsx's cold-start window, and a route from a previous retry
      // cycle after the process was suspended.
      let route = peekPendingChat();
      if (!route || (!route.conversationId && !route.openChatList)) {
        const persisted = await loadPersistedPendingChat();
        if (disposed) return;
        if (!persisted || (!persisted.conversationId && !persisted.openChatList)) {
          console.log(
            `[WP-WARM] PCN tryConsume(${trigger}) no route (in-memory + persisted empty)`,
          );
          return;
        }
        route = persisted;
      }

      console.log(
        `[WP-WARM] PCN tryConsume(${trigger}) route conv=${route.conversationId || '-'} ` +
          `openChatList=${route.openChatList ? '1' : '0'} appState=${AppState.currentState} ` +
          `pathname=${pathnameRef.current} atTarget=${isAtTarget(route)}`,
      );

      // Already showing the target (e.g. the cold-start redirect in
      // app/index.tsx landed it, or a previous retry succeeded while this
      // trigger was queued) → just consume, no push.
      if (isAtTarget(route)) {
        finalizeSuccess(route);
        return;
      }

      // Attempt bookkeeping — reset for a new route, cap retries for the same.
      const key = routeKey(route);
      if (attemptRef.current.key !== key) {
        attemptRef.current = { key, count: 0 };
      }
      if (attemptRef.current.count >= MAX_ATTEMPTS) {
        notificationLogger.warn("pending_chat_navigation_abandoned", {
          source: "PendingChatNavigator",
          dedupeKey: route.dedupeKey,
          conversationId: String(route.conversationId || ""),
          metadata: { attempts: attemptRef.current.count, trigger },
        });
        // Give up: consume so a dead route can't hijack a later app open.
        consumePendingChat();
        void clearPersistedPendingChat();
        attemptRef.current = { key: "", count: 0 };
        return;
      }
      attemptRef.current.count += 1;

      // A push dispatched while the app is NOT active is silently dropped by
      // React Navigation (the exact failure after a back-button exit, where
      // the tap event fires before the activity resumes). Don't burn the
      // attempt — leave the route staged; the AppState `active` listener
      // below re-triggers the moment the app is genuinely resumed.
      if (AppState.currentState !== "active") {
        attemptRef.current.count -= 1;
        console.log(
          `[WP-WARM] PCN DEFER (app not active) trigger=${trigger} ` +
            `appState=${AppState.currentState} conv=${route.conversationId || '-'}`,
        );
        notificationLogger.info("pending_chat_navigation_deferred", {
          source: "PendingChatNavigator",
          dedupeKey: route.dedupeKey,
          conversationId: String(route.conversationId || ""),
          metadata: { reason: "app_not_active", appState: AppState.currentState, trigger },
        });
        return;
      }

      navigatingRef.current = true;
      const targetRoute = route;
      if (targetRoute.dedupeKey) {
        notificationLogger.logStateTransition(
          targetRoute.dedupeKey,
          String(targetRoute.conversationId || ""),
          NotificationState.NAVIGATION_STARTED,
          { target: "chat", source: "PendingChatNavigator", attempt: attemptRef.current.count, trigger },
        );
      }

      // Defer one tick so the navigation tree is fully mounted before pushing.
      setTimeout(() => {
        try {
          console.log(
            `[WP-WARM] PCN PUSH → ${targetRoute.openChatList || !targetRoute.conversationId ? '/(tabs)/chat' : '/chat/' + targetRoute.conversationId} ` +
              `attempt=${attemptRef.current.count} trigger=${trigger}`,
          );
          if (targetRoute.openChatList || !targetRoute.conversationId) {
            // 2+ unread GROUP-SUMMARY tap (no single target) → the chat LIST.
            router.push({ pathname: "/(tabs)/chat", params: {} });
          } else {
            // Concrete conversation → open the EXACT thread DIRECTLY. The
            // thread's back handler (useChatThread.goBackToChatList) falls
            // back to `/(tabs)/chat`, so back still returns to the chat list.
            router.push({
              pathname: "/chat/[id]",
              params: {
                id: String(targetRoute.conversationId),
                ...(targetRoute.messageId
                  ? { messageId: String(targetRoute.messageId) }
                  : {}),
              },
            });
          }
        } catch (err) {
          notificationLogger.warn("pending_chat_navigation_push_threw", {
            source: "PendingChatNavigator",
            dedupeKey: targetRoute.dedupeKey,
            conversationId: String(targetRoute.conversationId || ""),
            metadata: { error: err instanceof Error ? err.message : String(err) },
          });
        }

        // NAVIGATE-THEN-CONSUME: verify the push actually LANDED before
        // consuming. React Navigation can silently drop a push dispatched
        // while the activity was still resuming — in that case the route
        // stays staged and the next trigger (AppState active / this retry)
        // tries again.
        setTimeout(() => {
          navigatingRef.current = false;
          if (disposed) return;
          if (isAtTarget(targetRoute)) {
            console.log(
              `[WP-WARM] PCN LANDED conv=${targetRoute.conversationId || '-'} ` +
                `pathname=${pathnameRef.current}`,
            );
            finalizeSuccess(targetRoute);
          } else {
            console.log(
              `[WP-WARM] PCN NOT-LANDED conv=${targetRoute.conversationId || '-'} ` +
                `attempt=${attemptRef.current.count} pathname=${pathnameRef.current} → retry`,
            );
            notificationLogger.warn("pending_chat_navigation_not_landed", {
              source: "PendingChatNavigator",
              dedupeKey: targetRoute.dedupeKey,
              conversationId: String(targetRoute.conversationId || ""),
              metadata: {
                attempt: attemptRef.current.count,
                pathname: pathnameRef.current,
              },
            });
            // Retry (bounded by MAX_ATTEMPTS in tryConsume).
            void tryConsume("verify_retry");
          }
        }, VERIFY_DELAY_MS);
      }, 0);
    };

    // 1) React immediately to a warm/background-but-alive tap.
    const unsubscribe = subscribePendingChat(() => {
      void tryConsume("subscription");
    });

    // 2) SIGNAL-PARITY RESUME HOOK: retry whenever the app becomes ACTIVE.
    //    This recovers the "back-button exit" tap (event fired before the
    //    activity resumed → push dropped) and any killed-state staging that
    //    landed after the cold-start window.
    //
    //    WARM singleTask TAP (root-cause fix): when the process is alive and
    //    backgrounded, a notification tap is delivered to the existing Activity
    //    via onNewIntent (no PRESS event, no cold-start re-mount). The
    //    withAndroidNewIntent plugin makes onNewIntent call setIntent(intent),
    //    and recheckOnForeground re-reads notifee.getInitialNotification() here
    //    to stage the tapped conversation before we route.
    const appStateSub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void (async () => {
          await notificationDispatcher.recheckOnForeground();
          if (disposed) return;
          await tryConsume("app_active");
        })();
      }
    });

    // 3) Also check once now (a route may have been stashed just before mount,
    //    or this effect re-ran because auth just resolved). tryConsume itself
    //    rehydrates the persisted copy when the in-memory one is empty, so the
    //    old separate one-shot SecureStore check is folded in.
    void tryConsume("mount");

    return () => {
      disposed = true;
      unsubscribe();
      appStateSub.remove();
    };
  }, [user, loading, router]);

  return null;
}