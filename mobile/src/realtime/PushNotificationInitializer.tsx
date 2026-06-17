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

    const offNativeActions = nativeCallService.onAction(async ({ action, callId, conversationId }) => {
      if (action === "answer") {
        await socket.sendCallActionWithRetry(
          "accept",
          { callId, conversationId },
          { timeoutMs: 4000, retryEveryMs: 150 },
        );
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
