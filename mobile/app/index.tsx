import { useEffect, useRef, useState } from "react";
import { Redirect } from "expo-router";
import { ActivityIndicator, Platform, View } from "react-native";
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
import { claim } from "../src/calls/shared/claims";
import { classifyPendingRoute } from "../src/calls/shared/classifier";
import { meetingHrefForGroupCall } from "../src/calls/group/navigation";
import {
  consumePendingChat,
  peekPendingChat,
  loadPersistedPendingChat,
  wasNotificationDisplayedRecently,
  type PendingChatRoute,
} from "../src/realtime/pendingChat";
import { notificationLogger, NotificationState } from "../src/utils/notificationLogger";
import { notificationDispatcher } from "../src/services/notificationDispatcher";
import { markAppReady } from "../src/utils/appReady";
import {
  getPendingCallAction,
  clearPendingCallAction,
} from "../modules/call-ringer";

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

  // Whether THIS component claimed call navigation for the cold-start call
  // route ("claimed"), was refused because another path already owns it
  // ("denied"), or hasn't tried yet (null). A ref (not state) so the claim is
  // attempted exactly once across re-renders.
  const callClaimRef = useRef<"claimed" | "denied" | null>(null);

  // Tri-state: undefined = still checking for a cold-start call; null = no
  // pending call (normal launch); route = launch straight into the call.
  const [callRoute, setCallRoute] = useState<
    PendingCallRoute | null | undefined
  >(undefined);

  // Cold-start CHAT route: when the app was launched by TAPPING a message
  // notification (killed app), notifeeService.handleMessageEvent persisted the
  // target conversation. We consume it here and redirect STRAIGHT to the 1:1/
  // group thread instead of landing on the chat LIST. null = none.
  const [chatRoute, setChatRoute] = useState<PendingChatRoute | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const routeDecisionStartedAt = Date.now();
      // ── KILLED-STATE ANSWER/DECLINE FAST PATH ──────────────────────────────
      // When the user taps Answer/Decline on the native CallStyle notification,
      // CallActionActivity records the choice SYNCHRONOUSLY in SharedPreferences
      // BEFORE launching the app (the deep link it fires is lost on a killed
      // cold start because expo-router isn't mounted yet). Read that native
      // store FIRST — a synchronous, race-free read that doesn't depend on the
      // async dispatcher/getInitialNotification timing — and route STRAIGHT to
      // /call with the chosen action merged into the persisted ring-time route.
      // This fixes "answering from the notification bar opens the dashboard and
      // then shows the incoming call AGAIN, forcing a second answer": the
      // dashboard never mounts and the call screen auto-accepts on mount.
      try {
        const nativeAction = getPendingCallAction();
        if (nativeAction) {
          const persisted = await loadPersistedPendingCall();
          if (cancelled) return;
          const matches =
            persisted &&
            String(persisted.callId) === String(nativeAction.callId) &&
            String(persisted.conversationId) ===
              String(nativeAction.conversationId);
          if (matches && persisted) {
            const merged: PendingCallRoute = {
              ...persisted,
              autoAnswer: nativeAction.action === "answer" ? "1" : "0",
              ...(nativeAction.action === "decline"
                ? { action: "decline" }
                : { action: undefined }),
            };
            clearPendingCallAction();
            // Stash the merged route in memory too so the unauthenticated
            // fall-through (login → PendingCallNavigator) can still route it.
            setPendingCall(merged);
            console.log(
              `[WP-COLDSTART] native call-action fast path action=${nativeAction.action} ` +
                `call=${merged.callId} conv=${merged.conversationId}`,
            );
            if (merged.dedupeKey) {
              notificationLogger.logStateTransition(
                merged.dedupeKey,
                merged.conversationId,
                NotificationState.ROUTE_CONSUMED,
                { source: "app_index_native_action_fast_path" },
              );
            }
            setCallRoute(merged);
            return;
          }
          // STALE / MISMATCHED native action: no ring-time route matches this
          // tap (the ring was for a different/older call, or its persisted
          // route was already consumed after the call died). Previously we
          // SYNTHESIZED a bare route from the native action and launched the
          // call screen anyway — with no peerId and a possibly-dead callId the
          // screen auto-accepted into thin air and hung on "Connecting…"
          // forever. Worse, when the params-carrying paths handled the action,
          // the native store was NEVER cleared (60s TTL), so a NEW call in the
          // same conversation within that window was instantly auto-answered/
          // declined. Clear it and fall through to the normal launch flow.
          clearPendingCallAction();
          console.log(
            `[WP-COLDSTART] discarded stale native call-action action=${nativeAction.action} ` +
              `call=${nativeAction.callId} conv=${nativeAction.conversationId}`,
          );
        }
      } catch {
        // best-effort — fall through to the normal dispatcher path below
      }
      // COLD-START FAST PATH (plain launcher-icon open, ANDROID ONLY):
      // The dispatcher's initialize() makes 2–3 async Notifee bridge round-trips
      // (getInitialNotification + getDisplayedNotifications) before it can even
      // conclude "this was NOT a notification launch". For the overwhelmingly
      // common case — the user tapped the app icon, there is no native call
      // action, no in-memory pending route, and NO notification was displayed
      // recently (synchronous MMKV marker) — none of that work can produce a
      // route, so we skip the entire async dispatcher path and redirect to the
      // dashboard/login immediately. This shaves the Notifee bridge latency off
      // every ordinary Android cold start.
      //
      // ANDROID-ONLY: the killed-state launch design is FCM data-push + Notifee
      // + full-screen-intent, and every Notifee display path
      // (displayIncomingCall / displayMessage / heads-up) now writes the
      // synchronous `recordNotificationDisplayed()` MMKV marker BEFORE any early
      // return — so a real notification launch always sets it and is never
      // skipped here. iOS uses CallKit / expo-notifications with a different
      // lifecycle that does NOT write this marker, so we keep the full dispatcher
      // path on iOS (it already resolves quickly for a plain launch — the retry
      // loop only engages when a candidate notification exists).
      const hasInMemoryRoute =
        Boolean(peekPendingCall()) || Boolean(peekPendingChat());
      if (
        Platform.OS === "android" &&
        !hasInMemoryRoute &&
        !wasNotificationDisplayedRecently()
      ) {
        console.log(
          `[WP-COLDSTART] fast-path plain launch (no notif marker) ` +
            `waitMs=${Date.now() - routeDecisionStartedAt}`,
        );
        setCallRoute(null);
        return;
      }
      // mobile/index.js starts this once at JS entry, but Android's back button
      // can destroy only the Activity while the JS process/singletons survive.
      // Re-invoking the dispatcher here lets the single reader capture a fresh
      // notification launch intent for that Activity relaunch case.
      await notificationDispatcher.initialize("cold_start");
      if (cancelled) return;
      // Wait for the dispatcher's one-shot getInitialNotification() read to
      // FINISH (route found OR "not a notification launch") instead of the old
      // fixed 600ms route-wait. On a killed cold start the read can easily
      // exceed 600ms — the root then gave up and redirected to the dashboard,
      // which is exactly the "tapping a message notification from the killed
      // state opens the dashboard" bug. The normal (non-notification) launch
      // resolves the moment the read completes, so this adds no delay to a
      // plain app open; 3s is a hard safety cap only.
      let dispatcherRoute =
        await notificationDispatcher.waitForInitialization(3000);
      // Second-chance read for true killed launches: the JS entry point starts
      // Notifee's initial-notification read before React mounts. On some
      // Android builds that early read can report "none" before the launch
      // intent is visible to JS. Re-check briefly from the mounted root before
      // allowing the default dashboard redirect.
      //
      // COLD-START FAST PATH: this ~300ms retry loop used to run on EVERY
      // plain launcher-icon open, delaying the dashboard for launches that
      // were never notification taps. Only retry when a notification was
      // actually displayed recently (synchronous MMKV marker) — a normal open
      // skips straight to the redirect.
      if (!dispatcherRoute && wasNotificationDisplayedRecently()) {
        for (let attempt = 0; attempt < 3 && !dispatcherRoute; attempt++) {
          await new Promise((r) => setTimeout(r, 100));
          await notificationDispatcher.initialize("cold_start");
          dispatcherRoute = notificationDispatcher.peekRoute();
        }
      }
      if (cancelled) return;

      let route = peekPendingCall();
      let chat = peekPendingChat();

      if (!route && !chat && dispatcherRoute?.type === "message") {
        chat = {
          conversationId: dispatcherRoute.conversationId,
          dedupeKey: dispatcherRoute.dedupeKey,
          messageId: dispatcherRoute.messageId,
          // A 2+ unread GROUP-SUMMARY tap has no single target thread — route to
          // the chat LIST instead of the dashboard.
          ...(dispatcherRoute.openChatList ? { openChatList: true } : {}),
        };
      }

      // CONCRETE-THREAD PREFERENCE: when the launch resolved to the fuzzy
      // "open chat list" summary route (2+ unread chats), the user may still
      // have tapped a SPECIFIC child notification — its background PRESS event
      // persists the exact conversation, but that async SecureStore write can
      // land a beat AFTER the dispatcher's read. Do a short bounded re-check
      // for a concrete pendingChat route and prefer it over the list, so a
      // child tap always opens that exact thread. A genuine summary tap (no
      // concrete route ever appears) still opens the chat list after ~600ms.
      if (chat?.openChatList) {
        for (let attempt = 0; attempt < 6; attempt++) {
          const concrete =
            peekPendingChat() ?? (await loadPersistedPendingChat());
          if (cancelled) return;
          if (concrete?.conversationId && !concrete.openChatList) {
            notificationLogger.info("cold_start_summary_upgraded_to_thread", {
              source: "app_index_cold_start",
              dedupeKey: concrete.dedupeKey,
              conversationId: String(concrete.conversationId),
              metadata: { attempt },
            });
            chat = concrete;
            break;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      }

      // Bounded retry for the SecureStore-persisted route. On a LOCKED + KILLED
      // device the full-screen-intent AUTO-launches this activity the instant
      // the notification is posted; although displayIncomingCall persists the
      // route BEFORE displayNotification(), the async SecureStore write can land
      // a few milliseconds after this brand-new process starts reading.
      if (!route && !chat && !dispatcherRoute) {
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
      // conversation the message notification pointed at — or, for a 2+ unread
      // GROUP-SUMMARY tap (openChatList, no single target), the chat LIST.
      if (!route && (chat?.conversationId || chat?.openChatList)) {
        notificationDispatcher.consumeRoute();
        consumePendingChat();
        // Do not clear the persisted copy here. The root redirect can race with
        // auth hydration or Android activity resume after a killed/back-button
        // notification launch. PendingChatNavigator clears it only after the
        // target /chat route is actually mounted, leaving a retry path alive.
        if (chat.dedupeKey) {
          notificationLogger.logStateTransition(chat.dedupeKey, String(chat.conversationId), NotificationState.ROUTE_CONSUMED, { source: "app_index_cold_start" });
        }
        setChatRoute(chat);
      }

      if (cancelled) return;
      if (route) {
        notificationDispatcher.consumeRoute();
      }
      // Always-on cold-start decision trace (survives release builds where the
      // structured notificationLogger console output is __DEV__-gated). Grep
      // `[WP-COLDSTART]` in `adb logcat` to see which screen a killed/exited
      // notification tap resolved to.
      console.log(
        `[WP-COLDSTART] route decision selected=` +
          `${route ? 'call' : chat ? (chat.openChatList ? 'chat_list' : 'chat_thread') : 'default/dashboard'} ` +
          `dispatcherType=${dispatcherRoute?.type ?? '-'} ` +
          `chatConv=${chat?.conversationId ?? '-'} ` +
          `waitMs=${Date.now() - routeDecisionStartedAt}`,
      );
      notificationLogger.info("cold_start_route_decision", {
        source: "app_index_cold_start",
        dedupeKey: route?.dedupeKey || chat?.dedupeKey || dispatcherRoute?.dedupeKey,
        conversationId: route?.conversationId || chat?.conversationId || dispatcherRoute?.conversationId,
        metadata: {
          selected: route ? "call" : chat ? "chat" : "default",
          dispatcherRouteType: dispatcherRoute?.type,
          dispatcherWaitMs: Date.now() - routeDecisionStartedAt,
          pendingCallFound: Boolean(route),
          pendingChatFound: Boolean(chat),
        },
      });
      setCallRoute(route ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // A call route arrived but the user is NOT authenticated yet — keep it
  // stashed in memory so PendingCallNavigator can route it once login
  // completes, then fall through to /login below.
  //
  // This MUST be an effect, not an inline `if (callRoute && !user)` in the
  // render body (where it used to live). Mutating module state during render
  // is impure: React 19 may discard and re-run a render, so the stash could
  // fire for a render that never commits, or fire twice. The ref keeps it
  // idempotent across the re-renders that DO commit.
  const stashedPendingRef = useRef<string | null>(null);
  useEffect(() => {
    if (!callRoute || user) return;
    const key = `${callRoute.callId}:${callRoute.conversationId}`;
    if (stashedPendingRef.current === key) return;
    stashedPendingRef.current = key;
    setPendingCall(callRoute);
  }, [callRoute, user]);

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

  // Route decision made and auth resolved → the native splash can hand off to
  // the real UI now (ready-gated hideAsync — Signal-style instant reveal).
  markAppReady();

  // Cold-start incoming call for an authenticated user → go straight to the
  // call screen as the ROOT route (no dashboard underneath → no flash).
  if (callRoute && user) {
    // Consume both copies so PendingCallNavigator / other paths don't re-route
    // this same call, and claim navigation to prevent a double-mount.
    consumePendingCall();
    void clearPersistedPendingCall();
    // SINGLE-SOURCE classification: a GROUP call route (meetingCode) must join
    // the n-way meeting mesh — NOT the 1:1 /call screen. Previously this
    // redirect sent EVERY pending route to /call, so a cold-start group call
    // launched the p2p call screen against a huddle (which then hung — the
    // caller offers via the mesh, not p2p signaling). Group routes claim the
    // dedicated "groupRing" surface so they never touch the p2p slot.
    const event = classifyPendingRoute(callRoute);
    if (event.kind === "group") {
      if (!claim("groupRing", event.callId, event.conversationId)) {
        return <Redirect href="/(tabs)" />;
      }
      return <Redirect href={meetingHrefForGroupCall(event) as never} />;
    }
    // HONOUR the claim result. If ANOTHER path (PendingCallNavigator, the
    // websocket IncomingCallListener, a Notifee tap handler) already claimed
    // navigation for this call, the /call fullScreenModal is already mounted
    // (or being mounted) — redirecting here anyway would MOUNT IT A SECOND
    // TIME, which is a fatal Fabric crash ("child already has a parent"): the
    // JS thread dies while native WebRTC audio keeps flowing. Remember when WE
    // claimed it (ref) so re-renders of this component don't self-deny.
    if (!callClaimRef.current) {
      callClaimRef.current = beginCallNavigation(
        callRoute.callId,
        callRoute.conversationId,
      )
        ? "claimed"
        : "denied";
    }
    if (callClaimRef.current === "denied") {
      return <Redirect href={user ? "/(tabs)" : "/login"} />;
    }
    if (callRoute.dedupeKey) {
      notificationLogger.logStateTransition(callRoute.dedupeKey, callRoute.conversationId, NotificationState.ROUTE_CONSUMED, { source: "app_index_cold_start" });
      notificationLogger.logStateTransition(callRoute.dedupeKey, callRoute.conversationId, NotificationState.NAVIGATION_STARTED, { target: "call", source: "app_index_cold_start" });
    }
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
            ...(callRoute.isGroup ? { isGroup: callRoute.isGroup } : {}),
            autoAnswer: callRoute.autoAnswer,
            ...(callRoute.action ? { action: callRoute.action } : {}),
          },
        }}
      />
    );
  }

  // NOTE: the "call route arrived but the user isn't authenticated" case is
  // handled by the `useEffect` above (stashPendingRef). It used to call
  // `setPendingCall(callRoute)` inline HERE, in the render body — an impure
  // render that mutates module state. Under React 19 concurrent rendering that
  // render can be discarded and re-run, so the stash could fire twice or be
  // performed for a render that is never committed. Effects are the only safe
  // place for it.

  // Cold-start message-notification tap for an authenticated user → restore the
  // tab shell FIRST, then let the Chat tab push the exact thread. This keeps the
  // (tabs) route under `/chat/[id]`, so Android back/gesture returns to the chat
  // list instead of treating the thread as the app root and exiting.
  if (chatRoute && user) {
    if (chatRoute.dedupeKey) {
      notificationLogger.logStateTransition(chatRoute.dedupeKey, String(chatRoute.conversationId), NotificationState.NAVIGATION_STARTED, { target: "chat", source: "app_index_cold_start" });
    }
    // A 2+ unread GROUP-SUMMARY tap (openChatList, no single target thread) opens
    // the chat LIST — never the dashboard.
    if (chatRoute.openChatList || !chatRoute.conversationId) {
      return <Redirect href={{ pathname: "/(tabs)/chat", params: {} }} />;
    }
    // A concrete conversation → open the EXACT 1:1/group thread DIRECTLY, exactly
    // like the incoming-call cold start redirects straight to /call. Previously
    // this went through `/(tabs)/chat?openConversationId=…` and relied on the chat
    // tab's `openConversationId` effect to THEN push the thread — a fragile second
    // hop that, on a KILLED cold start, frequently left the user on the chat LIST
    // instead of the tapped conversation ("tapping a message opens the common chat
    // window, not that person's chat"). Redirecting straight to the thread removes
    // that hop so the correct 1:1 thread always opens. The thread's own hardware
    // back handler (useChatThread.goBackToChatList) falls back to `/(tabs)/chat`,
    // so back-navigation still returns to the chat list.
    return (
      <Redirect
        href={{
          pathname: "/chat/[id]",
          params: {
            id: String(chatRoute.conversationId),
            ...(chatRoute.messageId
              ? { messageId: String(chatRoute.messageId) }
              : {}),
          },
        }}
      />
    );
  }

  return <Redirect href={user ? "/(tabs)" : "/login"} />;
}
