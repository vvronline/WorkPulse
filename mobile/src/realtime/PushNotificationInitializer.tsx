/**
 * App initialization component for push notifications.
 * Called once on app startup to set up FCM and register device token.
 * Should be placed high in the component tree, after authentication is ready.
 */

import { useEffect } from "react";
import { AppState, type AppStateStatus } from "react-native";
import {
  pushNotificationService,
  usePushNotifications,
} from "../services/pushNotificationService";
import { useAuth } from "../auth/AuthContext";
import { nativeCallService } from "../services/nativeCallService";
import { socket } from "./socket";
import { getNotificationPrefs } from "../features";
import { persistCallPrefs } from "../services/callPrefsStore";

export default function PushNotificationInitializer() {
  const { user } = useAuth();
  const { initialized } = usePushNotifications();

  useEffect(() => {
    if (!user) {
      console.log("User not authenticated — skipping push notification setup");
      return;
    }

    if (!initialized) {
      console.log("Push notifications initializing...");
      return;
    }

    pushNotificationService
      .registerDeviceTokenForCurrentUser(true)
      .catch((err) =>
        console.error("Failed to register device token after login:", err),
      );

    // Cache the call-relevant notification prefs (muteAll + selected ringtone) to
    // durable storage so the KILLED/headless incoming-call Notifee path can
    // honour them WITHOUT an authenticated API call (see callPrefsStore +
    // notifeeService, which posts on the per-tone channel matching the selected
    // ringtone). The call screen also refreshes this cache whenever it opens, but
    // priming it at login covers the very first killed-state ring before any call
    // has occurred.
    getNotificationPrefs()
      .then((r) => {
        void persistCallPrefs({
          muteAll: !!r.data?.muteAll,
          ringtone: r.data?.ringtone || "classic",
        });
      })
      .catch(() => {
        /* best-effort — defaults to not-muted so a call is never silently dropped */
      });

    const offNativeActions = nativeCallService.onAction(async ({ action, callId, conversationId }) => {
      if (action === "answer") {
        // SINGLE ACCEPT PATH: do NOT send `call_accept` here. The call screen's
        // acceptIncoming() (triggered by the autoAnswer=1 deep link that
        // nativeCallService opens) is the ONE place that accepts — it also sets
        // acceptedRef, flips status→connecting and acquires media. Sending a
        // second raw accept from here desynced the screen's state machine and
        // left the call "showing but never connecting". So this is a no-op.
        return;
      }

      if (action === "reject") {
        await socket.sendCallActionWithRetry(
          "reject",
          { callId, conversationId },
          { timeoutMs: 2000, retryEveryMs: 120 },
        );
        return;
      }

      await socket.sendCallActionWithRetry(
        "end",
        { callId, conversationId },
        { timeoutMs: 2000, retryEveryMs: 120 },
      );
    });

    // P2.11 — Push token freshness / re-registration. The FCM/APNs device token
    // can ROTATE silently (app reinstall/restore, data clear, FCM key refresh)
    // — when it does, the backend keeps pushing to a DEAD token and the device
    // stops receiving call/message pushes with no error. Re-acquire + re-register
    // the token on the two events that reliably mark "this device is live again":
    //   1. App FOREGROUND — covers a token that rotated while backgrounded/killed.
    //   2. WS RECONNECT — covers a token that rotated during a network outage;
    //      the socket reopening is our strongest signal the device is reachable.
    // refreshAndRegisterDeviceToken() only POSTs when the token actually changed,
    // so these hooks are cheap no-ops on the common unchanged path.
    void pushNotificationService.refreshAndRegisterDeviceToken();

    const onAppStateChange = (state: AppStateStatus) => {
      if (state === "active") {
        void pushNotificationService.refreshAndRegisterDeviceToken();
      }
    };
    const appStateSub = AppState.addEventListener("change", onAppStateChange);

    const offSocketOpen = socket.onOpen(() => {
      void pushNotificationService.refreshAndRegisterDeviceToken();
    });

    console.log("Push notifications ready for user:", user.id);
    return () => {
      offNativeActions?.();
      appStateSub.remove();
      offSocketOpen();
    };
  }, [user?.id, initialized]);

  return null;
}
