/**
 * App initialization component for push notifications.
 * Called once on app startup to set up FCM and register device token.
 * Should be placed high in the component tree, after authentication is ready.
 */

import { useEffect } from "react";
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

    // Cache the call-relevant notification prefs (muteAll) to durable storage so
    // the KILLED/headless incoming-call Notifee path can honour them WITHOUT an
    // authenticated API call (see callPrefsStore + notifeeService). The call
    // screen also refreshes this cache whenever it opens, but priming it at
    // login covers the very first killed-state ring before any call has occurred.
    getNotificationPrefs()
      .then((r) => {
        void persistCallPrefs({ muteAll: !!r.data?.muteAll });
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

    console.log("Push notifications ready for user:", user.id);
    return offNativeActions;
  }, [user?.id, initialized]);

  return null;
}
