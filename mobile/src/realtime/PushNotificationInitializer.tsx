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

    console.log("Push notifications ready for user:", user.id);
  }, [user?.id, initialized]);

  return null;
}
